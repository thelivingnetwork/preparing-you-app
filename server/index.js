// Preparing You — backend service stub
// Run: node server/index.js  (after `cd server && npm install`)

const fs = require('fs')
const envPath = fs.existsSync('/etc/secrets/.env') ? '/etc/secrets/.env' : '.env'
require('dotenv').config({ path: envPath })

const http = require('http')

const PORT = parseInt(process.env.PORT || '10000', 10)
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}
function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(obj))
}

const server = http.createServer(async (req, res) => {
  cors(res)
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, service: 'preparing-you', version: '0.1.0' })
  }

  // TODO: /paul/chat  — proxy to Anthropic with RAG context
  // TODO: /signoff    — PCM approves a user; issue JWT for TLN handoff
  // TODO: /upload     — admin uploads source PDFs to Supabase Storage

  send(res, 404, { error: 'not_found' })
})

server.listen(PORT, () => {
  console.log(`[preparing-you] listening on :${PORT}`)
})
