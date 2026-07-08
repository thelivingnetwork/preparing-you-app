// Preparing You — backend service
// Endpoints:
//   GET  /health     — liveness check
//   POST /paul/chat  — RAG-backed chat with Paul (Anthropic + pgvector via Supabase)
//   POST /signoff    — TODO: PCM signs off; mint TLN handoff JWT

const fs = require('fs')
const envPath = fs.existsSync('/etc/secrets/.env') ? '/etc/secrets/.env' : '.env'
require('dotenv').config({ path: envPath })

const http  = require('http')
const https = require('https')
const Anthropic = require('@anthropic-ai/sdk')
const { createClient } = require('@supabase/supabase-js')
const webpush = require('web-push')

const PORT = parseInt(process.env.PORT || '10000', 10)
// Comma-separated allow-list, e.g.
//   ALLOWED_ORIGIN=https://preparingyou.app,https://preparingyou-admin.netlify.app
// Use "*" to allow any origin. The matching request origin is echoed back so
// both the main app and the admin app can call the server.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN
    || 'https://preparingyou.app,https://preparingyou-admin.netlify.app,https://preparingyou.netlify.app')
  .split(',').map(s => s.trim()).filter(Boolean)

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
})

// ── Private-message encryption (AES-256-GCM) ──────────────────────────────────
// DM bodies are stored ENCRYPTED at rest so the admin dashboard (anon key) and
// anyone reading the database see only ciphertext. The server holds the key
// (MESSAGE_ENC_KEY) so it can decrypt for the two participants and build push
// previews. This is "blind admin" — strong at-rest privacy with a deliberate,
// audited break-glass path — not zero-knowledge E2EE.
const crypto = require('crypto')
const _ENC_PREFIX = 'enc:v1:'
function _loadEncKey() {
  const raw = (process.env.MESSAGE_ENC_KEY || '').trim()
  if (!raw) return null
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex')        // 32 bytes as hex
  try { const b = Buffer.from(raw, 'base64'); if (b.length === 32) return b } catch (_) {}
  return null
}
const _MSG_KEY = _loadEncKey()
if (!_MSG_KEY) console.warn('[enc] MESSAGE_ENC_KEY missing/invalid — message bodies stored as PLAINTEXT until it is set')
else console.log('[enc] message encryption enabled')

function encryptBody(plain) {
  if (plain == null) return null
  // Fail loud rather than silently storing cleartext: a missing key is a misconfiguration,
  // not a reason to write plaintext bodies to the database.
  if (!_MSG_KEY) throw new Error('MESSAGE_ENC_KEY not configured — refusing to store plaintext')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', _MSG_KEY, iv)
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return _ENC_PREFIX + Buffer.concat([iv, tag, ct]).toString('base64')
}
function isEncrypted(stored) { return typeof stored === 'string' && stored.startsWith(_ENC_PREFIX) }
function decryptBody(stored) {
  if (stored == null) return null
  if (!isEncrypted(stored)) return stored // legacy plaintext row
  if (!_MSG_KEY) return '[encrypted]'
  try {
    const blob = Buffer.from(stored.slice(_ENC_PREFIX.length), 'base64')
    const iv = blob.subarray(0, 12), tag = blob.subarray(12, 28), ct = blob.subarray(28)
    const dec = crypto.createDecipheriv('aes-256-gcm', _MSG_KEY, iv)
    dec.setAuthTag(tag)
    return Buffer.concat([dec.update(ct), dec.final()]).toString('utf8')
  } catch (e) { return '[unable to decrypt]' }
}

// ── PCM Fellowship group room ─────────────────────────────────────────
// The single shared room id for the all-active-PCMs group chat. Messages
// live in prep_room_messages (not prep_messages, which is strictly 1:1).
const PCM_ROOM_ID = 'pcm_fellowship'

// ── System sender ("Preparing You") ───────────────────────────────────
// A dedicated, non-human account used for one-way admin -> member messages.
// Provisioned on first use via the Admin API (no manual setup), then cached
// for the life of the process. The account never logs in.
const _SYSTEM_EMAIL = 'no-reply@preparingyou.app'
const _SYSTEM_NAME = 'Preparing You'
let _systemSenderId = null
async function ensureSystemUser() {
  if (_systemSenderId) return _systemSenderId
  // Already provisioned?
  const { data: existing } = await sb.from('prep_users')
    .select('id').eq('is_system', true).limit(1).maybeSingle()
  if (existing && existing.id) { _systemSenderId = existing.id; return _systemSenderId }
  // Create the auth account; the on_auth_user_created trigger mirrors it into
  // prep_users (flagged is_system via the metadata). A random password is fine.
  let uid = null
  const { data: created, error: cErr } = await sb.auth.admin.createUser({
    email: _SYSTEM_EMAIL,
    email_confirm: true,
    password: crypto.randomBytes(24).toString('hex'),
    user_metadata: { name: _SYSTEM_NAME, system: true }
  })
  if (created && created.user) uid = created.user.id
  if (!uid) {
    // Likely already exists in auth -> recover the id from prep_users by email.
    const { data: byEmail } = await sb.from('prep_users')
      .select('id').eq('email', _SYSTEM_EMAIL).maybeSingle()
    if (byEmail && byEmail.id) uid = byEmail.id
  }
  if (!uid) throw new Error('ensureSystemUser: ' + ((cErr && cErr.message) || 'could not provision'))
  // Make sure the profile row is named + flagged correctly.
  await sb.from('prep_users').update({ name: _SYSTEM_NAME, is_system: true }).eq('id', uid)
  _systemSenderId = uid
  return _systemSenderId
}

// Resolve & verify a Supabase access token from the Authorization header.
async function verifyToken(req) {
  const authH = req.headers['authorization'] || ''
  const token = authH.startsWith('Bearer ') ? authH.slice(7) : null
  if (!token) return { error: 'no_token', status: 401 }
  const callerSb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: 'Bearer ' + token } }, auth: { persistSession: false }
  })
  const { data } = await callerSb.auth.getUser(token)
  const uid = data?.user?.id
  if (!uid) return { error: 'invalid_token', status: 401 }
  return { uid }
}
async function requireAdmin(req) {
  const v = await verifyToken(req)
  if (v.error) return v
  const { data: adminRow } = await sb.from('prep_admins').select('user_id').eq('user_id', v.uid).maybeSingle()
  if (!adminRow) return { error: 'not_admin', status: 403 }
  return { uid: v.uid }
}
let _kpiCache = null; // { t, v } — org-wide KPI snapshot, 60s TTL
// True only when the user has completed the audio overview of every Book.
// Runs with the service role so it can read another member's progress (which
// RLS otherwise hides), letting a PCM's sign-off be gated on real completion.
async function booksAllComplete(userId) {
  const { data: books } = await sb.from('prep_books').select('id')
  const total = (books || []).length
  if (!total) return false
  const ids = new Set(books.map(b => b.id))
  const { data: prog } = await sb.from('prep_book_audio_progress').select('book_id').eq('user_id', userId)
  const done = new Set((prog || []).filter(r => ids.has(r.book_id)).map(r => r.book_id))
  return done.size >= total
}
const _UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
async function signAttachment(stored) {
  if (!stored) return null
  if (/^https?:\/\//.test(stored)) return stored // legacy public URL — pass through
  const { data } = await sb.storage.from('message-attachments').createSignedUrl(stored, 3600)
  return data?.signedUrl || null
}

// Web Push — VAPID. If the keys aren't set, push fanout becomes a no-op.
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY || ''
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || ''
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:tofnotifications@gmail.com'
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE)
} else {
  console.warn('[push] VAPID keys missing — /paul-style chat works but push notifications are disabled')
}

function cors(res, req) {
  const reqOrigin = req && req.headers ? req.headers.origin : null
  let allow
  if (ALLOWED_ORIGINS.includes('*')) allow = '*'
  else if (reqOrigin && ALLOWED_ORIGINS.includes(reqOrigin)) allow = reqOrigin
  else allow = ALLOWED_ORIGINS[0]
  res.setHeader('Access-Control-Allow-Origin', allow)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Paul-Lang')
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

// ─── Error log ──────────────────────────────────────────────────────────
// Fire-and-forget insert into prep_client_errors. Never throws and never
// blocks the caller — logging must not be able to break a request. Fields
// are truncated so a runaway stack can't bloat the row.
const _clip = (s, n) => (s == null ? null : String(s).slice(0, n))
function logError(source, info) {
  try {
    sb.from('prep_client_errors').insert({
      source,
      kind:        _clip(info.kind, 40),
      message:     _clip(info.message, 2000),
      stack:       _clip(info.stack, 6000),
      url:         _clip(info.url, 1000),
      user_agent:  _clip(info.user_agent, 500),
      app_version: _clip(info.app_version, 60),
      user_uid:    _clip(info.user_uid, 120),
      extra:       info.extra && typeof info.extra === 'object' ? info.extra : null
    }).then(({ error }) => { if (error) console.warn('[logError] insert failed', error.message) },
            e => console.warn('[logError] threw', e && e.message))
  } catch (e) { console.warn('[logError] sync threw', e && e.message) }
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

// ─── Voice: read a raw (binary) request body ────────────────────────────
function readRaw(req, maxBytes = 12e6) {
  return new Promise((resolve, reject) => {
    const chunks = []; let len = 0
    req.on('data', c => {
      len += c.length
      if (len > maxBytes) { req.destroy(); reject(new Error('audio too large')) }
      else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// Paul language name → ISO-639-1 (helps Whisper when the user picked a language).
const LANG_ISO = {
  'English':'en','Spanish':'es','French':'fr','Portuguese':'pt','German':'de','Italian':'it',
  'Russian':'ru','Chinese (Simplified)':'zh','Arabic':'ar','Armenian':'hy','Hindi':'hi','Swahili':'sw','Filipino':'tl'
}

// ─── Speech-to-text via OpenAI Whisper ──────────────────────────────────
async function transcribeAudio(buf, contentType, langName) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing')
  const ct = contentType || 'audio/webm'
  const ext = ct.includes('mp4') || ct.includes('m4a') ? 'mp4'
            : ct.includes('ogg') ? 'ogg'
            : ct.includes('wav') ? 'wav' : 'webm'
  const form = new FormData()
  form.append('file', new Blob([buf], { type: ct }), `audio.${ext}`)
  form.append('model', 'whisper-1')
  const iso = LANG_ISO[langName]
  if (iso) form.append('language', iso)
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form
  })
  if (!r.ok) throw new Error(`whisper failed: ${r.status} ${await r.text()}`)
  const j = await r.json()
  return (j.text || '').trim()
}

// ─── Text-to-speech (per-language router) ───────────────────────────────
// ElevenLabs Flash v2.5 covers 11 of Paul's 13 languages well, but NOT
// Armenian or Swahili. So we route by language: ElevenLabs for the ones it
// speaks well, OpenAI TTS for the rest (and as the universal fallback when
// ElevenLabs isn't configured — OpenAI is already wired for Whisper).
const PAUL_VOICE_ID  = process.env.PAUL_VOICE_ID || ''
const PAUL_DAILY_CAP = parseInt(process.env.PAUL_DAILY_CAP || '150', 10)

// Paul languages ElevenLabs Flash v2.5 handles natively (Armenian + Swahili excluded).
const ELEVEN_LANGS = new Set([
  'English','Spanish','French','Portuguese','German','Italian',
  'Russian','Chinese (Simplified)','Arabic','Hindi','Filipino'
])

async function ttsElevenLabs(text) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${PAUL_VOICE_ID}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5', voice_settings: { stability: 0.4, similarity_boost: 0.8 } })
  })
  if (!r.ok) throw new Error(`elevenlabs failed: ${r.status} ${await r.text()}`)
  return Buffer.from(await r.arrayBuffer())
}

async function ttsOpenAI(text) {
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'onyx', input: text })
  })
  if (!r.ok) throw new Error(`openai tts failed: ${r.status} ${await r.text()}`)
  return Buffer.from(await r.arrayBuffer())
}

async function synthSpeech(text, langName) {
  const elevenReady = process.env.ELEVENLABS_API_KEY && PAUL_VOICE_ID
  if (elevenReady && ELEVEN_LANGS.has(langName || 'English')) return ttsElevenLabs(text)
  if (process.env.OPENAI_API_KEY) return ttsOpenAI(text)
  const e = new Error('tts_unconfigured'); e.code = 'tts_unconfigured'; throw e
}

