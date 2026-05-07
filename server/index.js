// Preparing You — backend service
// Endpoints:
//   GET  /health     — liveness check
//   POST /paul/chat  — RAG-backed chat with Paul (Anthropic + pgvector via Supabase)
//   POST /signoff    — TODO: PCM signs off; mint TLN handoff JWT

const fs = require('fs')
const envPath = fs.existsSync('/etc/secrets/.env') ? '/etc/secrets/.env' : '.env'
require('dotenv').config({ path: envPath })

const http = require('http')
const Anthropic = require('@anthropic-ai/sdk')
const { createClient } = require('@supabase/supabase-js')

const PORT = parseInt(process.env.PORT || '10000', 10)
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
})

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}
function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(obj))
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', c => { body += c; if (body.length > 1e6) { req.destroy(); reject(new Error('payload too large')) } })
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}

// ─── Embeddings via OpenAI ──────────────────────────────────────────────
async function embedQuery(text) {
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text })
  })
  if (!r.ok) throw new Error(`embedding failed: ${r.status} ${await r.text()}`)
  const j = await r.json()
  return j.data[0].embedding
}

// ─── Retrieve top-k chunks via pgvector RPC ─────────────────────────────
// Requires the SQL function `match_book_chunks` to exist (created in migration).
async function retrieveChunks(queryEmbedding, k = 6) {
  const { data, error } = await sb.rpc('match_book_chunks', {
    query_embedding: queryEmbedding,
    match_count: k
  })
  if (error) throw new Error(`retrieval failed: ${error.message}`)
  return data || []
}

const PAUL_SYSTEM = `You are Paul, a guide for someone preparing to enter "The Living Network."

Tone: earnest, reverent, plain-spoken. You are speaking to someone discerning a covenant decision — not a casual chatbot user. Speak as a wise elder might, in the first person where it fits naturally.

Rules:
- Use the source excerpts provided below as your knowledge. Speak from them as your own understanding — do not say things like "drawn from the books," "according to the source," "the excerpt says," or name book titles. Just answer.
- If the excerpts don't cover the question, say plainly that you cannot speak to that here. Do not invent.
- Keep answers focused. 2–4 short paragraphs is usually right.
- Do not begin with "Peace to you" or other greetings — a greeting is offered by the interface.`

async function paulChat(userId, messages) {
  // The last user message is what we retrieve against.
  const lastUser = [...messages].reverse().find(m => m.role === 'user')
  if (!lastUser) throw new Error('no user message')

  const qEmb = await embedQuery(lastUser.content)
  const chunks = await retrieveChunks(qEmb, 6)

  // Look up book titles for citation
  const bookIds = [...new Set(chunks.map(c => c.book_id))]
  const { data: books } = await sb.from('prep_books').select('id, title').in('id', bookIds)
  const bookTitle = id => (books || []).find(b => b.id === id)?.title || 'Unknown'

  const context = chunks.map((c, i) =>
    `--- excerpt ${i + 1} from "${bookTitle(c.book_id)}" ---\n${c.chunk_text}`
  ).join('\n\n')

  const sys = PAUL_SYSTEM + '\n\nSource excerpts retrieved for this question:\n\n' + context

  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 1024,
    system: sys,
    messages: messages.map(m => ({ role: m.role, content: m.content }))
  })

  const answer = resp.content.map(b => b.text || '').join('').trim()

  // Persist both turns
  if (userId) {
    await sb.from('prep_paul_chats').insert([
      { user_id: userId, role: 'user',      message: lastUser.content },
      { user_id: userId, role: 'assistant', message: answer },
    ])
  }

  return {
    answer,
    citations: chunks.map(c => ({ book: bookTitle(c.book_id), preview: c.chunk_text.slice(0, 140) }))
  }
}

// ─── Email via Resend ───────────────────────────────────────────────────
const RESEND_FROM = process.env.RESEND_FROM || 'Preparing You <onboarding@resend.dev>'
async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY) { console.warn('[email] no RESEND_API_KEY'); return { ok:false, reason:'no-key' } }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from: RESEND_FROM, to, subject, html })
    })
    const text = await r.text()
    if (!r.ok) {
      console.error('[email] FAILED', r.status, '→', to, '|', text)
      return { ok:false, status:r.status, body:text }
    }
    console.log('[email] sent →', to, '|', text.slice(0, 200))
    return { ok:true, body:text }
  } catch (e) {
    console.error('[email] threw', e)
    return { ok:false, error: String(e) }
  }
}

