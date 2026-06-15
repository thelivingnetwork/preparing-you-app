#!/usr/bin/env node
// Upload audiobook parts to the Supabase `audiobooks` public bucket (upsert).
// Reuses the service-role key from .env.ingest (same as ingest-pdfs.js).
// Usage: node scripts/upload-audiobooks.js CCC-part1.m4a CCC-part2.m4a ...
//   (file names are resolved against ~/Desktop/audiobook-build/)
const path = require('path')
const fs = require('fs')
require('dotenv').config({ path: path.join(__dirname, '..', '.env.ingest') })
const { createClient } = require('@supabase/supabase-js')

const BUILD = '/Users/markvernuccio/Desktop/audiobook-build'
const BUCKET = 'audiobooks'

for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!process.env[k]) { console.error(`missing env: ${k}`); process.exit(1) }
}
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

async function main() {
  const files = process.argv.slice(2)
  if (!files.length) { console.error('no files given'); process.exit(1) }
  for (const name of files) {
    const p = path.join(BUILD, name)
    if (!fs.existsSync(p)) { console.error(`MISSING: ${p}`); process.exit(1) }
    const buf = fs.readFileSync(p)
    const mb = (buf.length / 1048576).toFixed(1)
    process.stdout.write(`uploading ${name} (${mb}MB) ... `)
    const { error } = await sb.storage.from(BUCKET).upload(name, buf, {
      contentType: 'audio/mp4', upsert: true, cacheControl: '300',
    })
    if (error) { console.error(`FAILED: ${error.message}`); process.exit(1) }
    console.log('ok')
  }
  console.log(`done — ${files.length} parts uploaded to ${BUCKET}/`)
}
main()