// Pull complete sentences off a growing buffer so we can speak as Paul writes.
function extractSentences(buf, minLen = 12) {
  const out = []; let rest = buf
  const re = /^([\s\S]*?[.!?…]+["')\]]*)(\s+)([\s\S]*)$/
  while (true) {
    const m = rest.match(re)
    if (!m) break
    const sentence = m[1].trim()
    if (sentence.length < minLen) break
    out.push(sentence); rest = m[3]
  }
  return [out, rest]
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

// ─── Bible lookup ────────────────────────────────────────────────────────
//
// Two providers:
//   1. bible-api.com  — no key required; public-domain translations only
//   2. api.bible      — free key (API_BIBLE_KEY env var); 2500+ translations
//                       Set key at: https://scripture.api.bible/
//
// Translations and which provider serves them:
const BIBLE_TRANSLATIONS = {
  // ── Available on bible-api.com (no key) ──────────────────────────────
  kjv:      { name: 'King James Version',             provider: 'bibleapi' },
  asv:      { name: 'American Standard Version',      provider: 'bibleapi' },
  web:      { name: 'World English Bible',            provider: 'bibleapi' },
  bbe:      { name: 'Bible in Basic English',         provider: 'bibleapi' },
  ylt:      { name: "Young's Literal Translation",    provider: 'bibleapi' },
  wb:       { name: "Webster's Bible",                provider: 'bibleapi' },
  'oeb-us': { name: 'Open English Bible (US)',        provider: 'bibleapi' },
  'oeb-cw': { name: 'Open English Bible (Commonwealth)', provider: 'bibleapi' },
  weymouth: { name: 'Weymouth New Testament',         provider: 'bibleapi' },
  // ── Available on api.bible (API_BIBLE_KEY required) ──────────────────
  lsv:      { name: 'Literal Standard Version',      provider: 'apibible', id: '01b29f4b342acc35-01' },
  niv:      { name: 'New International Version',     provider: 'apibible', id: '78a9f6124f344018-01' },
  esv:      { name: 'English Standard Version',      provider: 'apibible', id: 'f72b840c1b9f8ef6-04' },
  nlt:      { name: 'New Living Translation',        provider: 'apibible', id: '65eec8e0b60e656b-02' },
  nasb:     { name: 'New American Standard Bible',   provider: 'apibible', id: 'c315fa9f71d4af3a-01' },
  nkjv:     { name: 'New King James Version',        provider: 'apibible', id: '40072c4a5aba4022-01' },
  msg:      { name: 'The Message',                   provider: 'apibible', id: '65eec8e0b60e656b-03' },
  amp:      { name: 'Amplified Bible',               provider: 'apibible', id: '3f4dc4fdc30a2abb-01' },
  csb:      { name: 'Christian Standard Bible',      provider: 'apibible', id: '55ec700d9e6d1977-01' },
  nrsv:     { name: 'New Revised Standard Version',  provider: 'apibible', id: '2880202-1-01' },
}

// OSIS 3-letter book codes for api.bible reference parsing
const BOOK_CODES = {
  genesis:'GEN',gen:'GEN',exodus:'EXO',exo:'EXO',leviticus:'LEV',lev:'LEV',
  numbers:'NUM',num:'NUM',deuteronomy:'DEU',deu:'DEU',deut:'DEU',
  joshua:'JOS',jos:'JOS',josh:'JOS',judges:'JDG',jdg:'JDG',judg:'JDG',
  ruth:'RUT',rut:'RUT',
  '1samuel':'1SA','1sa':'1SA','1sam':'1SA','2samuel':'2SA','2sa':'2SA','2sam':'2SA',
  '1kings':'1KI','1ki':'1KI','1kgs':'1KI','2kings':'2KI','2ki':'2KI','2kgs':'2KI',
  '1chronicles':'1CH','1ch':'1CH','1chr':'1CH','2chronicles':'2CH','2ch':'2CH','2chr':'2CH',
  ezra:'EZR',ezr:'EZR',nehemiah:'NEH',neh:'NEH',esther:'EST',est:'EST',
  job:'JOB',psalms:'PSA',psalm:'PSA',psa:'PSA',ps:'PSA',
  proverbs:'PRO',pro:'PRO',prov:'PRO',ecclesiastes:'ECC',ecc:'ECC',
  'song of solomon':'SNG','song of songs':'SNG',sng:'SNG',sos:'SNG',
  isaiah:'ISA',isa:'ISA',jeremiah:'JER',jer:'JER',lamentations:'LAM',lam:'LAM',
  ezekiel:'EZK',ezk:'EZK',ezek:'EZK',daniel:'DAN',dan:'DAN',
  hosea:'HOS',hos:'HOS',joel:'JOL',jol:'JOL',amos:'AMO',amo:'AMO',
  obadiah:'OBA',oba:'OBA',jonah:'JON',jon:'JON',micah:'MIC',mic:'MIC',
  nahum:'NAM',nam:'NAM',habakkuk:'HAB',hab:'HAB',zephaniah:'ZEP',zep:'ZEP',
  haggai:'HAG',hag:'HAG',zechariah:'ZEC',zec:'ZEC',zech:'ZEC',malachi:'MAL',mal:'MAL',
  matthew:'MAT',mat:'MAT',matt:'MAT',mark:'MRK',mrk:'MRK',mk:'MRK',
  luke:'LUK',luk:'LUK',lk:'LUK',john:'JHN',jhn:'JHN',jn:'JHN',
  acts:'ACT',act:'ACT',romans:'ROM',rom:'ROM',
  '1corinthians':'1CO','1co':'1CO','1cor':'1CO','2corinthians':'2CO','2co':'2CO','2cor':'2CO',
  galatians:'GAL',gal:'GAL',ephesians:'EPH',eph:'EPH',
  philippians:'PHP',php:'PHP',phil:'PHP',colossians:'COL',col:'COL',
  '1thessalonians':'1TH','1th':'1TH','1thes':'1TH','2thessalonians':'2TH','2th':'2TH','2thes':'2TH',
  '1timothy':'1TI','1ti':'1TI','1tim':'1TI','2timothy':'2TI','2ti':'2TI','2tim':'2TI',
  titus:'TIT',tit:'TIT',philemon:'PHM',phm:'PHM',hebrews:'HEB',heb:'HEB',
  james:'JAS',jas:'JAS',
  '1peter':'1PE','1pe':'1PE','1pet':'1PE','2peter':'2PE','2pe':'2PE','2pet':'2PE',
  '1john':'1JN','1jn':'1JN','1jno':'1JN','2john':'2JN','2jn':'2JN','3john':'3JN','3jn':'3JN',
  jude:'JUD',jud:'JUD',revelation:'REV',rev:'REV',revelations:'REV',
}

// Parse "John 3:16-18" or "Psalm 23" into an api.bible passage ID
function toOsisPassageId(reference) {
  const ref = reference.trim()
  // Match: <book> <chapter>[:<verse>[-<verse>]]
  const m = ref.match(/^((?:\d\s)?[a-z\s]+?)\s+(\d+)(?::(\d+)(?:-(\d+))?)?$/i)
  if (!m) throw new Error(`Could not parse reference: ${reference}`)
  const bookKey = m[1].trim().toLowerCase().replace(/\s+/g, '')
  const code = BOOK_CODES[bookKey]
  if (!code) throw new Error(`Unknown book: ${m[1]}`)
  const ch = m[2]
  if (!m[3]) return `${code}.${ch}` // whole chapter
  const v1 = m[3], v2 = m[4]
  return v2 ? `${code}.${ch}.${v1}-${code}.${ch}.${v2}` : `${code}.${ch}.${v1}`
}

// Fetch from bible-api.com (public-domain translations, no key)
async function fetchFromBibleApi(reference, translation) {
  const url = `https://bible-api.com/${encodeURIComponent(reference)}?translation=${translation}`
  const r = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!r.ok) throw new Error(`bible-api.com returned ${r.status}`)
  const j = await r.json()
  if (j.error) throw new Error(j.error)
  return `${j.reference} (${j.translation_name})\n\n${j.text.trim()}`
}

// Fetch from api.bible (requires API_BIBLE_KEY)
async function fetchFromApiBible(reference, bibleId, translationName) {
  const key = process.env.API_BIBLE_KEY
  if (!key) throw new Error('API_BIBLE_KEY not set — cannot fetch this translation')
  const passageId = toOsisPassageId(reference)
  const url = `https://api.scripture.api.bible/v1/bibles/${bibleId}/passages/${passageId}`
    + '?content-type=text&include-notes=false&include-titles=false'
    + '&include-chapter-numbers=false&include-verse-numbers=true'
  const r = await fetch(url, { headers: { 'api-key': key, Accept: 'application/json' } })
  if (!r.ok) throw new Error(`api.bible returned ${r.status} for ${translationName}`)
  const j = await r.json()
  if (!j.data) throw new Error('No data from api.bible')
  const text = j.data.content.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
  return `${j.data.reference} (${translationName})\n\n${text}`
}

// Route to the right provider
async function fetchBiblePassage(reference, translation = 'kjv') {
  const t = BIBLE_TRANSLATIONS[translation.toLowerCase()]
  if (!t) throw new Error(`Unknown translation: ${translation}`)
  if (t.provider === 'apibible') return fetchFromApiBible(reference, t.id, t.name)
  return fetchFromBibleApi(reference, translation)
}

const TRANSLATION_LIST = Object.entries(BIBLE_TRANSLATIONS)
  .map(([k, v]) => `${k} (${v.name}${v.provider === 'apibible' ? ', requires API key' : ''})`)
  .join(', ')

// ─── Strong's Concordance + Thayer's (Greek) / BDB (Hebrew) ─────────────
// Uses bolls.life BDBT dictionary — free, no key required
async function fetchStrongsDefinition(number) {
  const num = number.trim().toUpperCase()
  if (!/^[GH]\d+$/.test(num)) throw new Error(`Invalid Strong's number "${number}" — use G3056 or H430 format`)
  const url = `https://bolls.life/dictionary-definition/BDBT/${num}/`
  const r = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!r.ok) throw new Error(`bolls.life returned ${r.status} for ${num}`)
  const data = await r.json()
  const entry = Array.isArray(data) ? data[0] : data
  if (!entry) throw new Error(`No entry found for ${num}`)
  // Strip HTML tags from the full definition
  const cleanDef = (entry.definition || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  const lang = num[0] === 'G' ? 'Greek (Thayer\'s)' : 'Hebrew (BDB)'
  const lines = [
    `${num} — ${entry.lexeme || ''} (${lang})`,
    entry.transliteration ? `Transliteration: ${entry.transliteration}` : '',
    entry.pronunciation   ? `Pronunciation: ${entry.pronunciation}` : '',
    entry.short_definition ? `Gloss: ${entry.short_definition}` : '',
    '',
    cleanDef,
  ]
  return lines.filter(l => l !== undefined).join('\n').trim()
}

const BIBLE_TOOLS = [{
  name: 'lookup_bible_passage',
  description: 'Fetch the exact text of a Bible passage from an online Bible. Use this whenever the user asks about a specific verse or scripture, or when quoting scripture directly would enrich your answer.',
  input_schema: {
    type: 'object',
    properties: {
      reference: {
        type: 'string',
        description: 'The Bible reference, e.g. "John 3:16", "Romans 8:28-30", "Psalm 23", "1 Corinthians 13:1-7"'
      },
      translation: {
        type: 'string',
        enum: Object.keys(BIBLE_TRANSLATIONS),
        description: `Bible translation abbreviation. Default: kjv. Available: ${TRANSLATION_LIST}`
      }
    },
    required: ['reference']
  }
}, {
  name: 'lookup_strongs',
  description: "Look up a Strong's Concordance number to get the original Hebrew or Greek word, its definition from Strong's, Thayer's (Greek), or Brown-Driver-Briggs (Hebrew). Use this when the user asks about the meaning of a word in the original language, asks what the Greek or Hebrew word is behind an English translation, or requests a word study.",
  input_schema: {
    type: 'object',
    properties: {
      number: {
        type: 'string',
        description: 'The Strong\'s number to look up. Prefix G for Greek (e.g. G26, G3056) or H for Hebrew (e.g. H430, H3068).'
      }
    },
    required: ['number']
  }
}, {
  name: 'search_church_articles',
  description: 'Search for articles on preparingyou.com (7,000+ wiki articles) and hisholychurch.org. Use this when the user asks about a topic and you want to find relevant articles from those sites, or when you need to look something up that goes beyond the book excerpts.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query, e.g. "covenant", "free church", "liberty and taxation"' }
    },
    required: ['query']
  }
}, {
  name: 'fetch_church_article',
  description: 'Fetch the full text of a specific article from preparingyou.com or hisholychurch.org. Use this after search_church_articles to read the full content of a relevant article, or when you already know the URL.',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full URL of the article, e.g. "https://preparingyou.com/wiki/Covenant" or "https://hisholychurch.org/news/articles/covenant.php"' }
    },
    required: ['url']
  }
}]

// ─── HisHolyChurch.org + PreparingYou.com article access ────────────────
//
// preparingyou.com  → MediaWiki API (7,236 articles; SSL cert issue → https module)
// hisholychurch.org → WP REST API for blog (12 posts) + HTML scrape for main site

function fetchInsecure(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const opts = { hostname: u.hostname, path: u.pathname + u.search, rejectUnauthorized: false, headers: { 'User-Agent': 'PreparingYou-Paul/1.0' } }
    https.get(opts, res => {
      let buf = ''
      res.on('data', c => { buf += c; if (buf.length > 500_000) res.destroy() })
      res.on('end', () => resolve(buf))
    }).on('error', reject)
  })
}

function stripHtml(html) {
  return html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
             .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
             .replace(/<[^>]+>/g, ' ')
             .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
             .replace(/\s{2,}/g, ' ').trim()
}

async function searchPreparingYou(query, limit = 10) {
  const mkUrl = (srsearch, n) =>
    `https://preparingyou.com/wiki/api.php?action=query&list=search&srsearch=${encodeURIComponent(srsearch)}&srwhat=text&srlimit=${n}&srprop=snippet|size&format=json&formatversion=2`
  const parse = raw => (JSON.parse(raw).query?.search || []).map(a => ({
    title: a.title,
    snippet: stripHtml(a.snippet || ''),
    url: `https://preparingyou.com/wiki/${a.title.replace(/ /g, '_')}`
  }))
  // Run a title-targeted pass (surfaces dedicated pages) and a full-text pass,
  // then merge with title matches first. Resilient if either pass fails.
  const [titleHits, textHits] = await Promise.allSettled([
    fetchInsecure(mkUrl(`intitle:${query}`, 5)).then(parse),
    fetchInsecure(mkUrl(query, limit)).then(parse)
  ])
  if (titleHits.status === 'rejected') console.warn(`[paul] preparingyou intitle search failed: ${titleHits.reason?.message || titleHits.reason}`)
  if (textHits.status === 'rejected')  console.warn(`[paul] preparingyou text search failed: ${textHits.reason?.message || textHits.reason}`)
  const seen = new Set()
  const merged = []
  for (const r of [
    ...(titleHits.status === 'fulfilled' ? titleHits.value : []),
    ...(textHits.status === 'fulfilled' ? textHits.value : [])
  ]) {
    if (seen.has(r.title)) continue
    seen.add(r.title)
    merged.push(r)
  }
  return merged.slice(0, limit)
}

async function searchHhcBlog(query, limit = 3) {
  const url = `https://www.hisholychurch.org/blog/index.php?rest_route=/wp/v2/posts&search=${encodeURIComponent(query)}&per_page=${limit}&_fields=id,title,excerpt,link`
  const r = await fetch(url)
  if (!r.ok) return []
  return (await r.json() || []).map(p => ({
    title: stripHtml(p.title?.rendered || ''),
    snippet: stripHtml(p.excerpt?.rendered || '').slice(0, 200),
    url: p.link
  }))
}

async function searchChurchArticles(query) {
  const [wiki, blog] = await Promise.allSettled([searchPreparingYou(query, 10), searchHhcBlog(query, 5)])
  if (wiki.status === 'rejected') console.warn(`[paul] preparingyou search failed: ${wiki.reason?.message || wiki.reason}`)
  if (blog.status === 'rejected') console.warn(`[paul] hisholychurch search failed: ${blog.reason?.message || blog.reason}`)
  const results = [
    ...(wiki.status === 'fulfilled' ? wiki.value : []),
    ...(blog.status === 'fulfilled' ? blog.value : [])
  ]
  console.log(`[paul] search_church_articles "${query}" -> ${results.length} results`)
  if (!results.length) return 'No articles found for that query.'
  return results.map((a, i) => `${i + 1}. ${a.title}\n   ${a.snippet}\n   ${a.url}`).join('\n\n')
}