function emailWrap(title, body, ctaText, ctaUrl) {
  return `<!doctype html><html><body style="margin:0;background:#faf6e9;font-family:Georgia,serif;color:#3a2818">
    <div style="max-width:520px;margin:0 auto;padding:32px 24px">
      <h1 style="font-family:Georgia,serif;color:#1f4a4f;font-size:22px;margin:0 0 16px">${title}</h1>
      <div style="background:#fefcf4;border:1px solid #e8dec3;border-radius:10px;padding:24px;font-size:16px;line-height:1.6">
        ${body}
        ${ctaText ? `<div style="margin-top:20px"><a href="${ctaUrl}" style="display:inline-block;background:#c4673a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">${ctaText}</a></div>` : ''}
      </div>
      <p style="font-size:12px;color:#6f5641;font-style:italic;margin-top:18px;text-align:center">Preparing You — a gateway into The Living Network</p>
    </div></body></html>`
}

// ─── Daily.co room helpers ──────────────────────────────────────────────
async function dailyEnsureRoom(roomName, opts = {}) {
  if (!process.env.DAILY_API_KEY) throw new Error('DAILY_API_KEY missing')
  const headers = { 'Authorization': `Bearer ${process.env.DAILY_API_KEY}`, 'Content-Type': 'application/json' }
  // Try get
  const got = await fetch(`https://api.daily.co/v1/rooms/${roomName}`, { headers })
  if (got.ok) return await got.json()
  // Create
  const cr = await fetch('https://api.daily.co/v1/rooms', {
    method: 'POST', headers,
    body: JSON.stringify({
      name: roomName,
      privacy: 'public',
      properties: { enable_chat: true, enable_screenshare: true, ...(opts.properties || {}) }
    })
  })
  if (!cr.ok) throw new Error(`daily room create failed: ${cr.status} ${await cr.text()}`)
  return await cr.json()
}

async function dailyMintToken(roomName, { userName, isOwner }) {
  const r = await fetch('https://api.daily.co/v1/meeting-tokens', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.DAILY_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ properties: { room_name: roomName, user_name: userName || 'Guest', is_owner: !!isOwner, exp: Math.floor(Date.now()/1000) + 3*3600 } })
  })
  if (!r.ok) throw new Error(`daily token mint failed: ${r.status} ${await r.text()}`)
  return (await r.json()).token
}

// ─── TLN invitation ─────────────────────────────────────────────────────
const TLN_URL = process.env.TLN_URL || 'https://livingnetwork.netlify.app'

async function inviteToTln(userId, reasonHtml, skipEmail) {
  if (!userId) return { ok: false, reason: 'no userId' }
  const { data: u } = await sb.from('prep_users').select('name, email, tln_invited_at').eq('id', userId).maybeSingle()
  if (!u?.email) return { ok: false, reason: 'no email' }
  if (u.tln_invited_at) return { ok: false, reason: 'already invited', at: u.tln_invited_at }

  if (!skipEmail) {
    await sendEmail(u.email, 'You have been invited to The Living Network',
      emailWrap('Welcome to The Living Network',
        (reasonHtml || `<p>${u.name || 'Friend'},</p><p>Your preparation has been recognised.</p>`) +
        `<p>You may now create your account in The Living Network. Use the same email so your records align.</p>`,
        'Open The Living Network', TLN_URL))
  }

  await sb.from('prep_users').update({ tln_invited_at: new Date().toISOString() }).eq('id', userId)
  await notify(userId, '✝', 'You have been invited to The Living Network. Check your email.', { type:'page', page:'join-tln' })
  return { ok: true }
}

// ─── Notification helper ────────────────────────────────────────────────
async function notify(userId, icon, text, action) {
  if (!userId) return
  const { error } = await sb.from('prep_notifications').insert({ user_id: userId, icon, text, action: action || null })
  if (error) console.warn('[notify] insert failed', error)
}

