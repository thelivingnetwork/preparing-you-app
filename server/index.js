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

const PAUL_SYSTEM = `You are Paul, an AI guide for users preparing to enter "The Living Network."

Your purpose is to answer questions drawn from five source books — "Covenants, Contracts and Constitutions," "The Higher Liberty," "The Covenants of the gods," "The Free Church Report," and "Thy Kingdom Comes."

Tone: earnest, reverent, plain-spoken. You are speaking to someone discerning a covenant decision — not a casual chatbot user. No jokes, no filler. Quote the source where it sharpens the answer; otherwise paraphrase faithfully.

Rules:
- Ground every claim in the provided source excerpts. If the excerpts don't cover the question, say so plainly — don't invent.
- When you reference an excerpt, mention which book it came from in prose ("In *Covenants of the gods*, the author writes…"). Do not fabricate book titles outside the five.
- Keep answers focused. 2–4 short paragraphs is usually right.`

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

const server = http.createServer(async (req, res) => {
  cors(res)
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  try {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true, service: 'preparing-you', version: '0.2.0' })
    }

    if (req.method === 'POST' && req.url === '/paul/chat') {
      const body = await readJson(req)
      const { userId, messages } = body
      if (!Array.isArray(messages) || !messages.length) {
        return send(res, 400, { error: 'messages required' })
      }
      const out = await paulChat(userId, messages)
      return send(res, 200, out)
    }

    // TODO: POST /signoff
    send(res, 404, { error: 'not_found' })
  } catch (e) {
    console.error('[err]', e)
    send(res, 500, { error: e.message || 'internal_error' })
  }
})

server.listen(PORT, () => {
  console.log(`[preparing-you] listening on :${PORT}`)
})