async function fetchChurchArticle(url) {
  const u = new URL(url)
  const host = u.hostname.replace(/^www\./, '')
  if (!['preparingyou.com', 'hisholychurch.org'].includes(host)) {
    throw new Error('Only hisholychurch.org and preparingyou.com URLs are allowed')
  }
  if (host === 'preparingyou.com') {
    const title = decodeURIComponent(u.pathname.replace(/^\/wiki\//, '').replace(/_/g, ' '))
    const apiUrl = `https://preparingyou.com/wiki/api.php?action=query&prop=extracts&titles=${encodeURIComponent(title)}&explaintext=1&exintro=0&format=json&formatversion=2`
    const j = JSON.parse(await fetchInsecure(apiUrl))
    const page = (j.query?.pages || [])[0]
    if (!page || page.missing !== undefined) throw new Error(`Article not found: ${title}`)
    const extract = (page.extract || '').trim()
    return `${page.title} (preparingyou.com)\n\n${extract.slice(0, 4000)}${extract.length > 4000 ? '\n\n[article continues…]' : ''}`
  }
  if (u.pathname.includes('/blog/')) {
    const slug = u.pathname.replace(/\/$/, '').split('/').pop()
    const apiUrl = `https://www.hisholychurch.org/blog/index.php?rest_route=/wp/v2/posts&slug=${encodeURIComponent(slug)}&_fields=title,content`
    const r = await fetch(apiUrl)
    if (!r.ok) throw new Error(`Blog API returned ${r.status}`)
    const posts = await r.json()
    if (!posts?.length) throw new Error(`Blog post not found: ${slug}`)
    const text = stripHtml(posts[0].content?.rendered || '').slice(0, 4000)
    return `${stripHtml(posts[0].title?.rendered || '')} (hisholychurch.org)\n\n${text}`
  }
  // Main site — scrape <td id=content>
  const html = await fetch(url).then(r => r.text())
  const m = html.match(/<td[^>]*id=["']?content["']?[^>]*>([\s\S]*?)(?=<tr[^>]*><td[^>]*id=["']?cft|<\/table>)/i)
  const text = stripHtml(m ? m[1] : html).slice(0, 4000)
  if (!text.trim()) throw new Error('Could not extract article content from that URL')
  return `${u.pathname} (hisholychurch.org)\n\n${text}`
}

// PROMPT-CACHING INVARIANT: PAUL_SYSTEM and BIBLE_TOOLS (incl. the TRANSLATION_LIST
// interpolated into them) are sent as the cached prefix on every Paul request. They
// MUST stay byte-identical across calls/restarts for cache reads to hit — do NOT
// interpolate a date, version, request id, or any per-request value into either.
const PAUL_SYSTEM = `You are Paul, a guide for someone preparing to enter "The Living Network."

Tone: earnest, reverent, plain-spoken. You are speaking to someone discerning a covenant decision — not a casual chatbot user. Speak as a wise elder might, in the first person where it fits naturally.

You can answer five kinds of questions:
1. Substantive questions about preparation, covenants, contracts, liberty, the kingdom, ministers, etc. — drawn from the source excerpts below AND from the church sites, which you should search whenever a topic might be covered there.
2. Practical questions about how to use this app (Preparing You) — drawn from the App Guide below.
3. Questions about scripture, Bible verses, or passages — use the lookup_bible_passage tool to fetch the actual text before answering.
4. Word studies — questions about what a Greek or Hebrew word means, or what word underlies an English translation — use the lookup_strongs tool with the appropriate Strong's number (G for Greek, H for Hebrew).
5. Any topical, doctrinal, historical, or scriptural-theme question (e.g. the red heifer, covenants, baptism, tithing, the daily sacrifice) — search the sites proactively. preparingyou.com (7,000+ articles) and hisholychurch.org hold far more than the five books, so do not wait for the excerpts to fall short: search them by default for substantive questions, then fetch_church_article to read the full text before answering.

App Guide — how the Preparing You app works:

Navigation. The bottom bar holds Home, Library, Books, PCM, Messages and Out (sign out). The bell icon top-right shows notifications.

Home page. Shows a Welcome card; the next Townhall (when scheduled, with a "Tap to join" button when a moderator has it live); tiles for the four steps — Introduction Videos, Choose a PCM, Topical Library, The Five Books — and a wider tile for Join The Living Network.

Introduction Videos. Three short films watched in order. Each must play through to the end before the next unlocks; seeking past the unwatched portion is disabled. Progress is tracked on the user's home tile (e.g. "1/3 watched").

The Five Books. Each book card has Listen (a 15-minute audio overview, podcast-style) and Read (the full PDF). A short blurb describes what the book is about.

Topical Library. A searchable index of articles and videos drawn from preparingyou.com, indexed alphabetically.

Choosing a Personal Contact Minister (PCM). The user picks a PCM from the list; an election is sent and the PCM is emailed. The PCM either accepts or declines. While pending the user sees an "Awaiting Acceptance" card; once accepted, the user is paired with that PCM and can message and call them. To volunteer themselves as a PCM, the user taps "+ Volunteer as PCM" and fills in their region and contact channels.

Messages tab. Thread with the paired PCM (or for a PCM viewing their electors, multiple threads with a tab selector). Send a message; tap the Call button to start a Daily.co video room. A call invite drops into the recipient's thread as a tappable link.

Townhall. A weekly community video call. Time is shown in each viewer's local timezone. Only moderators can start it; once they do, a red "Townhall is live — tap to join" banner appears across all pages for everyone. A reminder email and bell notification go out roughly 30 minutes before the scheduled time.

Join The Living Network. Available once a PCM has signed the user off. The page shows a CTA that hands the user off to The Living Network with name and email prefilled.

Notifications. Bell icon top-right. Server-backed so they sync across devices. Tap "Mark all read" to clear.

Forgot password. Link on the sign-in form sends a reset email; the user follows the link to choose a new password.

Rules for answering:
- For questions about the source material: use the excerpts below as your knowledge. Speak from them as your own understanding — do not say things like "drawn from the books," "according to the source," "the excerpt says," or name book titles. Just answer.
- For questions about app operation: answer plainly using the App Guide above. You can name UI elements (e.g. "the PCM tab," "the bell icon").
- For scripture questions: always call lookup_bible_passage to get the exact text before answering. Quote it directly. Default to KJV unless the user requests another translation. If a user asks for NIV, ESV, NLT, NKJV, NASB, MSG, AMP, or CSB and no API key is configured, tell them plainly that translation isn't available and offer KJV, ASV, WEB, or YLT instead.
- For word studies: call lookup_strongs with the Strong's number. You know common numbers from your training (e.g. G26=agape, G3056=logos, G4151=pneuma, H430=Elohim, H3068=YHWH). If you are uncertain of the number, say so and invite the user to provide it, or look up the passage first and reason from context.
- Searching the church sites — be thorough, never timid:
  • For any substantive topic, call search_church_articles early, even alongside the book excerpts — do not treat it as a last resort.
  • If the first search returns only thin or incidental mentions, run at least two more searches with different phrasings (the exact term, synonyms, and closely related terms) before drawing any conclusion.
  • Always call fetch_church_article on the most promising result(s) and read the full text before you answer. A snippet that mentions a term only in passing does NOT mean there is no dedicated article — the search index returns fragments, not whole pages.
  • Never tell the user a topic "isn't covered," that there's "no dedicated article," or that something is "the extent of what's indexed" until you have actually fetched and read the top candidate articles and genuinely found nothing. Do not apologize for the search; just keep working it until you have the substance.
  • Use what the articles actually say; do not invent content.
- If a question is about backend systems, code, deployment, the admin panel, billing, or anything not user-facing — politely say that's not something you can help with here.
- If neither the excerpts, App Guide, nor scripture cover a question, say plainly that you cannot speak to that here. Do not invent.
- Keep answers focused. 2–4 short paragraphs is usually right.
- If the user specifies a length or format — "in 50 words", "one sentence", "briefly", "in bullet points", etc. — obey it exactly. An explicit length or format request from the user OVERRIDES the default guidance above: never exceed a word or sentence limit they give, even if it means leaving detail out.
- Do not begin with "Peace to you" or other greetings — a greeting is offered by the interface.`

const PAUL_LANGS = new Set([
  'English','Spanish','French','Portuguese','German','Italian',
  'Russian','Chinese (Simplified)','Arabic','Armenian','Hindi','Swahili','Filipino'
])

// Dispatch a single Claude tool_use block to its implementation.
async function executeTool(toolBlock) {
  if (toolBlock.name === 'lookup_strongs')         return await fetchStrongsDefinition(toolBlock.input.number)
  if (toolBlock.name === 'search_church_articles') return await searchChurchArticles(toolBlock.input.query)
  if (toolBlock.name === 'fetch_church_article')   return await fetchChurchArticle(toolBlock.input.url)
  const { reference, translation = 'kjv' } = toolBlock.input
  return await fetchBiblePassage(reference, translation)
}

// Log token usage + prompt-cache hit/miss for a Paul API response so caching can be
// verified in the Render logs. cache_read > 0 on a follow-up call confirms the cached
// tools+system prefix is being served at ~0.1x input price instead of full price.
function logPaulUsage(tag, resp) {
  const u = resp && resp.usage
  if (u) console.log(`[paul] ${tag} in=${u.input_tokens} cache_write=${u.cache_creation_input_tokens || 0} cache_read=${u.cache_read_input_tokens || 0} out=${u.output_tokens}`)
}

async function paulChat(userId, messages, lang) {
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

  // Per-question content (RAG excerpts + language note) is volatile; PAUL_SYSTEM and
  // BIBLE_TOOLS are byte-identical on every call. Split `system` into a stable block and
  // a volatile block so prompt caching serves tools + PAUL_SYSTEM (~5.4k tokens) from
  // cache on every call across all turns/users, and reuses the excerpts within a turn's
  // tool loop. Render order is tools → system → messages, so cache_control on the first
  // system block also caches the tool definitions that precede it.
  let volatile = '\n\nSource excerpts retrieved for this question:\n\n' + context
  // Always auto-detect the user's language and respond in kind.
  // If the user has explicitly chosen a language via the dropdown, that overrides auto-detection.
  if (lang && PAUL_LANGS.has(lang) && lang !== 'English') {
    volatile += `\n\nLanguage: The user has selected ${lang} as their preferred language. Always respond in ${lang} regardless of what language they write in.`
  } else {
    volatile += `\n\nLanguage: Detect the language of the user's most recent message and respond in that same language. If they write in Spanish, reply in Spanish. If French, reply in French. Match whatever language they use.`
  }
  const sys = [
    { type: 'text', text: PAUL_SYSTEM, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: volatile,    cache_control: { type: 'ephemeral' } },
  ]

  // Tool-use loop — Paul can call lookup_bible_passage before answering
  const apiMessages = messages.map(m => ({ role: m.role, content: m.content }))
  let resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 1024,
    system: sys,
    messages: apiMessages,
    tools: BIBLE_TOOLS
  })
  logPaulUsage('call1', resp)

  let toolRounds = 0
  while (resp.stop_reason === 'tool_use' && toolRounds < 8) {
    toolRounds++
    // Claude may emit several tool_use blocks in one turn (parallel tool calls).
    // Every tool_use MUST get a matching tool_result in the next message, or the
    // API rejects the follow-up with a 400. So handle ALL of them, not just the first.
    const toolBlocks = resp.content.filter(b => b.type === 'tool_use')
    if (!toolBlocks.length) break

    const toolResults = []
    for (const toolBlock of toolBlocks) {
      const _t0 = Date.now()
      // NB: do NOT log toolBlock.input — it's derived from the user's message and would
      // leak conversation content into Render logs. Name + timing/size only.
      console.log(`[paul] tool ${toolBlock.name}`)
      let toolResult
      try {
        toolResult = await executeTool(toolBlock)
        console.log(`[paul] tool ${toolBlock.name} ok in ${Date.now() - _t0}ms, ${String(toolResult).length} chars`)
      } catch (e) {
        console.warn(`[paul] tool ${toolBlock.name} FAILED in ${Date.now() - _t0}ms: ${e.message}`)
        toolResult = `Could not retrieve: ${e.message}`
      }
      toolResults.push({ type: 'tool_result', tool_use_id: toolBlock.id, content: String(toolResult) })
    }

    apiMessages.push({ role: 'assistant', content: resp.content })
    apiMessages.push({ role: 'user', content: toolResults })

    resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1024,
      system: sys,
      messages: apiMessages,
      tools: BIBLE_TOOLS
    })
    logPaulUsage('loop', resp)
  }

  // If we hit the tool-round cap while Claude still wanted to call tools, make one
  // final pass with tools withheld so it answers from what it has gathered.
  if (resp.stop_reason === 'tool_use') {
    console.warn(`[paul] hit tool-round cap (${toolRounds}); forcing a final answer`)
    const capBlocks = resp.content.filter(b => b.type === 'tool_use')
    apiMessages.push({ role: 'assistant', content: resp.content })
    apiMessages.push({ role: 'user', content: capBlocks.map(b => ({
      type: 'tool_result', tool_use_id: b.id,
      content: 'Search budget reached — answer the user now with what you have already gathered.'
    })) })
    resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1024,
      system: sys,
      messages: apiMessages,
      // Keep the tool defs present so the cached tools+system prefix stays byte-stable,
      // but forbid further tool calls so Claude answers from what it gathered. Changing
      // tool_choice does not invalidate the tools/system cache; dropping tools would.
      tools: BIBLE_TOOLS,
      tool_choice: { type: 'none' }
    })
    logPaulUsage('cap', resp)
  }

  const answer = resp.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()

  // Persist both turns
  if (userId) {
    // Operator-blind: persist only what the daily-cap count needs (a user-role row per turn),
    // NOT the conversation content. Paul history is never shown back to the user or an admin,
    // so storing the text would be pure liability — message is left empty on purpose.
    await sb.from('prep_paul_chats').insert([
      { user_id: userId, role: 'user',      message: '' },
      { user_id: userId, role: 'assistant', message: '' },
    ])
  }

  return {
    answer,
    citations: chunks.map(c => ({ book: bookTitle(c.book_id), preview: c.chunk_text.slice(0, 140) }))
  }
}

// Streaming variant of paulChat: identical RAG + tool-use loop, but the answer
// is streamed and each completed sentence is handed to onSentence() so the
// caller can start text-to-speech before the whole reply is written.
async function paulChatStream(userId, messages, lang, onSentence) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user')
  if (!lastUser) throw new Error('no user message')

  const qEmb = await embedQuery(lastUser.content)
  const chunks = await retrieveChunks(qEmb, 6)
  const bookIds = [...new Set(chunks.map(c => c.book_id))]
  const { data: books } = await sb.from('prep_books').select('id, title').in('id', bookIds)
  const bookTitle = id => (books || []).find(b => b.id === id)?.title || 'Unknown'
  const context = chunks.map((c, i) =>
    `--- excerpt ${i + 1} from "${bookTitle(c.book_id)}" ---\n${c.chunk_text}`
  ).join('\n\n')

  // See paulChat: split system into a stable (cached) block + a volatile block so the
  // tools + PAUL_SYSTEM prefix is served from cache on every stream call.
  let volatile = '\n\nSource excerpts retrieved for this question:\n\n' + context
  if (lang && PAUL_LANGS.has(lang) && lang !== 'English') {
    volatile += `\n\nLanguage: The user has selected ${lang} as their preferred language. Always respond in ${lang} regardless of what language they write in.`
  } else {
    volatile += `\n\nLanguage: Detect the language of the user's most recent message and respond in that same language. If they write in Spanish, reply in Spanish. If French, reply in French. Match whatever language they use.`
  }
  const sys = [
    { type: 'text', text: PAUL_SYSTEM, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: volatile,    cache_control: { type: 'ephemeral' } },
  ]

  const apiMessages = messages.map(m => ({ role: m.role, content: m.content }))
  let rounds = 0, toolsWithheld = false, answer = ''

  while (true) {
    let buffer = ''
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1024,
      system: sys,
      messages: apiMessages,
      // Always send the tool defs so the cached tools+system prefix stays byte-stable.
      // When the round cap is hit, forbid further calls via tool_choice rather than
      // dropping the tools (which would invalidate the cache).
      tools: BIBLE_TOOLS,
      ...(toolsWithheld ? { tool_choice: { type: 'none' } } : {})
    })
    stream.on('text', (delta) => {
      buffer += delta
      const [sents, rest] = extractSentences(buffer)
      buffer = rest
      for (const s of sents) onSentence(s)
    })
    const final = await stream.finalMessage()
    logPaulUsage('stream', final)

    if (final.stop_reason === 'tool_use' && !toolsWithheld) {
      const toolBlocks = final.content.filter(b => b.type === 'tool_use')
      if (rounds < 8) {
        rounds++
        const toolResults = []
        for (const tb of toolBlocks) {
          try { toolResults.push({ type: 'tool_result', tool_use_id: tb.id, content: String(await executeTool(tb)) }) }
          catch (e) { toolResults.push({ type: 'tool_result', tool_use_id: tb.id, content: `Could not retrieve: ${e.message}` }) }
        }
        apiMessages.push({ role: 'assistant', content: final.content })
        apiMessages.push({ role: 'user', content: toolResults })
        continue
      }
      // Tool-round cap hit — withhold tools and force a final answer.
      apiMessages.push({ role: 'assistant', content: final.content })
      apiMessages.push({ role: 'user', content: toolBlocks.map(b => ({
        type: 'tool_result', tool_use_id: b.id,
        content: 'Search budget reached — answer the user now with what you have already gathered.'
      })) })
      toolsWithheld = true
      continue
    }

    // Final answer turn — speak any trailing partial sentence.
    if (buffer.trim()) onSentence(buffer.trim())
    answer = final.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()
    break
  }

  if (userId) {
    // Operator-blind: persist only what the daily-cap count needs (a user-role row per turn),
    // NOT the conversation content. Paul history is never shown back to the user or an admin,
    // so storing the text would be pure liability — message is left empty on purpose.
    await sb.from('prep_paul_chats').insert([
      { user_id: userId, role: 'user',      message: '' },
      { user_id: userId, role: 'assistant', message: '' },
    ])
  }

  return {
    answer,
    citations: chunks.map(c => ({ book: bookTitle(c.book_id), preview: c.chunk_text.slice(0, 140) }))
  }
}

// ─── Email via EmailJS REST (shared with TLN) ───────────────────────────
const EJS_SVC  = process.env.EMAILJS_SERVICE_ID || 'service_l43x4ow'
const EJS_TMPL = process.env.EMAILJS_TEMPLATE_ID || 'template_xob8ydi'
const EJS_PUB  = process.env.EMAILJS_PUBLIC_KEY || 'UXOmF9EejeF3j4EEZ'
async function sendEmailJS(toName, toEmail, subject, message) {
  if (!process.env.EMAILJS_PRIVATE_KEY) { console.warn('[ejs] no EMAILJS_PRIVATE_KEY'); return { ok:false, reason:'no-key' } }
  if (!toEmail) return { ok:false, reason:'no-email' }
  try {
    const r = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: EJS_SVC,
        template_id: EJS_TMPL,
        user_id: EJS_PUB,
        accessToken: process.env.EMAILJS_PRIVATE_KEY,
        template_params: {
          to_name: toName || 'Friend',
          email: toEmail,
          minister_name: 'Preparing You',
          message: message || '',
          subject: subject || 'Preparing You',
          from_name: 'Preparing You',
          company_name: 'Preparing You',
          company_email: 'tofnotifications@gmail.com',
          reply_to: 'tofnotifications@gmail.com'
        }
      })
    })
    const text = await r.text()
    if (!r.ok) { console.error('[ejs] FAILED', r.status, '→', toEmail, '|', text); return { ok:false, status:r.status, body:text } }
    console.log('[ejs] sent →', toEmail)
    return { ok:true }
  } catch (e) {
    console.error('[ejs] threw', e)
    return { ok:false, error: String(e) }
  }
}

