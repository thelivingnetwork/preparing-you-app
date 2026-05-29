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
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
})

// Web Push — VAPID. If the keys aren't set, push fanout becomes a no-op.
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY || ''
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || ''
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:tofnotifications@gmail.com'
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE)
} else {
  console.warn('[push] VAPID keys missing — /paul-style chat works but push notifications are disabled')
}

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
- Do not begin with "Peace to you" or other greetings — a greeting is offered by the interface.`

const PAUL_LANGS = new Set([
  'English','Spanish','French','Portuguese','German','Italian',
  'Russian','Chinese (Simplified)','Arabic','Armenian','Hindi','Swahili','Filipino'
])

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

  let sys = PAUL_SYSTEM + '\n\nSource excerpts retrieved for this question:\n\n' + context
  // Always auto-detect the user's language and respond in kind.
  // If the user has explicitly chosen a language via the dropdown, that overrides auto-detection.
  if (lang && PAUL_LANGS.has(lang) && lang !== 'English') {
    sys += `\n\nLanguage: The user has selected ${lang} as their preferred language. Always respond in ${lang} regardless of what language they write in.`
  } else {
    sys += `\n\nLanguage: Detect the language of the user's most recent message and respond in that same language. If they write in Spanish, reply in Spanish. If French, reply in French. Match whatever language they use.`
  }

  // Tool-use loop — Paul can call lookup_bible_passage before answering
  const apiMessages = messages.map(m => ({ role: m.role, content: m.content }))
  let resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 1024,
    system: sys,
    messages: apiMessages,
    tools: BIBLE_TOOLS
  })

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
      console.log(`[paul] tool ${toolBlock.name} input=${JSON.stringify(toolBlock.input)}`)
      let toolResult
      try {
        if (toolBlock.name === 'lookup_strongs') {
          toolResult = await fetchStrongsDefinition(toolBlock.input.number)
        } else if (toolBlock.name === 'search_church_articles') {
          toolResult = await searchChurchArticles(toolBlock.input.query)
        } else if (toolBlock.name === 'fetch_church_article') {
          toolResult = await fetchChurchArticle(toolBlock.input.url)
        } else {
          const { reference, translation = 'kjv' } = toolBlock.input
          toolResult = await fetchBiblePassage(reference, translation)
        }
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
      messages: apiMessages
    })
  }

  const answer = resp.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()

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
  await notify(userId, '✦', 'You have been invited to The Living Network. Check your email.', { type:'page', page:'join-tln' })
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

async function pushToUser(userId, { icon, text, action }) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return
  const { data: subs } = await sb.from('prep_push_subscriptions')
    .select('id, endpoint, p256dh, auth').eq('user_id', userId)
  if (!subs || !subs.length) return
  const { count: unread } = await sb.from('prep_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId).is('read_at', null)
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
  await notify(pcmId, '👥', `${elector?.name || 'A user'} has elected you as their PCM.`, { type:'page', page:'pcm' })
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
      return send(res, 200, { ok: true, service: 'preparing-you', version: '0.9.7' })
    }

    if (req.method === 'GET' && req.url === '/push/vapid-public-key') {
      return send(res, 200, { key: VAPID_PUBLIC })
    }

    // Debug-only: POST /push/test-send?userId=<uuid>
    // Sends a real push to all subscriptions for that user and returns results.
    if (req.method === 'POST' && req.url.startsWith('/push/test-send')) {
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
      const { userId, subscription } = await readJson(req)
      if (!userId || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
        return send(res, 400, { error: 'userId + subscription required' })
      }
      const { error } = await sb.from('prep_push_subscriptions').upsert({
        user_id: userId,
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
      const body = await readJson(req)
      const { userId, messages, lang } = body
      if (!Array.isArray(messages) || !messages.length) return send(res, 400, { error: 'messages required' })
      return send(res, 200, await paulChat(userId, messages, lang))
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
      await notify(userId, '✦', 'Welcome. Begin with the introduction videos.', { type:'page', page:'video' })
      return send(res, 200, { ok: true })
    }

    if (req.method === 'POST' && req.url === '/messages/send') {
      const { senderId, recipientId, body: msgBody, attachmentUrl, attachmentName, attachmentType } = await readJson(req)
      const trimmedBody = (msgBody || '').trim()
      if (!senderId || !recipientId || (!trimmedBody && !attachmentUrl)) {
        return send(res, 400, { error: 'senderId, recipientId, and a body or attachment required' })
      }
      // Insert message (body may be empty when an attachment is present)
      const { error: insErr } = await sb.from('prep_messages').insert({
        sender_id: senderId, recipient_id: recipientId,
        body: trimmedBody || null,
        attachment_url: attachmentUrl || null,
        attachment_name: attachmentName || null,
        attachment_type: attachmentType || null
      })
      if (insErr) return send(res, 500, { error: insErr.message })
      // Look up sender name for the push notification payload
      const { data: sender } = await sb.from('prep_users').select('name').eq('id', senderId).maybeSingle()
      const senderName = sender?.name || 'Someone'
      const previewText = trimmedBody || ('📎 ' + (attachmentName || 'Attachment'))
      const preview = previewText.length > 60 ? previewText.slice(0, 60) + '…' : previewText
      // The DB trigger (prep_message_notification) creates the prep_notifications
      // row automatically on every prep_messages INSERT, so we only need to fire
      // the web push here — avoids a duplicate bell entry.
      pushToUser(recipientId, { icon: '💬', text: `${senderName}: ${preview}`, action: { type: 'page', page: 'messages' } })
        .catch(e => console.warn('[push] message fanout failed', e))
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

      // 2) Emails via EmailJS REST — sequential with small delay
      const subject = `${title} starts in ${minsAway} minutes`
      const topicLine = th.topic ? `\n\n${title} — ${th.topic}` : `\n\n${title}`
      for (const u of list) {
        if (u.email) {
          const greet = u.name ? `Peace to you, ${u.name}.` : 'Peace to you.'
          const message =
`${greet}

The townhall begins in ${minsAway} minutes.${topicLine}

When the moderator opens the call, a "Townhall is live" banner will appear across the app. Tap it to join — or open Preparing You and your local start time will be shown.

Open Preparing You: https://preparingyou.netlify.app`
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

// Run on boot, then every 5 minutes
setTimeout(runTownhallReminders, 5000)
setInterval(runTownhallReminders, 5 * 60 * 1000)