// ─── PCM election ───────────────────────────────────────────────────────
async function electPcm({ electorId, pcmId, skipEmail }) {
  if (!electorId || !pcmId) throw new Error('electorId and pcmId required')
  if (electorId === pcmId) throw new Error('cannot elect self')

  // Insert election (unique partial idx ensures only one active per elector)
  const { data: row, error } = await sb.from('prep_pcm_elections')
    .insert({ elector_id: electorId, pcm_id: pcmId, status: 'pending' })
    .select().single()
  if (error) throw new Error(error.message)

  // Look up names + email of PCM, name+email of elector
  const { data: pcm } = await sb.from('prep_users').select('name, email').eq('id', pcmId).single()
  const { data: elector } = await sb.from('prep_users').select('name, email').eq('id', electorId).single()
  if (!skipEmail && pcm?.email) {
    await sendEmail(pcm.email, 'You have been elected as a Personal Contact Minister',
      emailWrap('A new election',
        `<p>${elector?.name || 'A user'} has elected you as their Personal Contact Minister.</p>
         <p>Open the app to accept or decline. If you accept, you will be paired with them in messages and able to walk alongside their preparation.</p>`,
        'Open Preparing You', 'https://preparingyou.netlify.app'))
  }
  if (!skipEmail && elector?.email) {
    await sendEmail(elector.email, 'Your election has been sent',
      emailWrap('Election sent',
        `<p>You have elected <strong>${pcm?.name || 'a Personal Contact Minister'}</strong>.</p>
         <p>They have been emailed and will respond shortly. We will email you again once they accept or decline.</p>`,
        'Open Preparing You', 'https://preparingyou.netlify.app'))
  }
  await notify(pcmId, '⛪', `${elector?.name || 'A user'} has elected you as their PCM.`, { type:'page', page:'pcm' })
  await notify(electorId, '⏳', `Your election to ${pcm?.name || 'a PCM'} has been sent.`, { type:'page', page:'pcm' })
  return row
}

async function respondPcm({ electionId, pcmId, accept, skipEmail }) {
  const { data: el, error: e1 } = await sb.from('prep_pcm_elections')
    .select('*').eq('id', electionId).maybeSingle()
  if (e1 || !el) throw new Error('election not found')
  if (el.pcm_id !== pcmId) throw new Error('not your election')
  if (el.status !== 'pending') throw new Error('already responded')

  const newStatus = accept ? 'accepted' : 'declined'
  await sb.from('prep_pcm_elections').update({ status: newStatus, responded_at: new Date().toISOString() }).eq('id', electionId)

  if (accept) {
    await sb.from('prep_users').update({ pcm_id: pcmId }).eq('id', el.elector_id)
  }

  const { data: elector } = await sb.from('prep_users').select('name, email').eq('id', el.elector_id).single()
  const { data: pcm } = await sb.from('prep_users').select('name').eq('id', pcmId).single()
  if (!skipEmail && elector?.email) {
    if (accept) {
      await sendEmail(elector.email, 'Your PCM accepted your election',
        emailWrap('Accepted',
          `<p>${pcm?.name || 'Your PCM'} has accepted your election. They will walk this preparation alongside you.</p><p>You can now message them or schedule a call from inside the app.</p>`,
          'Open Preparing You', 'https://preparingyou.netlify.app'))
    } else {
      await sendEmail(elector.email, 'Your PCM is currently unavailable',
        emailWrap('Currently unavailable',
          `<p>${pcm?.name || 'Your PCM'} is unavailable at this time. Please choose another Personal Contact Minister from the list.</p>`,
          'Choose another', 'https://preparingyou.netlify.app'))
    }
  }
  if (accept) await notify(el.elector_id, '✓', `${pcm?.name || 'Your PCM'} accepted your election.`, { type:'page', page:'messages' })
  else        await notify(el.elector_id, '⚠', `${pcm?.name || 'Your PCM'} is currently unavailable. Choose another.`, { type:'page', page:'pcm' })

  // Auto-invite the PCM to TLN on their first accepted election (the
  // act of being chosen by another is the qualifying event).
  let pcmAutoInvited = false
  let pcmEmail = null
  let pcmName = pcm?.name
  if (accept) {
    const { count } = await sb.from('prep_pcm_elections')
      .select('id', { count:'exact', head:true })
      .eq('pcm_id', pcmId).eq('status', 'accepted')
    if (count === 1) {
      // Skip the server email (client will send via EmailJS); inviteToTln
      // still records tln_invited_at + drops a notification.
      const result = await inviteToTln(pcmId,
        `<p>${pcm?.name || 'Friend'},</p>
         <p>You have been chosen by ${elector?.name || 'someone'} as their Personal Contact Minister. The act of being elected is itself the qualifying event — you are now invited to enter The Living Network.</p>`,
        skipEmail)
      if (result.ok) {
        pcmAutoInvited = true
        const { data: pcmFull } = await sb.from('prep_users').select('name, email').eq('id', pcmId).single()
        pcmEmail = pcmFull?.email
        pcmName = pcmFull?.name
      }
    }
  }
  return { status: newStatus, pcmAutoInvited, pcmEmail, pcmName, electorName: elector?.name }
}