// ─── Email ──────────────────────────────────────────────────────────────
// All transactional email goes through EmailJS (sendEmailJS). We previously
// used Resend here, but that account is in sandbox mode (no verified domain)
// and will only deliver to the account owner, silently dropping mail to every
// real recipient. EmailJS is the path the app already uses in production, so
// sendEmail() now flattens its HTML body to plain text and routes to EmailJS.
// Every existing call site (welcome, TLN invite, PCM election/accept/decline)
// is migrated automatically by this single redirect.
function _htmlToText(html) {
  if (!html) return ''
  return String(html)
    // <a href="url">text</a>  ->  "text: url"
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2: $1')
    .replace(/<\/(p|div|h1|h2|h3|h4|li|tr)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/^[ \t]+/gm, '')
    .trim()
}
async function sendEmail(to, subject, html) {
  const dest = Array.isArray(to) ? to[0] : to
  return sendEmailJS('Friend', dest, subject, _htmlToText(html))
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

async function dailyMintToken(roomName, { userName, isOwner, startRecording }) {
  const r = await fetch('https://api.daily.co/v1/meeting-tokens', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.DAILY_API_KEY}`, 'Content-Type': 'application/json' },
    // start_cloud_recording makes recording begin when this token-holder joins —
    // the documented, reliable way to "always record" without a moderator
    // clicking record. Requires the room's enable_recording:'cloud' (set below).
    body: JSON.stringify({ properties: { room_name: roomName, user_name: userName || 'Guest', is_owner: !!isOwner, ...(startRecording ? { start_cloud_recording: true } : {}), exp: Math.floor(Date.now()/1000) + 3*3600 } })
  })
  if (!r.ok) throw new Error(`daily token mint failed: ${r.status} ${await r.text()}`)
  return (await r.json()).token
}

// ─── TLN invitation ─────────────────────────────────────────────────────
const TLN_URL = process.env.TLN_URL || 'https://livingnetwork.netlify.app'

async function inviteToTln(userId, reasonHtml, skipEmail, inviterName) {
  if (!userId) return { ok: false, reason: 'no userId' }
  const { data: u } = await sb.from('prep_users').select('name, email, tln_invited_at').eq('id', userId).maybeSingle()
  if (!u?.email) return { ok: false, reason: 'no email' }
  if (u.tln_invited_at) return { ok: false, reason: 'already invited', at: u.tln_invited_at }

  if (!skipEmail) {
    // Handoff link prefills the TLN Join screen. This used to be built
    // client-side; invite emails are server-only now so member addresses
    // never travel to another member's device.
    const handoff = TLN_URL + '/?from=preparingyou'
      + '&name=' + encodeURIComponent(u.name || '')
      + '&email=' + encodeURIComponent(u.email)
      + '&inviter=' + encodeURIComponent(inviterName || '')
    await sendEmail(u.email, 'You have been invited to The Living Network',
      emailWrap('Welcome to The Living Network',
        (reasonHtml || `<p>${u.name || 'Friend'},</p><p>Your preparation has been recognised.</p>`) +
        `<p>You may now create your account in The Living Network. The link below takes you straight to the Join screen with your details prefilled.</p>`,
        'Open The Living Network', handoff))
  }

  await sb.from('prep_users').update({ tln_invited_at: new Date().toISOString() }).eq('id', userId)
  await sendSystemMessage(userId, 'You have been invited to The Living Network. Check your email for the link to create your account and enter.')
  return { ok: true }
}

// ─── Notification helper ────────────────────────────────────────────────
async function notify(userId, icon, text, action) {
  if (!userId) return
  const { error } = await sb.from('prep_notifications').insert({ user_id: userId, icon, text, action: action || null })
  if (error) { console.warn('[notify] insert failed', error); return }
  // Fan out a Web Push to all of the user's subscribed devices so the
  // home-screen icon badge updates and the OS shows a system notification
  // even when the PWA is closed.
  pushToUser(userId, { icon, text, action }).catch(e => console.warn('[push] fanout failed', e))
}

// Home-screen icon badge count for a user. MUST mirror the foreground math in
// index.html (refreshNavBadges): unread MESSAGES + unread PCM/Home notifications.
// Message-type notifications are deliberately excluded — unread messages are
// counted directly from prep_messages, so counting their notification rows too
// would double-count. (Those rows are also never marked read, so including them
// made the badge balloon to the lifetime total of messages received.)
const _BADGE_NOTIF_PAGES = ['pcm', 'home', 'video', 'join-tln']
async function badgeCountForUser(userId) {
  const [msgRes, notifRes] = await Promise.all([
    sb.from('prep_messages').select('id', { count: 'exact', head: true })
      .eq('recipient_id', userId).is('read_at', null),
    sb.from('prep_notifications').select('id', { count: 'exact', head: true })
      .eq('user_id', userId).is('read_at', null).in('action->>page', _BADGE_NOTIF_PAGES)
  ])
  return (msgRes.count || 0) + (notifRes.count || 0)
}

// Returns the number of push subscriptions the user had (0 = none, so the
// caller can fall back to another channel like email). Stale endpoints are
// still counted for this call; they're pruned after repeated failures.
async function pushToUser(userId, { icon, text, action }) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return 0
  const { data: subs } = await sb.from('prep_push_subscriptions')
    .select('id, endpoint, p256dh, auth').eq('user_id', userId)
  if (!subs || !subs.length) return 0
  const unread = await badgeCountForUser(userId)
  const payload = JSON.stringify({
    title: 'Preparing You',
    body: `${icon ? icon + ' ' : ''}${text}`,
    action: action || null,
    unread: unread || 0
  })
  const stale = []
  await Promise.all(subs.map(async s => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: 60 * 60 * 24 }
      )
      // Successful delivery — reset fail counter.
      await sb.from('prep_push_subscriptions')
        .update({ fail_count: 0, last_seen: new Date().toISOString() }).eq('id', s.id)
    } catch (err) {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        // Increment fail counter; only prune after 3 consecutive failures.
        // iOS can transiently return 410 when the service worker updates —
        // the client re-registers on next app open, so don't delete immediately.
        const { data: row } = await sb.from('prep_push_subscriptions')
          .select('fail_count').eq('id', s.id).maybeSingle()
        const fails = (row?.fail_count || 0) + 1
        if (fails >= 3) {
          stale.push(s.id)
        } else {
          await sb.from('prep_push_subscriptions').update({ fail_count: fails }).eq('id', s.id)
        }
      } else {
        console.warn('[push] send failed', err.statusCode || err.message)
      }
    }
  }))
  if (stale.length) await sb.from('prep_push_subscriptions').delete().in('id', stale)
  return subs.length
}

// Alert the recipient of a new person-to-person message. Web push is the
// primary channel; if the recipient has no active push subscription (never
// enabled notifications, or an iOS PWA whose endpoint expired), a closed app
// would surface nothing — so fall back to a single email. The email is sent
// only when this is the recipient's FIRST unread message, so a burst of
// messages can't flood their inbox. The in-app bell/badge row is created by
// the prep_message_notification trigger regardless.
async function notifyMessageRecipient(recipientId, senderName, pushText) {
  const subCount = await pushToUser(recipientId, {
    icon: '💬', text: pushText, action: { type: 'page', page: 'messages' }
  })
  if (subCount) return // push delivered (or attempted) — no email needed
  const { count } = await sb.from('prep_messages')
    .select('id', { count: 'exact', head: true })
    .eq('recipient_id', recipientId).is('read_at', null)
  if ((count || 0) > 1) return // already had unread messages — already alerted
  const { data: u } = await sb.from('prep_users')
    .select('email').eq('id', recipientId).maybeSingle()
  if (!u?.email) return
  await sendEmail(u.email, `${senderName} sent you a message`,
    emailWrap('New message',
      `<p>${senderName} sent you a message in Preparing You.</p>
       <p>Open the app to read and reply.</p>`,
      'Open Preparing You', 'https://preparingyou.app'))
}

// ─── In-app companion message ───────────────────────────────────────────
// Pairs every notification email with a short note in the member's Messages
// inbox, sent one-way from the "Preparing You" system account. The
// prep_messages INSERT trigger creates the bell automatically; we add a
// best-effort web-push so a closed app still alerts.
async function sendSystemMessage(recipientId, text) {
  if (!recipientId || !text) return
  try {
    const systemId = await ensureSystemUser()
    await sb.from('prep_messages').insert({ sender_id: systemId, recipient_id: recipientId, body: encryptBody(text), e2ee: false })
    const preview = text.length > 60 ? text.slice(0, 60) + '…' : text
    await pushToUser(recipientId, { icon: '💬', text: _SYSTEM_NAME + ': ' + preview, action: { type: 'page', page: 'messages' } })
  } catch (e) {
    console.warn('[sendSystemMessage] failed', (e && e.message) || e)
  }
}

// ─── Townhall inbox broadcast ────────────────────────────────────────────
// Deliver a one-way "Preparing You" message to every member's inbox (the same
// mechanism as an admin broadcast). Townhall alerts use this so each lands as
// an openable message: the unread-MESSAGE badge then clears when the member
// opens it, instead of a home-page bell they can't act on from Messages.
// Optionally fires a web push too (used for the time-sensitive "live" alert).
// Emails are sent separately by the callers.
async function townhallInboxBroadcast(text, { push = false, pushAction } = {}) {
  try {
    const { data: users } = await sb.from('prep_users').select('id').eq('is_system', false)
    const list = users || []
    if (!list.length) return
    const systemId = await ensureSystemUser()
    const encBody = encryptBody(text)
    const rows = list.map(u => ({ sender_id: systemId, recipient_id: u.id, body: encBody, e2ee: false }))
    for (let i = 0; i < rows.length; i += 100) {
      await sb.from('prep_messages').insert(rows.slice(i, i + 100))
    }
    if (push) {
      const preview = text.length > 60 ? text.slice(0, 60) + '…' : text
      await Promise.allSettled(list.map(u => pushToUser(u.id, {
        icon: '🎙', text: _SYSTEM_NAME + ': ' + preview,
        action: pushAction || { type: 'page', page: 'messages' }
      })))
    }
  } catch (e) {
    console.warn('[townhallInboxBroadcast] failed', (e && e.message) || e)
  }
}

// ─── PCM election ───────────────────────────────────────────────────────
async function electPcm({ electorId, pcmId, skipEmail }) {
  if (!electorId || !pcmId) throw new Error('electorId and pcmId required')
  if (electorId === pcmId) throw new Error('cannot elect self')

  // Gate: the elector must have finished the three introduction videos first.
  // This mirrors the UI lock so the journey can't be skipped via the API.
  const { data: ev } = await sb.from('prep_users')
    .select('gateway_v1_at, gateway_v2_at, gateway_v3_at').eq('id', electorId).maybeSingle()
  if (!ev || !ev.gateway_v1_at || !ev.gateway_v2_at || !ev.gateway_v3_at) {
    const e = new Error('gateway_incomplete'); e.status = 403; throw e
  }

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
        'Open Preparing You', 'https://preparingyou.app'))
  }
  if (!skipEmail && elector?.email) {
    await sendEmail(elector.email, 'Your election has been sent',
      emailWrap('Election sent',
        `<p>You have elected <strong>${pcm?.name || 'a Personal Contact Minister'}</strong>.</p>
         <p>They have been emailed and will respond shortly. We will email you again once they accept or decline.</p>`,
        'Open Preparing You', 'https://preparingyou.app'))
  }
  await sendSystemMessage(pcmId, `${elector?.name || 'A user'} has chosen you as their Personal Contact Minister. Open the app to accept or decline.`)
  await sendSystemMessage(electorId, `Your choice of ${pcm?.name || 'a Personal Contact Minister'} has been sent. They have been notified and will respond shortly.`)
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
          'Open Preparing You', 'https://preparingyou.app'))
    } else {
      await sendEmail(elector.email, 'Your PCM is currently unavailable',
        emailWrap('Currently unavailable',
          `<p>${pcm?.name || 'Your PCM'} is unavailable at this time. Please choose another Personal Contact Minister from the list.</p>`,
          'Choose another', 'https://preparingyou.app'))
    }
  }
  if (accept) await sendSystemMessage(el.elector_id, `${pcm?.name || 'Your PCM'} has accepted your choice and will walk alongside your preparation. You can message them anytime from here.`)
  else        await sendSystemMessage(el.elector_id, `${pcm?.name || 'Your PCM'} is unavailable at this time. You can choose another Personal Contact Minister from the list whenever you are ready.`)

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
      const result = await inviteToTln(pcmId,
        `<p>${pcm?.name || 'Friend'},</p>
         <p>You have been chosen by ${elector?.name || 'someone'} as their Personal Contact Minister. The act of being elected is itself the qualifying event — you are now invited to enter The Living Network.</p>`,
        skipEmail, elector?.name)
      if (result.ok) pcmAutoInvited = true
    }
  }
  // NB: no email addresses in the response — it lands on a member's device.
  return { status: newStatus, pcmAutoInvited, pcmName, electorName: elector?.name }
}

let _featuredCache = { at: 0, data: null }   // Keys of the Kingdom latest episode (in-memory, ~6h TTL)
const server = http.createServer(async (req, res) => {
  cors(res, req)
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  try {
    // Client error sink — unauthenticated by design (errors happen before/
    // without a session). Body size is capped by readJson; fields truncated
    // by logError. Always 204 so the reporter never retries or surfaces.
    if (req.method === 'POST' && req.url === '/client-error') {
      let b = {}
      try { b = await readJson(req) } catch (_) {}
      logError('client', {
        kind:        b.kind || 'error',
        message:     b.message,
        stack:       b.stack,
        url:         b.url,
        user_agent:  (req.headers && req.headers['user-agent']) || b.user_agent,
        app_version: b.app_version,
        user_uid:    b.user_uid,
        extra:       b.extra
      })
      res.writeHead(204); res.end(); return
    }

    // Durable cron trigger. pg_cron (via pg_net) POSTs here every minute so the
    // townhall jobs keep firing even if the in-process timer dies. Guarded by a
    // shared secret set on both sides (CRON_SECRET on Render + the pg_cron job
    // header). Fire-and-forget so the heartbeat returns instantly.
    if (req.method === 'POST' && req.url === '/cron/tick') {
      const secret = process.env.CRON_SECRET
      if (!secret || (req.headers['x-cron-secret'] || '') !== secret) {
        return send(res, 401, { error: 'unauthorized' })
      }
      runCronTick('http')
      return send(res, 200, { ok: true })
    }

    if (req.method === 'GET' && req.url === '/admin/kpis') {
      const tok = await verifyToken(req)
      if (tok.error) return send(res, tok.status, { error: tok.error })
      const { data: adminRow } = await sb.from('prep_admins').select('user_id').eq('user_id', tok.uid).maybeSingle()
      if (!adminRow) {
        const { data: pcmRow } = await sb.from('prep_pcms').select('id').eq('id', tok.uid).eq('active', true).maybeSingle()
        if (!pcmRow) return send(res, 403, { error: 'not_authorized' })
      }
      const now = Date.now()
      if (_kpiCache && (now - _kpiCache.t) < 60000) return send(res, 200, _kpiCache.v)
      // Members: total + joined in the last 7 days.
      const { count: members } = await sb.from('prep_users').select('id', { count: 'exact', head: true })
      const since = new Date(now - 7 * 24 * 3600 * 1000).toISOString()
      const { count: newMembers } = await sb.from('prep_users').select('id', { count: 'exact', head: true }).gte('created_at', since)
      // Onboarding: finished all three gateway videos.
      const { count: gatewayDone } = await sb.from('prep_users').select('id', { count: 'exact', head: true })
        .not('gateway_v1_at', 'is', null).not('gateway_v2_at', 'is', null).not('gateway_v3_at', 'is', null)
      // Onboarding: finished every Book (a progress row exists for all books).
      const { data: books } = await sb.from('prep_books').select('id')
      const totalBooks = (books || []).length
      const bookIds = new Set((books || []).map(b => b.id))
      let booksDone = 0
      if (totalBooks) {
        const { data: prog } = await sb.from('prep_book_audio_progress').select('user_id, book_id')
        const per = new Map()
        for (const r of (prog || [])) {
          if (!bookIds.has(r.book_id)) continue
          if (!per.has(r.user_id)) per.set(r.user_id, new Set())
          per.get(r.user_id).add(r.book_id)
        }
        for (const set of per.values()) if (set.size >= totalBooks) booksDone++
      }
      // PCM: accepted pairings (active) + pending elections (awaiting response).
      const { count: activePairings } = await sb.from('prep_pcm_elections').select('id', { count: 'exact', head: true }).eq('status', 'accepted')
      const { count: pendingElections } = await sb.from('prep_pcm_elections').select('id', { count: 'exact', head: true }).eq('status', 'pending')
      // Town hall: the next scheduled session (no RSVP concept exists).
      const { data: nextTh } = await sb.from('prep_townhalls').select('scheduled_at')
        .gte('scheduled_at', new Date(now).toISOString()).order('scheduled_at', { ascending: true }).limit(1).maybeSingle()
      const pct = (n) => members ? Math.round((n / members) * 100) : 0
      const v = {
        members: members || 0,
        newMembers7d: newMembers || 0,
        gatewayPct: pct(gatewayDone || 0),
        booksPct: pct(booksDone),
        activePairings: activePairings || 0,
        pendingElections: pendingElections || 0,
        nextTownhall: (nextTh && nextTh.scheduled_at) || null
      }
      _kpiCache = { t: now, v }
      return send(res, 200, v)
    }

    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true, service: 'preparing-you', version: '0.9.54', enc: !!_MSG_KEY })
    }

    // Signed audiobook URL — the Supabase public CDN intermittently 404s "cold"
    // (un-cached) objects, so the app fetches a short-lived signed URL per part
    // instead of hitting /object/public/. file is allow-listed to *.m4a names.
    if (req.method === 'GET' && req.url.startsWith('/audiobook-url')) {
      const file = (new URL('https://x.x' + req.url).searchParams.get('file') || '')
      if (!/^[A-Za-z0-9_-]+\.m4a$/.test(file)) return send(res, 400, { error: 'bad file' })
      const { data, error } = await sb.storage.from('audiobooks').createSignedUrl(file, 86400)
      if (error || !data) return send(res, 502, { error: (error && error.message) || 'sign failed' })
      return send(res, 200, { url: data.signedUrl })
    }

    // Featured audio (Vault > Audio): newest episode from the Keys of the
    // Kingdom podcast feed. Cached in-memory ~6h so their site is hit only a
    // few times a day regardless of traffic; serves stale on a fetch error.
    if (req.method === 'GET' && req.url === '/featured-audio') {
      const now = Date.now()
      if (_featuredCache.data && now - _featuredCache.at < 6 * 3600 * 1000) {
        return send(res, 200, _featuredCache.data)
      }
      try {
        const r = await fetch('https://keysofthekingdom.info/rss.xml', { headers: { 'User-Agent': 'PreparingYou/1.0' } })
        const xml = await r.text()
        const items = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/g)].map(m => m[0])
        const tag = (block, t) => { const m = block.match(new RegExp('<' + t + '[^>]*>([\\s\\S]*?)</' + t + '>', 'i')); return m ? m[1] : '' }
        let best = null, bestT = -1
        for (const b of items) {
          const t = Date.parse(tag(b, 'pubDate')) || 0
          if (t > bestT) { bestT = t; best = b }
        }
        if (!best) throw new Error('no items')
        const title = tag(best, 'title').replace(/<!\[CDATA\[|\]\]>/g, '').trim()
        const encl = best.match(/<enclosure[^>]*\burl="([^"]+)"/i)
        let url = (encl ? encl[1].trim() : '').replace(/^https?:\/\/[^\/]+/i, s => s.toLowerCase())  // normalize host for CSP
        if (!/^https:\/\/keysofthekingdom\.info\/[^"']+\.mp3$/i.test(url)) throw new Error('bad audio url')
        const date = bestT ? new Date(bestT).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' }) : ''
        const data = { title, date, url }
        _featuredCache = { at: now, data }
        return send(res, 200, data)
      } catch (e) {
        if (_featuredCache.data) return send(res, 200, _featuredCache.data)
        return send(res, 502, { error: 'feed unavailable' })
      }
    }

    if (req.method === 'GET' && req.url === '/push/vapid-public-key') {
      return send(res, 200, { key: VAPID_PUBLIC })
    }

    // Debug-only: POST /push/test-send?userId=<uuid>
    // Sends a real push to all subscriptions for that user and returns results.
    if (req.method === 'POST' && req.url.startsWith('/push/test-send')) {
      const a = await requireAdmin(req)
      if (a.error) return send(res, a.status, { error: a.error })
      const uid = new URL('https://x.x' + req.url).searchParams.get('userId')
      if (!uid) return send(res, 400, { error: 'userId required' })
      const { data: subs } = await sb.from('prep_push_subscriptions')
        .select('id, endpoint, p256dh, auth').eq('user_id', uid)
      if (!subs || !subs.length) return send(res, 200, { ok: false, reason: 'no subscriptions found' })
      const results = await Promise.all(subs.map(async s => {
        try {
          const r = await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            JSON.stringify({ title: 'Preparing You', body: '🔔 Push test — checking badge', unread: 1 }),
            { TTL: 3600 }
          )
          return { id: s.id, endpoint: s.endpoint.slice(0, 50), status: r.statusCode, ok: true }
        } catch (e) {
          return { id: s.id, endpoint: s.endpoint.slice(0, 50), status: e.statusCode, ok: false, body: e.body }
        }
      }))
      return send(res, 200, { results })
    }

    if (req.method === 'POST' && req.url === '/push/subscribe') {
      const v = await verifyToken(req)
      if (v.error) return send(res, v.status, { error: v.error })
      const { subscription } = await readJson(req)
      if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
        return send(res, 400, { error: 'subscription required' })
      }
      const { error } = await sb.from('prep_push_subscriptions').upsert({
        user_id: v.uid,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        last_seen: new Date().toISOString()
      }, { onConflict: 'endpoint' })
      if (error) return send(res, 500, { error: error.message })
      return send(res, 200, { ok: true })
    }

    if (req.method === 'POST' && req.url === '/push/unsubscribe') {
      const { endpoint } = await readJson(req)
      if (!endpoint) return send(res, 400, { error: 'endpoint required' })
      await sb.from('prep_push_subscriptions').delete().eq('endpoint', endpoint)
      return send(res, 200, { ok: true })
    }

    if (req.method === 'POST' && req.url === '/paul/chat') {
      const v = await verifyToken(req)
      if (v.error) return send(res, v.status, { error: v.error })
      const { messages, lang } = await readJson(req)
      if (!Array.isArray(messages) || !messages.length) return send(res, 400, { error: 'messages required' })
      return send(res, 200, await paulChat(v.uid, messages, lang))
    }

    // ─── Voice: speech-to-text (Whisper) ──────────────────────────────────
    // Body is the raw audio blob; language hint comes via X-Paul-Lang header.
    if (req.method === 'POST' && req.url === '/paul/transcribe') {
      const v = await verifyToken(req)
      if (v.error) return send(res, v.status, { error: v.error })
      const buf = await readRaw(req)
      if (!buf.length) return send(res, 400, { error: 'no audio' })
      const text = await transcribeAudio(buf, req.headers['content-type'], req.headers['x-paul-lang'])
      return send(res, 200, { text })
    }

    // ─── Voice: text-to-speech (swappable, default ElevenLabs) ────────────
    if (req.method === 'POST' && req.url === '/paul/speak') {
      const v = await verifyToken(req)
      if (v.error) return send(res, v.status, { error: v.error })
      const { text, lang } = await readJson(req)
      if (!text || !text.trim()) return send(res, 400, { error: 'text required' })
      try {
        const audio = await synthSpeech(text.trim(), lang)
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' })
        return res.end(audio)
      } catch (e) {
        if (e.code === 'tts_unconfigured') return send(res, 503, { error: 'tts_unconfigured' })
        throw e
      }
    }

    // ─── Voice: streaming chat (SSE, sentence-by-sentence) ────────────────
    if (req.method === 'POST' && req.url === '/paul/chat/stream') {
      const v = await verifyToken(req)
      if (v.error) return send(res, v.status, { error: v.error })
      const userId = v.uid
      const { messages, lang } = await readJson(req)
      if (!Array.isArray(messages) || !messages.length) return send(res, 400, { error: 'messages required' })

      // Daily-cap guardrail: count this user's turns since local midnight.
      if (userId) {
        const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0)
        const { count } = await sb.from('prep_paul_chats')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId).eq('role', 'user')
          .gte('created_at', dayStart.toISOString())
        if ((count || 0) >= PAUL_DAILY_CAP) return send(res, 429, { error: 'daily_cap' })
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      })
      const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      try {
        const { citations } = await paulChatStream(userId, messages, lang, s => sse('sentence', { text: s }))
        sse('done', { citations })
      } catch (e) {
        sse('error', { error: e.message })
      }
      return res.end()
    }

    if (req.method === 'POST' && req.url === '/elect') {
      const v = await verifyToken(req)
      if (v.error) return send(res, v.status, { error: v.error })
      const { pcmId, skipEmail } = await readJson(req)
      try {
        const row = await electPcm({ electorId: v.uid, pcmId, skipEmail })
        return send(res, 200, { election: row })
      } catch (e) {
        if (e.message === 'gateway_incomplete') return send(res, 403, { error: 'gateway_incomplete' })
        throw e
      }
    }

    if (req.method === 'POST' && req.url === '/election/respond') {
      const v = await verifyToken(req)
      if (v.error) return send(res, v.status, { error: v.error })
      const { electionId, accept, skipEmail } = await readJson(req)
      return send(res, 200, await respondPcm({ electionId, pcmId: v.uid, accept, skipEmail }))
    }

    // Gentle reminder to the elected PCM who hasn't responded yet. Only the
    // elector's own pending election can be nudged (verified server-side), so
    // this can't be used to email arbitrary people.
    if (req.method === 'POST' && req.url === '/pcm/nudge') {
      const v = await verifyToken(req)
      if (v.error) return send(res, v.status, { error: v.error })
      const electorId = v.uid
      const { data: el } = await sb.from('prep_pcm_elections')
        .select('id, pcm_id, elector:elector_id(name), pcm:pcm_id(name, email)')
        .eq('elector_id', electorId).eq('status', 'pending').maybeSingle()
      if (!el) return send(res, 404, { error: 'no_pending_election' })
      if (!el.pcm?.email) return send(res, 422, { error: 'no_pcm_email' })
      const electorName = el.elector?.name || 'Someone'
      const r = await sendEmailJS(el.pcm.name, el.pcm.email,
        'A gentle reminder — someone is waiting for you',
        `Dear ${el.pcm.name || 'friend'},\n\n`
        + `${electorName} has elected you as their Personal Contact Minister and is hoping to begin their preparation alongside you.\n\n`
        + `Whenever you have a quiet moment, please open Preparing You to accept or decline. There's no pressure at all — only a soul hoping for a companion on the road.\n\n`
        + `Grace and peace to you.\n\nhttps://preparingyou.app`)
      await sendSystemMessage(el.pcm_id, `${electorName} sent a gentle reminder — they are hoping you will accept or decline their choice when you have a quiet moment.`)
      return send(res, 200, { ok: !!r.ok, email: r })
    }

    // Elector withdraws their PCM election. We look up the elector's active
    // election(s), notify the PCM, then mark the election withdrawn and clear
    // the pairing. Doing the withdrawal server-side (rather than only client
    // Supabase writes) lets us reliably reach the PCM by email + in-app.
    if (req.method === 'POST' && req.url === '/pcm/withdraw') {
      const v = await verifyToken(req)
      if (v.error) return send(res, v.status, { error: v.error })
      const electorId = v.uid
      // At most one active election per elector (partial unique index), so a
      // bare maybeSingle() is safe — no ordering needed.
      const { data: el } = await sb.from('prep_pcm_elections')
        .select('id, pcm_id, status, elector:elector_id(name, email), pcm:pcm_id(name, email)')
        .eq('elector_id', electorId).in('status', ['pending', 'accepted'])
        .maybeSingle()
      // Always clear the pairing/elections, even if there's nothing to email.
      await sb.from('prep_pcm_elections')
        .update({ status: 'withdrawn', responded_at: new Date().toISOString() })
        .eq('elector_id', electorId).in('status', ['pending', 'accepted'])
      await sb.from('prep_users').update({ pcm_id: null }).eq('id', electorId)
      if (!el) return send(res, 200, { ok: true, emailed: false })
      const electorName = el.elector?.name || 'Someone'
      const pcmName = el.pcm?.name || 'their Personal Contact Minister'
      let emailed = false
      // 1) Gently let the PCM know their member has moved on.
      if (el.pcm?.email) {
        const r = await sendEmailJS(el.pcm.name, el.pcm.email,
          'An update on your Personal Contact Minister pairing',
          `Dear ${el.pcm.name || 'friend'},\n\n`
          + `${electorName} has withdrawn their choice of you as their Personal Contact Minister.\n\n`
          + `This is simply part of the journey — many souls take time to find the companion who is right for them, and a withdrawal is no reflection on you. You remain ready to walk alongside whoever the Lord brings next.\n\n`
          + `Grace and peace to you.\n\nhttps://preparingyou.app`)
        emailed = !!r.ok
      }
      // 2) Confirm the withdrawal to the member who made the change.
      if (el.elector?.email) {
        await sendEmailJS(el.elector.name, el.elector.email,
          'You have changed your Personal Contact Minister',
          `Dear ${el.elector?.name || 'friend'},\n\n`
          + `This note confirms that you have withdrawn your choice of ${pcmName} as your Personal Contact Minister.\n\n`
          + `Whenever you're ready, you can choose another minister from the list inside the app — there's no hurry, and no wrong choice. We'll let you know as soon as your next choice responds.\n\n`
          + `Grace and peace to you.\n\nhttps://preparingyou.app`)
      }
      await sendSystemMessage(el.pcm_id, `${electorName} has withdrawn their choice of you as their Personal Contact Minister. This is simply part of the journey — you remain ready for whoever comes next.`)
      await sendSystemMessage(electorId, `This confirms you have withdrawn your choice of ${pcmName}. You can choose another minister from the list whenever you are ready.`)
      return send(res, 200, { ok: true, emailed })
    }

    // PCM revokes a pairing they previously accepted — the mirror of
    // /pcm/withdraw, but initiated by the PCM. Marks the election 'revoked'
    // (outside the one-active-per-elector unique index, so the elector is free
    // to choose again), clears the elector's pcm_id, and notifies the elector
    // by email + in-app. Guarded on pcm_id so a PCM can only end their OWN pairing.
    if (req.method === 'POST' && req.url === '/pcm/revoke') {
      const v = await verifyToken(req)
      if (v.error) return send(res, v.status, { error: v.error })
      const pcmId = v.uid
      const { electionId, electorId } = await readJson(req)
      if (!electionId && !electorId) return send(res, 400, { error: 'electionId or electorId required' })
      let q = sb.from('prep_pcm_elections')
        .select('id, elector_id, pcm_id, status, elector:elector_id(name, email), pcm:pcm_id(name)')
        .eq('pcm_id', pcmId).eq('status', 'accepted')
      q = electionId ? q.eq('id', electionId) : q.eq('elector_id', electorId)
      const { data: el } = await q.maybeSingle()
      if (!el) return send(res, 404, { error: 'no_accepted_election' })

      // End the pairing.
      await sb.from('prep_pcm_elections')
        .update({ status: 'revoked', responded_at: new Date().toISOString() })
        .eq('id', el.id)
      await sb.from('prep_users').update({ pcm_id: null }).eq('id', el.elector_id)

      const pcmName = el.pcm?.name || 'your Personal Contact Minister'
      const electorName = el.elector?.name || 'friend'
      let emailed = false
      // Gently notify the elector and invite them to choose again.
      if (el.elector?.email) {
        const r = await sendEmail(el.elector.email,
          'A change in your Personal Contact Minister pairing',
          emailWrap('A change in your pairing',
            `<p>Dear ${electorName},</p>
             <p>${pcmName} is no longer able to continue as your Personal Contact Minister.</p>
             <p>This is simply part of the journey, and no reflection on you — whenever you're ready, you can choose another minister from the list inside the app. There's no hurry and no wrong choice, and we'll let you know as soon as your next choice responds.</p>
             <p>Grace and peace to you.</p>`,
            'Choose another', 'https://preparingyou.app'))
        emailed = !!r.ok
      }
      await sendSystemMessage(el.elector_id, `${pcmName} is no longer able to continue as your Personal Contact Minister. This is simply part of the journey, and no reflection on you — you can choose another minister from the list whenever you are ready.`)
      return send(res, 200, { ok: true, emailed })
    }

    // Email-system smoke test. Locked to a single allowlisted address so it
    // can never be used to send to arbitrary recipients.
    if (req.method === 'POST' && req.url === '/email/test') {
      const { to } = await readJson(req)
      const ALLOW = ['markofmelb@gmail.com']
      const dest = String(to || '').trim().toLowerCase()
      if (!ALLOW.includes(dest)) return send(res, 403, { error: 'address_not_allowed' })
      // Exercise the migrated sendEmail() chain (emailWrap HTML -> text -> EmailJS)
      // so this smoke test covers the real conversion path the app uses.
      const r = await sendEmail(dest, 'Preparing You — email system test',
        emailWrap('Email system test',
          `<p>This is a test message from the Preparing You server.</p>
           <p>If you're reading this, email delivery is working correctly.</p>
           <p>Sent at ${new Date().toISOString()}.</p>`,
          'Open Preparing You', 'https://preparingyou.app'))
      return send(res, 200, { ok: !!r.ok, result: r })
    }

    if (req.method === 'POST' && req.url === '/call/start') {
      const v = await verifyToken(req)
      if (v.error) return send(res, v.status, { error: v.error })
      const { roomName, userName, isOwner } = await readJson(req)
      if (!roomName) return send(res, 400, { error: 'roomName required' })
      // Owner (moderator) status is never taken from the request body — a caller
      // can only receive an owner token if they are an actual townhall host.
      const ownerOk = isOwner ? await isHost(v.uid) : false
      const room = await dailyEnsureRoom(roomName)
      const token = await dailyMintToken(roomName, { userName, isOwner: ownerOk })
      return send(res, 200, { url: `${room.url}?t=${token}`, roomUrl: room.url, token })
    }

    if (req.method === 'POST' && req.url === '/pcm/electors/readiness') {
      const v = await verifyToken(req)
      if (v.error) return send(res, v.status, { error: v.error })
      const { data: els } = await sb.from('prep_pcm_elections')
        .select('elector_id').eq('pcm_id', v.uid).eq('status', 'accepted')
      const ids = [...new Set((els || []).map(e => e.elector_id))]
      const { data: books } = await sb.from('prep_books').select('id')
      const total = (books || []).length
      const bookIds = new Set((books || []).map(b => b.id))
      const readiness = {}
      if (ids.length && total) {
        const { data: prog } = await sb.from('prep_book_audio_progress')
          .select('user_id, book_id').in('user_id', ids)
        const per = new Map()
        for (const r of (prog || [])) {
          if (!bookIds.has(r.book_id)) continue
          if (!per.has(r.user_id)) per.set(r.user_id, new Set())
          per.get(r.user_id).add(r.book_id)
        }
        for (const id of ids) readiness[id] = (per.get(id)?.size || 0) >= total
      } else {
        for (const id of ids) readiness[id] = false
      }
      return send(res, 200, { readiness, total })
    }

    if (req.method === 'POST' && req.url === '/tln/invite') {
      const v = await verifyToken(req)
      if (v.error) return send(res, v.status, { error: v.error })
      const { userId, fromName, skipEmail } = await readJson(req)
      if (!userId) return send(res, 400, { error: 'userId required' })
      // Only an admin, or the target user's own PCM, may sign someone off into TLN.
      const { data: adminRow } = await sb.from('prep_admins').select('user_id').eq('user_id', v.uid).maybeSingle()
      if (!adminRow) {
        const { data: tu } = await sb.from('prep_users').select('pcm_id').eq('id', userId).maybeSingle()
        if (!tu || tu.pcm_id !== v.uid) return send(res, 403, { error: 'forbidden' })
        // A PCM may only sign a member off once they've finished all Five Books.
        if (!(await booksAllComplete(userId))) return send(res, 200, { ok: false, reason: 'books_incomplete' })
      }
      const reason = fromName
        ? `<p>${fromName} has signed off on your readiness and invites you to enter The Living Network.</p>`
        : `<p>You have been invited to enter The Living Network.</p>`
      const result = await inviteToTln(userId, reason, skipEmail, fromName)
      return send(res, 200, result)
    }

    if (req.method === 'POST' && req.url === '/welcome') {
      const v = await verifyToken(req)
      if (v.error) return send(res, v.status, { error: v.error })
      const { userId, skipEmail } = await readJson(req)
      if (!userId) return send(res, 400, { error: 'userId required' })
      // A user may only trigger their own welcome; admins may trigger anyone's.
      if (userId !== v.uid) {
        const { data: adminRow } = await sb.from('prep_admins').select('user_id').eq('user_id', v.uid).maybeSingle()
        if (!adminRow) return send(res, 403, { error: 'forbidden' })
      }
      const { data: u } = await sb.from('prep_users').select('name, email').eq('id', userId).maybeSingle()
      if (!skipEmail && u?.email) {
        await sendEmail(u.email, 'Welcome to Preparing You',
          emailWrap('Welcome',
            `<p>Peace to you, ${u.name || 'friend'}.</p>
             <p>You have begun the work of preparation. Three short videos and five short books wait inside, along with Paul — an AI guide drawn from those books — and a community of Personal Contact Ministers ready to walk this with you.</p>
             <p>Begin where you are.</p>`,
            'Open Preparing You', 'https://preparingyou.app'))
      }
      await sendSystemMessage(userId, 'Welcome to Preparing You. When you are ready, begin with the three short introduction videos.')
      return send(res, 200, { ok: true })
    }

    if (req.method === 'POST' && req.url === '/messages/send') {
      const v = await verifyToken(req)
      if (v.error) return send(res, v.status, { error: v.error })
      const senderId = v.uid
      const { recipientId, body: msgBody, e2ee, attachmentUrl, attachmentPath, attachmentName, attachmentType } = await readJson(req)
      const isE2ee = e2ee === true
      const trimmedBody = (msgBody || '').trim()
      // attachmentPath is the private-bucket storage path (new clients);
      // attachmentUrl is kept for backward-compat with older cached clients.
      const attachVal = attachmentPath || attachmentUrl || null
      if (!recipientId || !_UUID_RE.test(recipientId) || (!trimmedBody && !attachVal)) {
        return send(res, 400, { error: 'recipientId and a body or attachment required' })
      }
      // One-way system accounts ("Preparing You") never receive replies. The
      // member app hides the reply box, but enforce it here too so a stale or
      // cached client can't silently send a message that would simply vanish.
      const { data: _rcpt } = await sb.from('prep_users').select('is_system').eq('id', recipientId).maybeSingle()
      if (_rcpt?.is_system) return send(res, 403, { error: 'readonly_recipient' })
      // Insert message. The body is encrypted at rest; the plaintext preview
      // below is used only for the transient web-push (never stored).
      // E2EE clients send ciphertext we store verbatim (the server can't and
      // shouldn't read it). Legacy clients still get server-side encryption.
      const { error: insErr } = await sb.from('prep_messages').insert({
        sender_id: senderId, recipient_id: recipientId,
        body: isE2ee ? (trimmedBody || null) : encryptBody(trimmedBody || null),
        e2ee: isE2ee,
        attachment_url: attachVal,
        attachment_name: attachmentName || null,
        attachment_type: attachmentType || null
      })
      if (insErr) return send(res, 500, { error: insErr.message })
      // Look up sender name for the push notification payload
      const { data: sender } = await sb.from('prep_users').select('name').eq('id', senderId).maybeSingle()
      const senderName = sender?.name || 'Someone'
      // For E2EE messages the server can't read the text, so the push is generic.
      let pushText
      if (isE2ee) {
        pushText = `${senderName} sent you a message`
      } else {
        const previewText = trimmedBody || ('📎 ' + (attachmentName || 'Attachment'))
        const preview = previewText.length > 60 ? previewText.slice(0, 60) + '…' : previewText
        pushText = `${senderName}: ${preview}`
      }
      // The DB trigger (prep_message_notification) creates the prep_notifications
      // row automatically on every prep_messages INSERT (the in-app bell/badge).
      // notifyMessageRecipient fires the web push and, if the recipient has no
      // active push subscription, falls back to an email so a closed app still
      // alerts. Fire-and-forget so the sender's request returns immediately.
      notifyMessageRecipient(recipientId, senderName, pushText)
        .catch(e => console.warn('[messages] recipient notify failed', e))
      return send(res, 200, { ok: true })
    }

    // Decrypted thread for the two participants. Replaces the old direct
    // Supabase read so the plaintext never travels except to the people in
    // the conversation (verified by their access token).
    if (req.method === 'POST' && req.url === '/messages/thread') {
      const v = await verifyToken(req)
      if (v.error) return send(res, v.status, { error: v.error })
      const meId = v.uid
      const { peerId } = await readJson(req)
      if (!peerId || !_UUID_RE.test(peerId)) return send(res, 400, { error: 'valid peerId required' })
      const { data: rows, error } = await sb.from('prep_messages')
        .select('*')
        .or(`and(sender_id.eq.${meId},recipient_id.eq.${peerId}),and(sender_id.eq.${peerId},recipient_id.eq.${meId})`)
        .order('created_at')
      if (error) return send(res, 500, { error: error.message })
      const messages = []
      for (const m of (rows || [])) {
        messages.push({
          id: m.id, sender_id: m.sender_id, recipient_id: m.recipient_id,
          // e2ee rows carry client ciphertext — pass it through untouched for the
          // client to decrypt. Legacy rows are decrypted here as before.
          body: m.e2ee ? m.body : decryptBody(m.body), e2ee: !!m.e2ee,
          created_at: m.created_at, read_at: m.read_at, reactions: m.reactions || {},
          attachment_url: await signAttachment(m.attachment_url),
          attachment_name: m.attachment_name, attachment_type: m.attachment_type
        })
      }
      // Mark inbound unread as read (server-side now that the client no longer
      // reads the table directly for display).
      const _readNow = new Date().toISOString()
      await sb.from('prep_messages').update({ read_at: _readNow })
        .eq('recipient_id', meId).eq('sender_id', peerId).is('read_at', null)
      // Also retire the message-type notification rows so they stop accumulating
      // as "unread" forever (they were never cleared, which ballooned the badge).
      await sb.from('prep_notifications').update({ read_at: _readNow })
        .eq('user_id', meId).is('read_at', null).eq('action->>page', 'messages')
      return send(res, 200, { messages })
    }

    // Add / replace / remove a tap-back reaction on one message. Stored as a
    // { userId: emoji } map on the message row; one reaction per user. Sending
    // the same emoji again (or null) clears the caller's reaction.
    if (req.method === 'POST' && req.url === '/messages/react') {
      const v = await verifyToken(req)
      if (v.error) return send(res, v.status, { error: v.error })
      const meId = v.uid
      const { messageId, emoji } = await readJson(req)
      if (messageId == null || !/^\d+$/.test(String(messageId))) return send(res, 400, { error: 'valid messageId required' })
      const ALLOWED = ['❤️', '😆', '😮', '😢', '😠', '👍']
      if (emoji != null && !ALLOWED.includes(emoji)) return send(res, 400, { error: 'unsupported_emoji' })
      const { data: msg } = await sb.from('prep_messages')
        .select('id, sender_id, recipient_id, reactions').eq('id', messageId).maybeSingle()
      if (!msg) return send(res, 404, { error: 'message_not_found' })
      if (msg.sender_id !== meId && msg.recipient_id !== meId) return send(res, 403, { error: 'not_a_participant' })
      const reactions = (msg.reactions && typeof msg.reactions === 'object') ? msg.reactions : {}
      if (!emoji || reactions[meId] === emoji) delete reactions[meId]
      else reactions[meId] = emoji
      const { error: upErr } = await sb.from('prep_messages').update({ reactions }).eq('id', messageId)
      if (upErr) return send(res, 500, { error: upErr.message })
      return send(res, 200, { ok: true, reactions })
    }

    // Hide a conversation from THIS user's inbox (non-destructive). Records a
    // cleared_at for (me, peer); the inbox then suppresses that conversation
    // until a newer message arrives. Also marks any unread from that peer read
    // so the nav badge stays consistent. The messages are never deleted and the
    // other participant is unaffected.
    if (req.method === 'POST' && req.url === '/messages/clear') {
      const v = await verifyToken(req)
      if (v.error) return send(res, v.status, { error: v.error })
      const meId = v.uid
      const { peerId } = await readJson(req)
      if (!peerId || !_UUID_RE.test(peerId)) return send(res, 400, { error: 'valid peerId required' })
      const nowIso = new Date().toISOString()
      const { error } = await sb.from('prep_message_clears')
        .upsert({ user_id: meId, peer_id: peerId, cleared_at: nowIso }, { onConflict: 'user_id,peer_id' })
      if (error) return send(res, 500, { error: error.message })
      await sb.from('prep_messages').update({ read_at: nowIso })
        .eq('recipient_id', meId).eq('sender_id', peerId).is('read_at', null)
      await sb.from('prep_notifications').update({ read_at: nowIso })
        .eq('user_id', meId).is('read_at', null).eq('action->>page', 'messages')
      return send(res, 200, { ok: true })
    }

    // Conversation list (Messenger-style inbox). One row per peer the user has
    // exchanged messages with: decrypted last-message preview, timestamp, and
    // unread count. Only the server can preview bodies (encrypted at rest), and
    // only for the signed-in participant (verified by access token).
    if (req.method === 'POST' && req.url === '/messages/inbox') {
      const v = await verifyToken(req)
      if (v.error) return send(res, v.status, { error: v.error })
      const meId = v.uid
      const { data: rows, error } = await sb.from('prep_messages')
        .select('id, sender_id, recipient_id, body, e2ee, created_at, read_at, attachment_name')
        .or(`sender_id.eq.${meId},recipient_id.eq.${meId}`)
        .order('created_at', { ascending: false })
      if (error) return send(res, 500, { error: error.message })
      // Rows are newest-first, so the first time we see a peer is their latest.
      const convos = new Map()
      for (const m of (rows || [])) {
        const peerId = m.sender_id === meId ? m.recipient_id : m.sender_id
        if (!peerId) continue
        let c = convos.get(peerId)
        if (!c) {
          let preview, lastE2ee = false
          if (m.e2ee && m.body) {
            // Can't read it — hand the ciphertext to the client to decrypt for
            // the preview (it holds the only key).
            preview = m.body; lastE2ee = true
          } else {
            const decoded = m.body ? decryptBody(m.body) : ''
            if (decoded && /daily\.co\//.test(decoded)) preview = '📞 Call invite'
            else if (decoded && decoded.trim()) preview = decoded.trim().slice(0, 120)
            else if (m.attachment_name) preview = '📎 ' + m.attachment_name
            else preview = ''
          }
          c = { peerId, last_preview: preview, last_e2ee: lastE2ee, last_mine: m.sender_id === meId, last_at: m.created_at, unread: 0 }
          convos.set(peerId, c)
        }
        if (m.recipient_id === meId && !m.read_at) c.unread++
      }
      // Drop conversations this user has hidden, unless a newer message has
      // arrived since they cleared it. Defensive: if the clears table is absent
      // (migration not yet run), treat as no clears so the inbox still works.
      let clearMap = new Map()
      const { data: clears } = await sb.from('prep_message_clears')
        .select('peer_id, cleared_at').eq('user_id', meId)
      if (clears) clearMap = new Map(clears.map(r => [r.peer_id, r.cleared_at]))
      const list = Array.from(convos.values()).filter(c => {
        const cl = clearMap.get(c.peerId)
        return !cl || new Date(c.last_at) > new Date(cl)
      })
      if (list.length) {
        const ids = list.map(c => c.peerId)
        const { data: us } = await sb.from('prep_users').select('id, name, region, avatar_url, is_system').in('id', ids)
        // (room conversations added below carry their own identity — no lookup)
        const uMap = new Map((us || []).map(u => [u.id, u]))
        const { data: me } = await sb.from('prep_users').select('pcm_id').eq('id', meId).maybeSingle()
        const myPcmId = me?.pcm_id || null
        const { data: electors } = await sb.from('prep_users').select('id').eq('pcm_id', meId)
        const electorOf = new Set((electors || []).map(r => r.id))
        for (const c of list) {
          const u = uMap.get(c.peerId) || {}
          c.name = u.name || 'Member'
          c.region = u.region || ''
          c.avatar_url = u.avatar_url || null
          c.is_system = !!u.is_system
          c.role = c.is_system ? ''
                 : c.peerId === myPcmId ? 'Your Personal Contact Minister'
                 : electorOf.has(c.peerId) ? 'You are their PCM'
                 : 'Personal Contact Minister'
        }
      }
      // PCM Fellowship group room: every active PCM sees it in the inbox (even
      // before anyone has posted, so the room is discoverable). Defensive like
      // the clears table above: if the migration hasn't run yet, the room query
      // errors and we simply skip the row — DM conversations are unaffected.
      const { data: _amPcmInbox } = await sb.from('prep_pcms').select('id').eq('id', meId).eq('active', true).maybeSingle()
      if (_amPcmInbox) {
        const { data: lastArr, error: rmErr } = await sb.from('prep_room_messages')
          .select('sender_id, body, created_at, attachment_name')
          .eq('room_id', PCM_ROOM_ID)
          .order('created_at', { ascending: false }).limit(1)
        if (!rmErr) {
          const last = (lastArr || [])[0] || null
          let unread = 0
          if (last) {
            const { data: cursor } = await sb.from('prep_room_reads')
              .select('last_read_at').eq('user_id', meId).eq('room_id', PCM_ROOM_ID).maybeSingle()
            let cq = sb.from('prep_room_messages')
              .select('id', { count: 'exact', head: true })
              .eq('room_id', PCM_ROOM_ID).neq('sender_id', meId)
            if (cursor?.last_read_at) cq = cq.gt('created_at', cursor.last_read_at)
            const { count } = await cq
            unread = count || 0
          }
          let preview = ''
          let lastMine = false
          if (last) {
            lastMine = last.sender_id === meId
            const decoded = last.body ? decryptBody(last.body) : ''
            if (decoded && decoded.trim()) preview = decoded.trim().slice(0, 120)
            else if (last.attachment_name) preview = '📎 ' + last.attachment_name
            if (preview && !lastMine) {
              const { data: su } = await sb.from('prep_users').select('name').eq('id', last.sender_id).maybeSingle()
              const first = (su?.name || '').split(' ')[0]
              if (first) preview = first + ': ' + preview
            }
          }
          list.push({
            roomId: PCM_ROOM_ID, name: 'PCM Fellowship',
            role: 'All active Personal Contact Ministers', region: '',
            last_preview: preview, last_e2ee: false, last_mine: lastMine,
            last_at: last ? last.created_at : null, unread
          })
          // Keep newest-first ordering with the room row merged in; an empty
          // room (last_at null) sinks to the bottom.
          list.sort((a, b) => new Date(b.last_at || 0) - new Date(a.last_at || 0))
        }
      }
      return send(res, 200, { conversations: list })
    }

    // ─── PCM Fellowship group room ───────────────────────────────────────
    // One shared thread for all active PCMs (room_id 'pcm_fellowship').
    // Bodies use the same server-side at-rest encryption as legacy DMs; the
    // client renders sender names/avatars since the room has N participants.

    // Full room thread (newest 300), sender identities attached; bumps the
    // caller's read cursor so the unread badge clears.
    if (req.method === 'POST' && req.url === '/room/thread') {
      const v = await verifyToken(req)
      if (v.error) return send(res, v.status, { error: v.error })
      const meId = v.uid
      const { data: amPcm } = await sb.from('prep_pcms').select('id').eq('id', meId).eq('active', true).maybeSingle()
      if (!amPcm) return send(res, 403, { error: 'pcm_only' })
      // Newest 300, then reverse to chronological — .order(asc).limit() would
      // return the OLDEST 300 and pin a busy room to ancient history.
      const { data: rows, error } = await sb.from('prep_room_messages')
        .select('*').eq('room_id', PCM_ROOM_ID)
        .order('created_at', { ascending: false }).limit(300)
      if (error) return send(res, 500, { error: error.message })
      const ordered = (rows || []).reverse()
      const senderIds = [...new Set(ordered.map(m => m.sender_id))]
      let uMap = new Map()
      if (senderIds.length) {
        const { data: us } = await sb.from('prep_users').select('id, name, avatar_url').in('id', senderIds)
        uMap = new Map((us || []).map(u => [u.id, u]))
      }
      const messages = []
      for (const m of ordered) {
        const u = uMap.get(m.sender_id) || {}
        messages.push({
          id: m.id, sender_id: m.sender_id,
          sender_name: u.name || 'Member', sender_avatar: u.avatar_url || null,
          body: decryptBody(m.body), created_at: m.created_at,
          reactions: m.reactions || {},
          attachment_url: await signAttachment(m.attachment_url),
          attachment_name: m.attachment_name, attachment_type: m.attachment_type
        })
      }
      await sb.from('prep_room_reads')
        .upsert({ user_id: meId, room_id: PCM_ROOM_ID, last_read_at: new Date().toISOString() }, { onConflict: 'user_id,room_id' })
      return send(res, 200, { messages })
    }

    // Post to the room. No per-message push/bell fan-out (a busy room would be
    // a notification storm) — delivery is Realtime + the unread badge.
    if (req.method === 'POST' && req.url === '/room/send') {
      const v = await verifyToken(req)
      if (v.error) return send(res, v.status, { error: v.error })
      const meId = v.uid
      const { data: amPcm } = await sb.from('prep_pcms').select('id').eq('id', meId).eq('active', true).maybeSingle()
      if (!amPcm) return send(res, 403, { error: 'pcm_only' })
      const { body: msgBody, attachmentPath, attachmentName, attachmentType } = await readJson(req)
      const trimmedBody = (msgBody || '').trim()
      const attachVal = attachmentPath || null
      if (!trimmedBody && !attachVal) return send(res, 400, { error: 'a body or attachment is required' })
      const { error: insErr } = await sb.from('prep_room_messages').insert({
        room_id: PCM_ROOM_ID, sender_id: meId,
        body: encryptBody(trimmedBody || null),
        attachment_url: attachVal,
        attachment_name: attachmentName || null,
        attachment_type: attachmentType || null
      })
      if (insErr) return send(res, 500, { error: insErr.message })
      // The sender has plainly seen the room as of their own post.
      await sb.from('prep_room_reads')
        .upsert({ user_id: meId, room_id: PCM_ROOM_ID, last_read_at: new Date().toISOString() }, { onConflict: 'user_id,room_id' })
      return send(res, 200, { ok: true })
    }

    // Tap-back reaction on a room message — same model as /messages/react
    // ({ userId: emoji } map, one per user), participant check = active PCM.
    if (req.method === 'POST' && req.url === '/room/react') {
      const v = await verifyToken(req)
      if (v.error) return send(res, v.status, { error: v.error })
      const meId = v.uid
      const { data: amPcm } = await sb.from('prep_pcms').select('id').eq('id', meId).eq('active', true).maybeSingle()
      if (!amPcm) return send(res, 403, { error: 'pcm_only' })
      const { messageId, emoji } = await readJson(req)
      if (messageId == null || !/^\d+$/.test(String(messageId))) return send(res, 400, { error: 'valid messageId required' })
      const ALLOWED = ['❤️', '😆', '😮', '😢', '😠', '👍']
      if (emoji != null && !ALLOWED.includes(emoji)) return send(res, 400, { error: 'unsupported_emoji' })
      const { data: msg } = await sb.from('prep_room_messages')
        .select('id, reactions').eq('id', messageId).eq('room_id', PCM_ROOM_ID).maybeSingle()
      if (!msg) return send(res, 404, { error: 'message_not_found' })
      const reactions = (msg.reactions && typeof msg.reactions === 'object') ? msg.reactions : {}
      if (!emoji || reactions[meId] === emoji) delete reactions[meId]
      else reactions[meId] = emoji
      const { error: upErr } = await sb.from('prep_room_messages').update({ reactions }).eq('id', messageId)
      if (upErr) return send(res, 500, { error: upErr.message })
      return send(res, 200, { ok: true, reactions })
    }

    // Admin: message METADATA only (who/when, attachment name) — never the
    // body. Private messages are end-to-end encrypted; the server itself can't
    // read them, so there is no admin path to message text.
    if (req.method === 'POST' && req.url === '/admin/messages-meta') {
      const a = await requireAdmin(req)
      if (a.error) return send(res, a.status, { error: a.error })
      const { data: rows, error } = await sb.from('prep_messages')
        .select('id, sender_id, recipient_id, created_at, read_at, attachment_name, body, e2ee')
        .order('created_at', { ascending: false }).limit(200)
      if (error) return send(res, 500, { error: error.message })
      const messages = (rows || []).map(m => ({
        id: m.id, sender_id: m.sender_id, recipient_id: m.recipient_id,
        created_at: m.created_at, read_at: m.read_at,
        has_body: m.body != null, encrypted: m.e2ee ? true : isEncrypted(m.body), e2ee: !!m.e2ee,
        has_attachment: !!m.attachment_name, attachment_name: m.attachment_name
      }))
      return send(res, 200, { messages })
    }

    // (Admin break-glass message decryption was removed: private messages are
    // now end-to-end encrypted and the server holds no key to read them.)

    // Admin one-time migration: encrypt any legacy plaintext message bodies.
    // Idempotent — already-encrypted rows are skipped.
    if (req.method === 'POST' && req.url === '/admin/migrate-encrypt-messages') {
      const a = await requireAdmin(req)
      if (a.error) return send(res, a.status, { error: a.error })
      if (!_MSG_KEY) return send(res, 400, { error: 'MESSAGE_ENC_KEY not set' })
      const { data: rows, error } = await sb.from('prep_messages').select('id, body').not('body', 'is', null)
      if (error) return send(res, 500, { error: error.message })
      let migrated = 0
      for (const m of (rows || [])) {
        if (isEncrypted(m.body)) continue
        const { error: upErr } = await sb.from('prep_messages').update({ body: encryptBody(m.body) }).eq('id', m.id)
        if (!upErr) migrated++
      }
      return send(res, 200, { ok: true, scanned: (rows || []).length, migrated })
    }

    // ─── Paul chat history is now operator-blind (changed 2026-06-25) ───────
    // The break-glass reveal + encrypt-migration endpoints were removed. Paul
    // message bodies are no longer persisted (see the prep_paul_chats inserts in
    // the chat handlers — we store role + timestamp only), so there is nothing
    // to decrypt, reveal, or migrate. prep_admin_audit remains for any future
    // audited admin actions.

    if (req.method === 'POST' && req.url === '/peers') {
      const v = await verifyToken(req)
      if (v.error) return send(res, v.status, { error: v.error })
      const userId = v.uid
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
      // 3) if I'm an active PCM, every other active PCM is reachable.
      //    Status = Matched (has at least one elector) vs Available (none yet).
      const { data: amPcm } = await sb.from('prep_pcms').select('id').eq('id', userId).eq('active', true).maybeSingle()
      if (amPcm) {
        const { data: pcms } = await sb.from('prep_pcms').select('id, name, region').eq('active', true)
        const { data: matchedRows } = await sb.from('prep_users').select('pcm_id').not('pcm_id', 'is', null)
        const matched = new Set((matchedRows || []).map(r => r.pcm_id))
        for (const p of (pcms || [])) {
          if (p.id === userId) continue
          if (peers.find(x => x.id === p.id)) continue
          peers.push({ ...p, role: matched.has(p.id) ? 'PCM · Matched' : 'Volunteer PCM · Available' })
        }
      }
      // Attach each peer's profile photo (avatar_url lives on prep_users).
      if (peers.length) {
        const ids = peers.map(p => p.id)
        const { data: avs } = await sb.from('prep_users').select('id, avatar_url').in('id', ids)
        const avMap = new Map((avs || []).map(r => [r.id, r.avatar_url]))
        for (const p of peers) p.avatar_url = avMap.get(p.id) || null
      }
      return send(res, 200, { peers })
    }

    // Pick the most relevant townhall: prefer the one currently live, else
    // the next upcoming, else the most recent past.
    async function pickTownhall() {
      // Only treat a townhall as the active "live" one if it went live within
      // its run window. This way a row the auto-close cron missed (ended_at
      // still null) can't stay pinned as live and mask the next scheduled
      // townhall — the UI self-heals at the duration boundary regardless.
      const liveFloor = new Date(Date.now() - TOWNHALL_AUTOCLOSE_MS).toISOString()
      const { data: live } = await sb.from('prep_townhalls').select('*')
        .not('live_at', 'is', null).is('ended_at', null).gte('live_at', liveFloor)
        .order('live_at', { ascending: false }).limit(1).maybeSingle()
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

    if (req.method === 'POST' && req.url === '/webhooks/daily') {
      // Daily.co fires this when a recording is ready. We match the
      // townhall row by room_name and write the playback URL into
      // prep_townhalls.recording_url so the admin log + the home
      // 'Replay last townhall' button pick it up automatically.
      const raw = await new Promise((resolve, reject) => {
        let body = ''
        req.on('data', c => { body += c; if (body.length > 1e6) { req.destroy(); reject(new Error('payload too large')) } })
        req.on('end', () => resolve(body))
        req.on('error', reject)
      })
      // Optional HMAC verification — Daily signs the body with the secret you
      // configure in their dashboard. If DAILY_WEBHOOK_SECRET isn't set,
      // accept the event (dev mode); set it in Render env once you've
      // configured a signing secret in Daily.
      if (process.env.DAILY_WEBHOOK_SECRET) {
        const crypto = require('crypto')
        const sig = req.headers['x-webhook-signature'] || req.headers['x-daily-signature'] || ''
        const ts  = req.headers['x-webhook-timestamp'] || ''
        const expected = crypto
          .createHmac('sha256', process.env.DAILY_WEBHOOK_SECRET)
          .update(ts + '.' + raw)
          .digest('base64')
        if (sig !== expected) {
          console.warn('[daily-webhook] signature mismatch')
          return send(res, 401, { error: 'bad_signature' })
        }
      }
      let evt = {}
      try { evt = JSON.parse(raw) } catch (_) {}
      const type = evt.type || evt.event || ''
      if (!/recording\.?ready/i.test(type)) {
        return send(res, 200, { ok: true, ignored: type })
      }
      // Daily's payload shape varies slightly across versions. Common fields:
      //   evt.payload.room_name, evt.payload.s3_url, evt.payload.recording_id
      const payload = evt.payload || evt.data || evt
      const roomName = payload.room_name || payload.roomName || evt.room_name
      const directUrl = payload.s3_url || payload.download_link || payload.url || null
      if (!roomName) return send(res, 400, { error: 'no_room_name' })

      // If the webhook didn't include a direct URL, ask Daily's REST API for
      // the most recent recording for this room and use its access link.
      let recordingUrl = directUrl
      if (!recordingUrl && process.env.DAILY_API_KEY) {
        try {
          const r = await fetch(`https://api.daily.co/v1/recordings?room_name=${encodeURIComponent(roomName)}&limit=1`, {
            headers: { 'Authorization': `Bearer ${process.env.DAILY_API_KEY}` }
          })
          const j = await r.json()
          const rec = (j && j.data && j.data[0]) || null
          if (rec && rec.id) {
            const lr = await fetch(`https://api.daily.co/v1/recordings/${rec.id}/access-link`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${process.env.DAILY_API_KEY}` }
            })
            const lj = await lr.json()
            if (lj && lj.download_link) recordingUrl = lj.download_link
          }
        } catch (e) { console.warn('[daily-webhook] api lookup failed', e) }
      }
      if (!recordingUrl) return send(res, 200, { ok: false, reason: 'no_url_resolved' })

      // Update the townhall row matching this room
      const { error } = await sb.from('prep_townhalls')
        .update({ recording_url: recordingUrl })
        .eq('daily_room', roomName)
      if (error) console.warn('[daily-webhook] update failed', error)
      console.log('[daily-webhook] recording.ready for', roomName, '→ url stored')
      return send(res, 200, { ok: true })
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

    if (req.method === 'POST' && req.url === '/account/delete') {
      // Self-serve account deletion. The id ALWAYS comes from the caller's
      // verified token (never the request body), so a member can only ever
      // delete their own account. Deleting from auth.users cascades to
      // prep_users and every prep_* table via FK ON DELETE CASCADE.
      const v = await verifyToken(req)
      if (v.error) return send(res, v.status, { error: v.error })
      const userId = v.uid

      // If this person is an active PCM, let every member who chose them know
      // to pick a new Personal Contact Minister. We read the member list while
      // their pcm_id still points here; the delete below nulls it (SET NULL).
      try {
        const { data: members } = await sb.from('prep_users')
          .select('id, name, email').eq('pcm_id', userId)
        if (members && members.length) {
          const { data: me } = await sb.from('prep_users').select('name').eq('id', userId).maybeSingle()
          const pcmName = (me && me.name) || 'Your Personal Contact Minister'
          for (const m of members) {
            await sendSystemMessage(m.id,
              pcmName + ', who had been walking alongside you as your Personal Contact Minister, has closed their account. When you have a quiet moment, please choose a new Personal Contact Minister so someone can continue this preparation with you.')
            if (m.email) {
              await sendEmail(m.email, 'Please choose a new Personal Contact Minister',
                emailWrap('A change in your preparation',
                  '<p>' + pcmName + ', who had been walking alongside you as your Personal Contact Minister, has closed their account.</p>' +
                  '<p>When you have a quiet moment, please open Preparing You and choose a new Personal Contact Minister so you can continue your preparation with a companion.</p>',
                  'Open Preparing You', 'https://preparingyou.app'))
            }
          }
        }
      } catch (e) { console.warn('[account/delete] member-notify failed', (e && e.message) || e) }

      // Delete from auth.users — FK cascade cleans up prep_users and all prep_*.
      const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
        method: 'DELETE',
        headers: { 'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY }
      })
      if (!r.ok) return send(res, 500, { error: 'auth_delete_failed', status: r.status, body: await r.text() })
      return send(res, 200, { ok: true })
    }

    if (req.method === 'POST' && req.url === '/admin/update-email') {
      // Change a member's LOGIN email (for people who lost access to their old
      // address). Updates auth.users.email (the actual sign-in identifier) AND
      // the prep_users.email mirror used for notifications. The password is NOT
      // touched — they sign in with the new email + their existing password.
      // We mark the new email confirmed so they can log in immediately without
      // a confirmation link (which they could not receive at the old address).
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

      const body = await readJson(req)
      const userId = body.userId
      const email = (body.email || '').trim().toLowerCase()
      if (!userId) return send(res, 400, { error: 'userId required' })
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res, 400, { error: 'invalid_email' })

      // 1) Update the auth account's email (login identifier), confirmed.
      const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
        method: 'PUT',
        headers: {
          'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email, email_confirm: true })
      })
      if (!r.ok) {
        const txt = await r.text()
        // Supabase returns 422 when the email is already used by another account.
        if (r.status === 422 || /already/i.test(txt)) return send(res, 409, { error: 'email_in_use' })
        return send(res, 500, { error: 'auth_update_failed', status: r.status, body: txt })
      }
      // 2) Keep the notification mirror in sync.
      await sb.from('prep_users').update({ email }).eq('id', userId)
      return send(res, 200, { ok: true, email })
    }

    if (req.method === 'POST' && req.url === '/admin/broadcast') {
      // One-way announcement from an admin to every user: bell notification
      // + web-push to all devices, plus a row in prep_broadcasts (history).
      const auth = req.headers['authorization'] || ''
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
      if (!token) return send(res, 401, { error: 'no_token' })
      const callerSb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        global: { headers: { Authorization: 'Bearer ' + token } },
        auth: { persistSession: false }
      })
      const { data: cu } = await callerSb.auth.getUser(token)
      const callerId = cu?.user?.id
      if (!callerId) return send(res, 401, { error: 'invalid_token' })
      const { data: adminRow } = await sb.from('prep_admins').select('user_id').eq('user_id', callerId).maybeSingle()
      if (!adminRow) return send(res, 403, { error: 'not_admin' })

      const body = await readJson(req)
      const text = (body.text || '').trim()
      if (!text) return send(res, 400, { error: 'text_required' })
      const icon = (body.icon || '📢').trim() || '📢'

      // Optional recipient filter. When userIds is a non-empty array the message
      // goes only to those users (validated against prep_users); otherwise it
      // goes to everyone. The system account itself is always excluded.
      const wantIds = Array.isArray(body.userIds)
        ? [...new Set(body.userIds.filter(id => typeof id === 'string'))]
        : null
      const alsoEmail = body.email === true
      let q = sb.from('prep_users').select('id, name, email').eq('is_system', false)
      if (wantIds) {
        if (!wantIds.length) return send(res, 400, { error: 'no_recipients' })
        q = q.in('id', wantIds)
      }
      const { data: users } = await q
      const list = users || []
      if (!list.length) return send(res, 400, { error: 'no_recipients' })

      // Deliver as a one-way message from the "Preparing You" system account so
      // it lands in each member's Messages inbox (read-only — the member app
      // hides the reply box for this sender). The prep_messages INSERT trigger
      // creates the bell notification automatically, so we don't add one here.
      const systemId = await ensureSystemUser()
      const encBody = encryptBody(text)
      const msgRows = list.map(u => ({ sender_id: systemId, recipient_id: u.id, body: encBody, e2ee: false }))
      for (let i = 0; i < msgRows.length; i += 100) {
        await sb.from('prep_messages').insert(msgRows.slice(i, i + 100))
      }
      // Web-push fanout (best-effort) — opens the Messages page on tap.
      const preview = text.length > 60 ? text.slice(0, 60) + '…' : text
      await Promise.allSettled(list.map(u => pushToUser(u.id, {
        icon: '💬', text: _SYSTEM_NAME + ': ' + preview, action: { type: 'page', page: 'messages' }
      })))
      // History row (keeps the admin's "Recent broadcasts" log).
      await sb.from('prep_broadcasts').insert({ sender_id: callerId, icon, text, recipient_count: list.length })

      // Optional: also deliver the broadcast as a plain email. Fire-and-forget,
      // sequential with a small delay to respect EmailJS rate limits, so a large
      // recipient list never holds the admin's request open or times it out.
      if (alsoEmail) {
        ;(async () => {
          let sent = 0
          for (const u of list) {
            if (!u.email) continue
            const greet = u.name ? `Peace to you, ${u.name}.` : 'Peace to you.'
            const message = `${greet}\n\n${text}\n\nOpen Preparing You: https://preparingyou.app`
            const result = await sendEmailJS(u.name || 'Friend', u.email, 'A message from Preparing You', message)
            if (result.ok) sent++
            else console.warn(`[broadcast] email to ${u.email} failed:`, result)
            await new Promise(r => setTimeout(r, 200))
          }
          console.log(`[broadcast] emailed ${sent}/${list.length} user(s)`)
        })().catch(e => console.error('[broadcast] email fanout', e))
      }

      return send(res, 200, { ok: true, recipients: list.length, emailQueued: alsoEmail })
    }

    if (req.method === 'POST' && req.url === '/townhall/reminders/run') {
      const a = await requireAdmin(req)
      if (a.error) return send(res, a.status, { error: a.error })
      // Manual trigger — useful for ops/debugging the cron
      runTownhallReminders().catch(e => console.error('manual reminder', e))
      return send(res, 200, { ok: true, triggered: true })
    }

    if (req.method === 'POST' && req.url === '/townhall/announcements/run') {
      const a = await requireAdmin(req)
      if (a.error) return send(res, a.status, { error: a.error })
      // Manual / fire-and-forget trigger from the admin app right after a
      // townhall is created or rescheduled, so the "new townhall set" email
      // goes out immediately rather than waiting for the 5-min cron tick.
      runTownhallAnnouncements().catch(e => console.error('manual announce', e))
      return send(res, 200, { ok: true, triggered: true })
    }

    if (req.method === 'GET' && req.url === '/townhall/schedule') {
      const v = await requireAdmin(req)
      if (v.error) return send(res, v.status, { error: v.error })
      const { data } = await sb.from('prep_townhall_schedule').select('*').eq('id', 1).maybeSingle()
      return send(res, 200, { schedule: data || null })
    }

    if (req.method === 'POST' && req.url === '/townhall/schedule') {
      const v = await requireAdmin(req)
      if (v.error) return send(res, v.status, { error: v.error })
      const b = await readJson(req)
      // Coerce + clamp the rule fields defensively.
      const clamp = (n, lo, hi, d) => { n = parseInt(n, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d }
      const rule = {
        id: 1,
        enabled: !!b.enabled,
        weekday: clamp(b.weekday, 0, 6, 6),
        hour: clamp(b.hour, 0, 23, 12),
        minute: clamp(b.minute, 0, 59, 0),
        timezone: (typeof b.timezone === 'string' && b.timezone.trim()) || 'America/New_York',
        title: (typeof b.title === 'string' && b.title.trim()) || 'Weekly Townhall',
        topic: (typeof b.topic === 'string' && b.topic.trim()) || 'Open discussion',
        updated_at: new Date().toISOString()
      }
      const { error } = await sb.from('prep_townhall_schedule').upsert(rule, { onConflict: 'id' })
      if (error) return send(res, 500, { error: error.message })
      // Drop any future recurring rows that haven't started yet — the rule
      // changed, so they'll be regenerated from the new rule below.
      await sb.from('prep_townhalls')
        .delete()
        .eq('source', 'recurring')
        .is('live_at', null)
        .gt('scheduled_at', new Date().toISOString())
      // Materialise the next occurrence immediately (if enabled).
      runTownhallRecurrence().catch(e => console.error('schedule recurrence', e))
      return send(res, 200, { ok: true, schedule: rule })
    }

    if (req.method === 'GET' && req.url === '/townhall/state') {
      const th = await pickTownhall()
      const now = Date.now()
      // Time-bound so a missed auto-close doesn't show a perpetual LIVE banner:
      // a townhall reads as live only within its run window from live_at.
      const isLive = !!(th && th.live_at && !th.ended_at &&
        (now - new Date(th.live_at).getTime() < TOWNHALL_AUTOCLOSE_MS))
      const isUpcoming = !!(th && !th.live_at && !th.ended_at &&
        new Date(th.scheduled_at).getTime() >= now)
      // A live or still-upcoming materialized townhall is shown directly.
      if (th && (isLive || isUpcoming)) {
        return send(res, 200, {
          id: th.id, scheduled_at: th.scheduled_at, title: th.title, topic: th.topic,
          live_at: th.live_at, ended_at: th.ended_at, isLive
        })
      }
      // Otherwise pickTownhall only found a past/ended townhall (or nothing).
      // Rather than show a stale past time, compute the next occurrence from the
      // recurring rule and return it as a preview, so the card always shows when
      // the next townhall is — even before the row is materialized (~4 days out).
      const { data: rule } = await sb.from('prep_townhall_schedule').select('*').eq('id', 1).maybeSingle()
      if (rule && rule.enabled) {
        const nextMs = nextOccurrence(rule, now)
        if (nextMs) {
          return send(res, 200, {
            id: null, preview: true,
            scheduled_at: new Date(nextMs).toISOString(),
            title: rule.title || 'Weekly Townhall',
            topic: rule.topic || 'Open discussion',
            live_at: null, ended_at: null, isLive: false
          })
        }
      }
      // No rule and no upcoming row — fall back to the past one (the replay
      // button is fetched separately), or 404 if there's truly nothing.
      if (!th) return send(res, 404, { error: 'no townhall' })
      return send(res, 200, {
        id: th.id, scheduled_at: th.scheduled_at, title: th.title, topic: th.topic,
        live_at: th.live_at, ended_at: th.ended_at, isLive: false
      })
    }

    if (req.method === 'POST' && req.url === '/townhall/start') {
      const v = await verifyToken(req)
      if (v.error) return send(res, v.status, { error: v.error })
      const { userName } = await readJson(req)
      if (!await isHost(v.uid)) return send(res, 403, { error: 'host_only' })
      const th = await pickTownhall()
      if (!th) return send(res, 404, { error: 'no townhall' })
      const room = await dailyEnsureRoom(th.daily_room || 'preparing-you-townhall', { properties: { enable_recording: 'cloud' } })
      const token = await dailyMintToken(th.daily_room || 'preparing-you-townhall', { userName, isOwner: true, startRecording: true })
      await sb.from('prep_townhalls').update({ live_at: new Date().toISOString(), ended_at: null }).eq('id', th.id)
      return send(res, 200, { url: `${room.url}?t=${token}`, isOwner: true })
    }

    if (req.method === 'POST' && req.url === '/townhall/end') {
      const v = await verifyToken(req)
      if (v.error) return send(res, v.status, { error: v.error })
      if (!await isHost(v.uid)) return send(res, 403, { error: 'host_only' })
      const th = await pickTownhall()
      if (!th) return send(res, 404, { error: 'no townhall' })
      await sb.from('prep_townhalls').update({ ended_at: new Date().toISOString() }).eq('id', th.id)
      return send(res, 200, { ok: true })
    }

    if (req.method === 'POST' && req.url === '/townhall/join') {
      const v = await verifyToken(req)
      if (v.error) return send(res, v.status, { error: v.error })
      const { userName } = await readJson(req)
      const th = await pickTownhall()
      if (!th) return send(res, 404, { error: 'no townhall' })
      const owner = await isHost(v.uid)
      const isLive = !!th.live_at && !th.ended_at
      // Non-hosts may only join after a moderator has started the call.
      if (!isLive && !owner) return send(res, 403, { error: 'not_started', message: 'The townhall has not started yet. Please wait for a moderator to begin.' })
      const room = await dailyEnsureRoom(th.daily_room || 'preparing-you-townhall', { properties: { enable_recording: 'cloud' } })
      // Carry start_cloud_recording so the first person in (host or not) kicks off
      // the recording — keeps "Replay last townhall" working for auto-opened calls.
      const token = await dailyMintToken(th.daily_room || 'preparing-you-townhall', { userName, isOwner: owner, startRecording: true })
      // If a host joins the join endpoint while not yet live, treat that as starting it.
      if (!isLive && owner) {
        await sb.from('prep_townhalls').update({ live_at: new Date().toISOString(), ended_at: null }).eq('id', th.id)
      }
      return send(res, 200, { url: `${room.url}?t=${token}`, scheduled_at: th.scheduled_at, title: th.title, topic: th.topic, isOwner: owner })
    }

    send(res, 404, { error: 'not_found' })
  } catch (e) {
    console.error('[err]', e)
    logError('server', { kind: 'http_500', message: e && e.message, stack: e && e.stack, url: (req.method || '') + ' ' + (req.url || '') })
    send(res, 500, { error: e.message || 'internal_error' })
  }
})

