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
  if (!process.env.RESEND_API_KEY) { console.warn('[email] no RESEND_API_KEY'); return }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from: RESEND_FROM, to, subject, html })
    })
    if (!r.ok) console.error('[email] failed', r.status, await r.text())
  } catch (e) { console.error('[email] threw', e) }
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

// ─── Notification helper ────────────────────────────────────────────────
async function notify(userId, icon, text, action) {
  if (!userId) return
  const { error } = await sb.from('prep_notifications').insert({ user_id: userId, icon, text, action: action || null })
  if (error) console.warn('[notify] insert failed', error)
}

// ─── PCM election ───────────────────────────────────────────────────────
async function electPcm({ electorId, pcmId }) {
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
  if (pcm?.email) {
    await sendEmail(pcm.email, 'You have been elected as a Personal Contact Minister',
      emailWrap('A new election',
        `<p>${elector?.name || 'A user'} has elected you as their Personal Contact Minister.</p>
         <p>Open the app to accept or decline. If you accept, you will be paired with them in messages and able to walk alongside their preparation.</p>`,
        'Open Preparing You', 'https://preparing-you.netlify.app'))
  }
  if (elector?.email) {
    await sendEmail(elector.email, 'Your election has been sent',
      emailWrap('Election sent',
        `<p>You have elected <strong>${pcm?.name || 'a Personal Contact Minister'}</strong>.</p>
         <p>They have been emailed and will respond shortly. We will email you again once they accept or decline.</p>`,
        'Open Preparing You', 'https://preparing-you.netlify.app'))
  }
  await notify(pcmId, '⛪', `${elector?.name || 'A user'} has elected you as their PCM.`, { type:'page', page:'pcm' })
  await notify(electorId, '⏳', `Your election to ${pcm?.name || 'a PCM'} has been sent.`, { type:'page', page:'pcm' })
  return row
}

async function respondPcm({ electionId, pcmId, accept }) {
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
  if (elector?.email) {
    if (accept) {
      await sendEmail(elector.email, 'Your PCM accepted your election',
        emailWrap('Accepted',
          `<p>${pcm?.name || 'Your PCM'} has accepted your election. They will walk this preparation alongside you.</p><p>You can now message them or schedule a call from inside the app.</p>`,
          'Open Preparing You', 'https://preparing-you.netlify.app'))
    } else {
      await sendEmail(elector.email, 'Your PCM is currently unavailable',
        emailWrap('Currently unavailable',
          `<p>${pcm?.name || 'Your PCM'} is unavailable at this time. Please choose another Personal Contact Minister from the list.</p>`,
          'Choose another', 'https://preparing-you.netlify.app'))
    }
  }
  if (accept) await notify(el.elector_id, '✓', `${pcm?.name || 'Your PCM'} accepted your election.`, { type:'page', page:'messages' })
  else        await notify(el.elector_id, '⚠', `${pcm?.name || 'Your PCM'} is currently unavailable. Choose another.`, { type:'page', page:'pcm' })
  return { status: newStatus }
}

const server = http.createServer(async (req, res) => {
  cors(res)
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  try {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true, service: 'preparing-you', version: '0.5.0' })
    }

    if (req.method === 'POST' && req.url === '/paul/chat') {
      const body = await readJson(req)
      const { userId, messages } = body
      if (!Array.isArray(messages) || !messages.length) return send(res, 400, { error: 'messages required' })
      return send(res, 200, await paulChat(userId, messages))
    }

    if (req.method === 'POST' && req.url === '/elect') {
      const { electorId, pcmId } = await readJson(req)
      const row = await electPcm({ electorId, pcmId })
      return send(res, 200, { election: row })
    }

    if (req.method === 'POST' && req.url === '/election/respond') {
      const { electionId, pcmId, accept } = await readJson(req)
      return send(res, 200, await respondPcm({ electionId, pcmId, accept }))
    }

    if (req.method === 'POST' && req.url === '/call/start') {
      const { roomName, userName, isOwner } = await readJson(req)
      if (!roomName) return send(res, 400, { error: 'roomName required' })
      const room = await dailyEnsureRoom(roomName)
      const token = await dailyMintToken(roomName, { userName, isOwner })
      return send(res, 200, { url: `${room.url}?t=${token}`, roomUrl: room.url, token })
    }

    if (req.method === 'POST' && req.url === '/welcome') {
      const { userId } = await readJson(req)
      if (!userId) return send(res, 400, { error: 'userId required' })
      const { data: u } = await sb.from('prep_users').select('name, email').eq('id', userId).maybeSingle()
      if (u?.email) {
        await sendEmail(u.email, 'Welcome to Preparing You',
          emailWrap('Welcome',
            `<p>Peace to you, ${u.name || 'friend'}.</p>
             <p>You have begun the work of preparation. Three short videos and five short books wait inside, along with Paul — an AI guide drawn from those books — and a community of Personal Contact Ministers ready to walk this with you.</p>
             <p>Begin where you are.</p>`,
            'Open Preparing You', 'https://preparing-you.netlify.app'))
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

    if (req.method === 'POST' && req.url === '/townhall/join') {
      const { userId, userName } = await readJson(req)
      const { data: th } = await sb.from('prep_townhalls').select('*').order('scheduled_at', { ascending: true }).limit(1).maybeSingle()
      if (!th) return send(res, 404, { error: 'no townhall' })
      const { data: hostRow } = userId ? await sb.from('prep_townhall_hosts').select('user_id').eq('user_id', userId).maybeSingle() : { data: null }
      const isOwner = !!hostRow
      const room = await dailyEnsureRoom(th.daily_room || 'preparing-you-townhall', { properties: { enable_recording: 'cloud' } })
      const token = await dailyMintToken(th.daily_room || 'preparing-you-townhall', { userName, isOwner })
      return send(res, 200, { url: `${room.url}?t=${token}`, scheduled_at: th.scheduled_at, title: th.title, topic: th.topic, isOwner })
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