const server = http.createServer(async (req, res) => {
  cors(res)
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  try {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true, service: 'preparing-you', version: '0.9.0' })
    }

    if (req.method === 'POST' && req.url === '/paul/chat') {
      const body = await readJson(req)
      const { userId, messages } = body
      if (!Array.isArray(messages) || !messages.length) return send(res, 400, { error: 'messages required' })
      return send(res, 200, await paulChat(userId, messages))
    }

    if (req.method === 'POST' && req.url === '/elect') {
      const { electorId, pcmId, skipEmail } = await readJson(req)
      const row = await electPcm({ electorId, pcmId, skipEmail })
      return send(res, 200, { election: row })
    }

    if (req.method === 'POST' && req.url === '/election/respond') {
      const { electionId, pcmId, accept, skipEmail } = await readJson(req)
      return send(res, 200, await respondPcm({ electionId, pcmId, accept, skipEmail }))
    }

    if (req.method === 'POST' && req.url === '/call/start') {
      const { roomName, userName, isOwner } = await readJson(req)
      if (!roomName) return send(res, 400, { error: 'roomName required' })
      const room = await dailyEnsureRoom(roomName)
      const token = await dailyMintToken(roomName, { userName, isOwner })
      return send(res, 200, { url: `${room.url}?t=${token}`, roomUrl: room.url, token })
    }

    if (req.method === 'POST' && req.url === '/tln/invite') {
      const { userId, fromName, skipEmail } = await readJson(req)
      if (!userId) return send(res, 400, { error: 'userId required' })
      const reason = fromName
        ? `<p>${fromName} has signed off on your readiness and invites you to enter The Living Network.</p>`
        : `<p>You have been invited to enter The Living Network.</p>`
      const result = await inviteToTln(userId, reason, skipEmail)
      return send(res, 200, result)
    }

    if (req.method === 'POST' && req.url === '/welcome') {
      const { userId, skipEmail } = await readJson(req)
      if (!userId) return send(res, 400, { error: 'userId required' })
      const { data: u } = await sb.from('prep_users').select('name, email').eq('id', userId).maybeSingle()
      if (!skipEmail && u?.email) {
        await sendEmail(u.email, 'Welcome to Preparing You',
          emailWrap('Welcome',
            `<p>Peace to you, ${u.name || 'friend'}.</p>
             <p>You have begun the work of preparation. Three short videos and five short books wait inside, along with Paul — an AI guide drawn from those books — and a community of Personal Contact Ministers ready to walk this with you.</p>
             <p>Begin where you are.</p>`,
            'Open Preparing You', 'https://preparingyou.netlify.app'))
      }
      await notify(userId, '✝', 'Welcome. Begin with the introduction videos.', { type:'page', page:'video' })
      return send(res, 200, { ok: true })
    }

    if (req.method === 'POST' && req.url === '/peers') {
      const { userId } = await readJson(req)
      if (!userId) return send(res, 400, { error: 'userId required' })
      // 1) my PCM (if I'm an elector)
      // 2) electors who have me as their PCM
      const peers = []
      const { data: me } = await sb.from('prep_users').select('pcm_id').eq('id', userId).maybeSingle()
      if (me?.pcm_id) {
        const { data: pcm } = await sb.from('prep_users').select('id, name, region').eq('id', me.pcm_id).maybeSingle()
        if (pcm) peers.push({ ...pcm, role: 'Your Personal Contact Minister' })
      }
      const { data: mine } = await sb.from('prep_users').select('id, name, region').eq('pcm_id', userId)
      for (const e of (mine || [])) {
        if (!peers.find(p => p.id === e.id)) peers.push({ ...e, role: 'You are their PCM' })
      }
      return send(res, 200, { peers })
    }

    // Pick the most relevant townhall: prefer the one currently live, else
    // the next upcoming, else the most recent past.
    async function pickTownhall() {
      const { data: live } = await sb.from('prep_townhalls').select('*')
        .not('live_at', 'is', null).is('ended_at', null).order('live_at', { ascending: false }).limit(1).maybeSingle()
      if (live) return live
      const nowIso = new Date().toISOString()
      const { data: upcoming } = await sb.from('prep_townhalls').select('*')
        .gte('scheduled_at', nowIso).order('scheduled_at', { ascending: true }).limit(1).maybeSingle()
      if (upcoming) return upcoming
      const { data: past } = await sb.from('prep_townhalls').select('*')
        .order('scheduled_at', { ascending: false }).limit(1).maybeSingle()
      return past
    }

    async function isHost(userId) {
      if (!userId) return false
      const { data } = await sb.from('prep_townhall_hosts').select('user_id').eq('user_id', userId).maybeSingle()
      return !!data
    }

    if (req.method === 'POST' && req.url === '/admin/delete-user') {
      // Verify the caller is an admin, then delete from auth.users (cascades
      // to prep_users + every other prep_* via FK ON DELETE CASCADE).
      const auth = req.headers['authorization'] || ''
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
      if (!token) return send(res, 401, { error: 'no_token' })
      const callerSb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        global: { headers: { Authorization: 'Bearer ' + token } },
        auth: { persistSession: false }
      })
      const { data: u } = await callerSb.auth.getUser(token)
      const callerId = u?.user?.id
      if (!callerId) return send(res, 401, { error: 'invalid_token' })
      const { data: adminRow } = await sb.from('prep_admins').select('user_id').eq('user_id', callerId).maybeSingle()
      if (!adminRow) return send(res, 403, { error: 'not_admin' })

      const { userId } = await readJson(req)
      if (!userId) return send(res, 400, { error: 'userId required' })
      // Delete from auth.users — FK cascade will clean up prep_users etc.
      const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
        method: 'DELETE',
        headers: { 'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY }
      })
      if (!r.ok) return send(res, 500, { error: 'auth_delete_failed', status: r.status, body: await r.text() })
      return send(res, 200, { ok: true })
    }

    if (req.method === 'POST' && req.url === '/townhall/reminders/run') {
      // Manual trigger — useful for ops/debugging the cron
      runTownhallReminders().catch(e => console.error('manual reminder', e))
      return send(res, 200, { ok: true, triggered: true })
    }

    if (req.method === 'GET' && req.url === '/townhall/state') {
      const th = await pickTownhall()
      if (!th) return send(res, 404, { error: 'no townhall' })
      const isLive = !!th.live_at && !th.ended_at
      return send(res, 200, {
        id: th.id, scheduled_at: th.scheduled_at, title: th.title, topic: th.topic,
        live_at: th.live_at, ended_at: th.ended_at, isLive
      })
    }

    if (req.method === 'POST' && req.url === '/townhall/start') {
      const { userId, userName } = await readJson(req)
      if (!await isHost(userId)) return send(res, 403, { error: 'host_only' })
      const th = await pickTownhall()
      if (!th) return send(res, 404, { error: 'no townhall' })
      const room = await dailyEnsureRoom(th.daily_room || 'preparing-you-townhall', { properties: { enable_recording: 'cloud' } })
      const token = await dailyMintToken(th.daily_room || 'preparing-you-townhall', { userName, isOwner: true })
      await sb.from('prep_townhalls').update({ live_at: new Date().toISOString(), ended_at: null }).eq('id', th.id)
      return send(res, 200, { url: `${room.url}?t=${token}`, isOwner: true })
    }

    if (req.method === 'POST' && req.url === '/townhall/end') {
      const { userId } = await readJson(req)
      if (!await isHost(userId)) return send(res, 403, { error: 'host_only' })
      const th = await pickTownhall()
      if (!th) return send(res, 404, { error: 'no townhall' })
      await sb.from('prep_townhalls').update({ ended_at: new Date().toISOString() }).eq('id', th.id)
      return send(res, 200, { ok: true })
    }

    if (req.method === 'POST' && req.url === '/townhall/join') {
      const { userId, userName } = await readJson(req)
      const th = await pickTownhall()
      if (!th) return send(res, 404, { error: 'no townhall' })
      const owner = await isHost(userId)
      const isLive = !!th.live_at && !th.ended_at
      // Non-hosts may only join after a moderator has started the call.
      if (!isLive && !owner) return send(res, 403, { error: 'not_started', message: 'The townhall has not started yet. Please wait for a moderator to begin.' })
      const room = await dailyEnsureRoom(th.daily_room || 'preparing-you-townhall', { properties: { enable_recording: 'cloud' } })
      const token = await dailyMintToken(th.daily_room || 'preparing-you-townhall', { userName, isOwner: owner })
      // If a host joins the join endpoint while not yet live, treat that as starting it.
      if (!isLive && owner) {
        await sb.from('prep_townhalls').update({ live_at: new Date().toISOString(), ended_at: null }).eq('id', th.id)
      }
      return send(res, 200, { url: `${room.url}?t=${token}`, scheduled_at: th.scheduled_at, title: th.title, topic: th.topic, isOwner: owner })
    }

    send(res, 404, { error: 'not_found' })
  } catch (e) {
    console.error('[err]', e)
    send(res, 500, { error: e.message || 'internal_error' })
  }
})