server.listen(PORT, () => {
  console.log(`[preparing-you] listening on :${PORT}`)
})

// ─── Townhall timezone helpers ──────────────────────────────────────────
// The townhall is one shared live moment, so delivery can't be per-zone —
// but the DISPLAYED start time in each member's email CAN be rendered in
// their own local time when we know their IANA zone (prep_users.timezone).
const TOWNHALL_HOST_TZ = process.env.TOWNHALL_TZ || 'America/New_York'

// Format an ISO instant in a given IANA zone, e.g. "Saturday, Jun 6 at 12:00 PM EDT".
// Falls back to the host zone if `tz` is missing or invalid.
function fmtLocal(iso, tz) {
  const d = new Date(iso)
  const tryZone = (zone) => new Intl.DateTimeFormat('en-US', {
    timeZone: zone, weekday: 'long', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
  }).formatToParts(d)
  let parts
  try { parts = tryZone(tz || TOWNHALL_HOST_TZ) }
  catch (e) { parts = tryZone(TOWNHALL_HOST_TZ) }
  const get = (t) => (parts.find(p => p.type === t) || {}).value || ''
  const wd = get('weekday'), mo = get('month'), day = get('day')
  const hh = get('hour'), mm = get('minute'), dp = get('dayPeriod'), zn = get('timeZoneName')
  return `${wd}, ${mo} ${day} at ${hh}:${mm} ${dp} ${zn}`.replace(/\s+/g, ' ').trim()
}

