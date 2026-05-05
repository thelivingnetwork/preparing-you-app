#!/usr/bin/env node
// Ingest PDFs → chunks → embeddings → prep_book_chunks
//
// Usage:
//   cd preparing-you-app/scripts
//   npm install
//   OPENAI_API_KEY=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node ingest-pdfs.js
//
// Or put those three vars in preparing-you-app/.env.ingest (gitignored).
// Re-running deletes existing chunks for each book and re-inserts.

const fs = require('fs')
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env.ingest') })

const pdf = require('pdf-parse')
const OpenAI = require('openai')
const { createClient } = require('@supabase/supabase-js')

const BOOKS_DIR = '/Users/markvernuccio/Desktop/preparing-you-books'
const BOOKS = [
  { slug: 'book-1', file: 'CCCprint.pdf' },                    // Covenants, Contracts and Constitutions
  { slug: 'book-2', file: 'THLprint.pdf' },                    // The Higher Liberty
  { slug: 'book-3', file: 'The Covenants of the gods.pdf' },   // Covenants of the gods
  { slug: 'book-4', file: 'FCRprint.pdf' },                    // The Free Church Report
  { slug: 'book-5', file: 'TKCprint.pdf' },                    // Thy Kingdom Comes
]

const CHUNK_TARGET_CHARS = 2400  // ~600 tokens
const CHUNK_OVERLAP_CHARS = 300

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
})

function chunkText(text) {
  const cleaned = text
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const paragraphs = cleaned.split(/\n\n+/)
  const chunks = []
  let buf = ''
  for (const p of paragraphs) {
    if ((buf + '\n\n' + p).length <= CHUNK_TARGET_CHARS) {
      buf = buf ? buf + '\n\n' + p : p
    } else {
      if (buf) chunks.push(buf)
      if (p.length > CHUNK_TARGET_CHARS) {
        let i = 0
        while (i < p.length) {
          chunks.push(p.slice(i, i + CHUNK_TARGET_CHARS))
          i += CHUNK_TARGET_CHARS - CHUNK_OVERLAP_CHARS
        }
        buf = ''
      } else {
        buf = p
      }
    }
  }
  if (buf) chunks.push(buf)
  return chunks
}

async function embedBatch(texts) {
  const r = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: texts,
  })
  return r.data.map(d => d.embedding)
}

async function ingestBook(book) {
  const filePath = path.join(BOOKS_DIR, book.file)
  if (!fs.existsSync(filePath)) {
    console.warn(`  ! file not found: ${filePath} — skipping`)
    return
  }
  console.log(`\n→ ${book.slug}: ${book.file}`)

  const { data: bookRow, error: bErr } = await sb
    .from('prep_books').select('id').eq('slug', book.slug).maybeSingle()
  if (bErr || !bookRow) { console.error('  no book row for slug', book.slug, bErr); return }
  const bookId = bookRow.id

  await sb.from('prep_book_chunks').delete().eq('book_id', bookId)

  const buf = fs.readFileSync(filePath)
  const parsed = await pdf(buf)
  const text = parsed.text || ''
  console.log(`  parsed: ${text.length.toLocaleString()} chars`)

  const chunks = chunkText(text)
  console.log(`  chunks: ${chunks.length}`)

  const BATCH = 64
  let inserted = 0
  for (let i = 0; i < chunks.length; i += BATCH) {
    const slice = chunks.slice(i, i + BATCH)
    const embs = await embedBatch(slice)
    const rows = slice.map((chunk_text, j) => ({
      book_id: bookId,
      chunk_text,
      embedding: embs[j],
    }))
    const { error: iErr } = await sb.from('prep_book_chunks').insert(rows)
    if (iErr) { console.error('  insert error', iErr); break }
    inserted += rows.length
    process.stdout.write(`  embedded+inserted ${inserted}/${chunks.length}\r`)
  }
  console.log(`  ✓ done (${inserted} chunks)`)
}

;(async () => {
  for (const k of ['OPENAI_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
    if (!process.env[k]) { console.error(`missing env: ${k}`); process.exit(1) }
  }
  for (const b of BOOKS) await ingestBook(b)
  console.log('\nAll books ingested.')
})().catch(e => { console.error(e); process.exit(1) })