server.listen(PORT, () => {
  console.log(`[preparing-you] listening on :${PORT}`)
})

// ─── Townhall reminder cron ─────────────────────────────────────────────
// Every 5 minutes, find any townhall scheduled within the next 30 minutes
// that hasn't had its reminder sent yet. Send everyone a bell-notification
// AND an email. Mark reminder_sent_at to prevent duplicates.
const TOWNHALL_REMINDER_LEAD_MS = 30 * 60 * 1000

async function runTownhallReminders() {
  try {
    const now = Date.now()
    const upper = new Date(now + TOWNHALL_REMINDER_LEAD_MS).toISOString()
    const lower = new Date(now).toISOString()
    const { data: ths, error } = await sb.from('prep_townhalls')
      .select('id, scheduled_at, title, topic')
      .gte('scheduled_at', lower)
      .lte('scheduled_at', upper)
      .is('reminder_sent_at', null)
    if (error) { console.warn('[townhall-cron] query failed', error); return }
    if (!ths || !ths.length) return

    for (const th of ths) {
      const minsAway = Math.max(1, Math.round((new Date(th.scheduled_at).getTime() - Date.now()) / 60000))
      const title = th.title || 'Weekly Townhall'
      const text = `🎙 ${title} starts in ${minsAway} minutes` + (th.topic ? ` — ${th.topic}` : '')
      const at = new Date(th.scheduled_at)

      const { data: users } = await sb.from('prep_users').select('id, name, email')
      const list = users || []

      // 1) Bell notifications — bulk insert
      const rows = list.map(u => ({
        user_id: u.id, icon: '🎙', text,
        action: { type: 'page', page: 'home' }
      }))
      for (let i = 0; i < rows.length; i += 100) {
        await sb.from('prep_notifications').insert(rows.slice(i, i + 100))
      }

      // 2) Emails — sequential with small delay (Resend free tier rate)
      const subject = `${title} starts in ${minsAway} minutes`
      const body = `<p>The townhall begins shortly.</p>
        <p><strong>${title}</strong>${th.topic ? ' — <em>' + th.topic + '</em>' : ''}<br>
        <span style="color:#6f5641;font-style:italic">Starts at ${at.toUTCString()} (your local time will be shown in the app).</span></p>
        <p>Open the app to join when the moderator goes live.</p>`
      for (const u of list) {
        if (u.email) {
          await sendEmail(u.email, subject, emailWrap('Townhall starting soon', body, 'Open Preparing You', 'https://preparingyou.netlify.app'))
          await new Promise(r => setTimeout(r, 100))
        }
      }

      await sb.from('prep_townhalls').update({ reminder_sent_at: new Date().toISOString() }).eq('id', th.id)
      console.log(`[townhall-cron] sent reminders for townhall ${th.id} to ${list.length} users`)
    }
  } catch (e) {
    console.error('[townhall-cron]', e)
  }
}

// Run on boot, then every 5 minutes
setTimeout(runTownhallReminders, 5000)
setInterval(runTownhallReminders, 5 * 60 * 1000)