// True if `tz` resolves to a usable zone.
function _tzValid(tz) {
  if (!tz) return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch (e) { return false }
}

// DST-safe local-time → UTC conversion for recurrence math.
// Returns the millisecond offset (utc = local - offset) for a given instant in a zone.
function tzOffsetMs(utcMs, tz) {
  const d = new Date(utcMs)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(d)
  const g = (t) => parseInt((parts.find(p => p.type === t) || {}).value, 10)
  let hour = g('hour'); if (hour === 24) hour = 0
  const asUTC = Date.UTC(g('year'), g('month') - 1, g('day'), hour, g('minute'), g('second'))
  return asUTC - utcMs
}

// Given a wall-clock Y/M/D H:M in zone `tz`, return the UTC epoch ms.
function zonedTimeToUtc(y, m, d, h, min, tz) {
  // First guess: treat the wall clock as if it were UTC, then correct by the
  // offset at that instant. Re-evaluate once to settle DST boundaries.
  let guess = Date.UTC(y, m - 1, d, h, min, 0)
  let off = tzOffsetMs(guess, tz)
  let utc = guess - off
  off = tzOffsetMs(utc, tz)
  return guess - off
}

// The Y/M/D + weekday of an instant as seen in zone `tz`.
function localYMD(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'
  }).formatToParts(date)
  const g = (t) => (parts.find(p => p.type === t) || {}).value
  const wdMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return { y: parseInt(g('year'), 10), m: parseInt(g('month'), 10), d: parseInt(g('day'), 10), wd: wdMap[g('weekday')] }
}

