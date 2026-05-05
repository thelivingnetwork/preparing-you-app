# Preparing You

A gateway app that prepares people for entry into **The Living Network**.

## What it does
- Gateway video (~10 min, drawn from the five source books)
- Personal Contact Minister (PCM) volunteer + matching by region
- Topical library (articles + videos)
- Five source books with PDF reading view + AI-narrated audio summaries
- "Paul" — a Claude-powered AI assistant available on every page
- Sign-off flow: PCM approves the applicant, who then receives a one-click link into The Living Network

## Stack
- **Frontend:** Vanilla JS single `index.html`, deployed to Netlify
- **Backend:** Node service on Render (web type) — `/paul/chat`, file uploads, signed URLs, signoff webhook
- **Database / Auth:** **Separate** Supabase project (intentionally isolated from The Living Network's Supabase) — handoff to TLN is via signed JWT, not shared `auth.users`
- **AI:** Anthropic Claude API
- **Audio:** Text-to-speech (OpenAI TTS or AWS Polly)
- **Email:** Re-uses the existing EmailJS template + sender

## Repo layout
```
.
├── index.html             # The whole frontend
├── sw.js                  # (TBD) push notifications
├── netlify.toml           # Netlify config
├── server/
│   ├── index.js           # Express: /paul/chat, /upload, /signoff
│   ├── lib/
│   │   ├── claude.js      # Anthropic SDK wrapper
│   │   ├── tts.js         # text-to-speech
│   │   ├── pdf.js         # pdf-parse for chapter extraction
│   │   └── rag.js         # embeddings + retrieval
│   └── package.json
├── scripts/
│   └── ingest-books.js    # one-shot pipeline: PDFs → chapters → audio → embeddings
└── render.yaml            # Render web service + secret file
```

## Initial schema (separate Supabase project)
```
prep_users        (id PK = auth.users.id, name, email, region, gateway_watched_at, pcm_id FK, joined_tln_at)
prep_pcms         (id PK = auth.users.id, name, email, phone, telegram, messenger, region, active)
prep_books        (id, title, author, slug, pdf_storage_path, cover_url, order_index)
prep_chapters     (id, book_id, title, order_index, page_start, page_end, audio_storage_path, summary_text)
prep_articles     (id, title, body_md, video_url, tags[], published_at)
prep_signoffs     (id, user_id, pcm_id, requested_at, approved_at, status, note)
prep_paul_chats   (id, user_id, message, role, created_at)
prep_book_chunks  (id, book_id, chapter_id, chunk_text, embedding vector(1536))
```

## TLN handoff
When PCM approves a user's "Join" request:
1. `prep_signoffs.status = 'approved'`
2. The Render service issues a short-lived signed JWT containing the user's email + a "vouched-by-PCM" claim
3. User clicks a card → `https://livingnetwork.netlify.app/?prep_token=<jwt>`
4. TLN's join flow verifies the token (server-side check against the Preparing You service), prefills name/email, and grants them straight access without re-running the gateway prompts

## Status
Skeleton only. PDFs, AI integration, audio pipeline, PCM flow, and TLN handoff still to wire.