// Next UTC ms at which the rule (weekday/hour/minute in rule.timezone) fires
// strictly after `fromMs`. Iterates up to 14 days to clear DST/skip edge cases.
function nextOccurrence(rule, fromMs) {
  const tz = _tzValid(rule.timezone) ? rule.timezone : TOWNHALL_HOST_TZ
  for (let i = 0; i <= 14; i++) {
    const probe = new Date(fromMs + i * 86400000)
    const { y, m, d, wd } = localYMD(probe, tz)
    if (wd !== rule.weekday) continue
    const utc = zonedTimeToUtc(y, m, d, rule.hour, rule.minute, tz)
    if (utc > fromMs) return utc
  }
  return null
}

// ─── Townhall reminder cron ─────────────────────────────────────────────
// Every 5 minutes, find any townhall scheduled within the next 30 minutes
// that hasn't had its reminder sent yet. Send everyone a bell-notification
// AND an email (in each member's local time). Stamp reminder_sent_at.
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

      const { data: users } = await sb.from('prep_users').select('id, name, email, timezone')
      const list = users || []

      // 1) Inbox message from "Preparing You" — lands in Messages so the
      //    unread-message badge clears when the member opens it.
      await townhallInboxBroadcast(text)

      // 2) Emails via EmailJS REST — sequential with small delay
      const subject = `${title} starts in ${minsAway} minutes`
      const topicLine = th.topic ? `\n\n${title} — ${th.topic}` : `\n\n${title}`
      for (const u of list) {
        if (u.email) {
          const greet = u.name ? `Peace to you, ${u.name}.` : 'Peace to you.'
          const whenLine = `Your local start time: ${fmtLocal(th.scheduled_at, u.timezone)}.`
          const message =
`${greet}

The townhall begins in ${minsAway} minutes.${topicLine}

${whenLine}

When the moderator opens the call, a "Townhall is live" banner will appear across the app. Tap it to join.

Open Preparing You: https://preparingyou.app`
          const result = await sendEmailJS(u.name || 'Friend', u.email, subject, message)
          if (!result.ok) console.warn(`[townhall-cron] email to ${u.email} failed:`, result)
          await new Promise(r => setTimeout(r, 200))
        }
      }

      await sb.from('prep_townhalls').update({ reminder_sent_at: new Date().toISOString() }).eq('id', th.id)
      console.log(`[townhall-cron] sent reminders for townhall ${th.id} to ${list.length} users`)
    }
  } catch (e) {
    console.error('[townhall-cron]', e)
  }
}

// ─── Townhall announcement cron ─────────────────────────────────────────
// As soon as a townhall is created (or rescheduled), notify everyone once:
// bell + email showing each member's local start time. Stamped announced_at.
// We only announce townhalls that are still in the future and haven't started.
async function runTownhallAnnouncements() {
  try {
    const nowIso = new Date().toISOString()
    const { data: ths, error } = await sb.from('prep_townhalls')
      .select('id, scheduled_at, title, topic')
      .gt('scheduled_at', nowIso)
      .is('announced_at', null)
      .is('live_at', null)
    if (error) { console.warn('[townhall-announce] query failed', error); return }
    if (!ths || !ths.length) return

    for (const th of ths) {
      const title = th.title || 'Weekly Townhall'
      const text = `🎙 New townhall set: ${title}` + (th.topic ? ` — ${th.topic}` : '')

      const { data: users } = await sb.from('prep_users').select('id, name, email, timezone')
      const list = users || []

      // 1) Inbox message from "Preparing You" — lands in Messages so the
      //    unread-message badge clears when the member opens it.
      await townhallInboxBroadcast(text)

      // 2) Emails via EmailJS — each in the member's local time
      const subject = `New townhall set: ${title}`
      const topicLine = th.topic ? `\n\n${title} — ${th.topic}` : `\n\n${title}`
      for (const u of list) {
        if (u.email) {
          const greet = u.name ? `Peace to you, ${u.name}.` : 'Peace to you.'
          const message =
`${greet}

A new townhall has been scheduled.${topicLine}

Your local start time: ${fmtLocal(th.scheduled_at, u.timezone)}.

We'll send a reminder shortly before it begins, and a "Townhall is live" banner will appear across the app when the moderator opens the call.

Open Preparing You: https://preparingyou.app`
          const result = await sendEmailJS(u.name || 'Friend', u.email, subject, message)
          if (!result.ok) console.warn(`[townhall-announce] email to ${u.email} failed:`, result)
          await new Promise(r => setTimeout(r, 200))
        }
      }

      await sb.from('prep_townhalls').update({ announced_at: new Date().toISOString() }).eq('id', th.id)
      console.log(`[townhall-announce] announced townhall ${th.id} to ${list.length} users`)
    }
  } catch (e) {
    console.error('[townhall-announce]', e)
  }
}

// ─── Townhall recurrence cron ───────────────────────────────────────────
// Reads the single standing-rule row. If enabled, ensures the next occurrence
// exists as a prep_townhalls row (source='recurring') — but only once we're
// within RECUR_LEAD_DAYS of that occurrence, so members get the announcement a
// few days out rather than a full week early. The announcement cron then picks
// the new row up and emails everyone. Runs hourly + on boot.
const RECUR_LEAD_DAYS = parseInt(process.env.TOWNHALL_RECUR_LEAD_DAYS || '4', 10)
const RECUR_LEAD_MS = RECUR_LEAD_DAYS * 86400000

async function runTownhallRecurrence() {
  try {
    const { data: rule } = await sb.from('prep_townhall_schedule').select('*').eq('id', 1).maybeSingle()
    if (!rule || !rule.enabled) return

    const nextMs = nextOccurrence(rule, Date.now())
    if (!nextMs) { console.warn('[townhall-recur] no occurrence found for rule', rule); return }

    // Hold off until we're inside the lead window. The next hourly tick that
    // crosses the threshold will create + announce it.
    if (nextMs - Date.now() > RECUR_LEAD_MS) return

    const scheduledAt = new Date(nextMs).toISOString()

    // Already have a townhall at (or extremely near) that instant? Skip.
    const lo = new Date(nextMs - 60000).toISOString()
    const hi = new Date(nextMs + 60000).toISOString()
    const { data: existing } = await sb.from('prep_townhalls')
      .select('id')
      .gte('scheduled_at', lo)
      .lte('scheduled_at', hi)
      .limit(1)
    if (existing && existing.length) return

    const room = 'preparing-you-townhall-' + Date.now().toString(36)
    const { error } = await sb.from('prep_townhalls').insert({
      scheduled_at: scheduledAt,
      title: rule.title || 'Weekly Townhall',
      topic: rule.topic || 'Open discussion',
      daily_room: room,
      source: 'recurring'
    })
    if (error) { console.warn('[townhall-recur] insert failed', error); return }
    console.log(`[townhall-recur] created recurring townhall for ${scheduledAt}`)
    // Announce it now rather than waiting for the next announce tick.
    runTownhallAnnouncements().catch(e => console.error('recur announce', e))
  } catch (e) {
    console.error('[townhall-recur]', e)
  }
}

// ─── Townhall auto-start / auto-close ───────────────────────────────────
// A townhall opens by itself at its scheduled time and closes itself 120
// minutes later, so no host has to log in and press Start. The first person to
// join triggers cloud recording (see start_cloud_recording on the join token),
// so the replay is captured even when no moderator is present.
const TOWNHALL_AUTOCLOSE_MS = 120 * 60 * 1000

async function runTownhallAutostart() {
  try {
    const now = Date.now()
    const nowIso = new Date(now).toISOString()
    // Open townhalls whose start time has arrived (within the auto-close window,
    // so we never resurrect an old one that was scheduled but never held) and
    // that aren't already live or ended.
    const { data: ths, error } = await sb.from('prep_townhalls')
      .select('id, daily_room, title, topic, scheduled_at')
      .lte('scheduled_at', nowIso)
      .gte('scheduled_at', new Date(now - TOWNHALL_AUTOCLOSE_MS).toISOString())
      .is('live_at', null)
      .is('ended_at', null)
    if (error) { console.warn('[townhall-autostart] query failed', error); return }
    if (!ths || !ths.length) return

    for (const th of ths) {
      const roomName = th.daily_room || 'preparing-you-townhall'
      // Ensure the room exists with cloud recording enabled, then mark it live.
      await dailyEnsureRoom(roomName, { properties: { enable_recording: 'cloud' } })
      await sb.from('prep_townhalls').update({ live_at: nowIso, ended_at: null }).eq('id', th.id)

      // Announce it's live — inbox message + web push (fires once: live_at is
      // now set). The push opens Home to join; the message lets the unread-
      // message badge clear when the member opens it.
      const title = th.title || 'Weekly Townhall'
      const text = `🎙 ${title} is live now — join from the home screen` + (th.topic ? ` — ${th.topic}` : '')
      await townhallInboxBroadcast(text, { push: true, pushAction: { type: 'page', page: 'home' } })
      console.log(`[townhall-autostart] opened townhall ${th.id} (${roomName}) and messaged members`)
    }
  } catch (e) {
    console.error('[townhall-autostart]', e)
  }
}

async function runTownhallAutoclose() {
  try {
    const cutoff = new Date(Date.now() - TOWNHALL_AUTOCLOSE_MS).toISOString()
    // Close any townhall that went live and is past its run window and hasn't
    // been ended — covers both auto-opened calls and ones a host started but
    // forgot to end. The query has no lower bound on live_at, so even a townhall
    // the cron missed earlier (server redeploy, transient error) gets swept on a
    // later tick rather than staying "live" forever.
    const { data: ths, error } = await sb.from('prep_townhalls')
      .select('id')
      .not('live_at', 'is', null)
      .is('ended_at', null)
      .lte('live_at', cutoff)
    if (error) { console.warn('[townhall-autoclose] query failed', error); return }
    if (!ths || !ths.length) return
    const mins = Math.round(TOWNHALL_AUTOCLOSE_MS / 60000)
    for (const th of ths) {
      await sb.from('prep_townhalls').update({ ended_at: new Date().toISOString() }).eq('id', th.id)
      console.log(`[townhall-autoclose] closed townhall ${th.id} (${mins}m after it went live)`)
    }
    // A townhall just ended — make sure the next occurrence is scheduled and
    // announced now rather than waiting up to an hour for the recurrence tick.
    // (Idempotent + lead-gated, so it's a no-op until we're near the next one.)
    runTownhallRecurrence().catch(e => console.error('[townhall-autoclose] recur', e))
  } catch (e) {
    console.error('[townhall-autoclose]', e)
  }
}

// ─── Scheduler ──────────────────────────────────────────────────────────
// All five townhall jobs run in one idempotent tick. Each does a guarded SELECT
// and usually skips, so running the whole set every minute is cheap and far
// simpler than five overlapping intervals. `_tickRunning` stops a slow tick from
// overlapping the next one — and stops the in-process timer from racing a
// /cron/tick HTTP trigger (both run in this one process).
let _tickRunning = false
async function runCronTick(source) {
  if (_tickRunning) return { skipped: true }
  _tickRunning = true
  try {
    await runTownhallAutostart()
    await runTownhallReminders()
    await runTownhallAnnouncements()
    await runTownhallAutoclose()
    await runTownhallRecurrence()
    return { ok: true }
  } catch (e) {
    console.error(`[cron-tick:${source || 'timer'}]`, e)
    logError('server', { kind: 'cron_tick', message: e && e.message, stack: e && e.stack, url: 'runCronTick' })
    return { ok: false, error: e && e.message }
  } finally {
    _tickRunning = false
  }
}

// In-process timer = liveness while the server is up. The DURABLE layer is an
// external pg_cron heartbeat that POSTs /cron/tick every minute (see
// sql/2026-06-10_townhall_pg_cron.sql): it keeps the jobs firing even if this
// in-process timer dies, and on any future scale-to-zero plan it wakes the
// server. Both call the same guarded runCronTick, so they can't double-fire.
setTimeout(() => runCronTick('boot'), 8000)
setInterval(() => runCronTick('timer'), 60 * 1000)
