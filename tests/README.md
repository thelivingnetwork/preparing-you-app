# Preparing You — end-to-end tests

Playwright smoke + flow tests that drive the real app in a headless browser.
They're a safety net against the most common way this single-file app breaks:
one bad edit silently taking out a screen or a whole flow.

## Run them

```bash
cd tests
npm install                      # first time only
npx playwright install chromium  # first time only — downloads the browser
npm test                         # run all tests
npm run test:headed              # watch them run in a real window
npm run test:ui                  # interactive UI mode
```

The config starts a local static server (`python3 -m http.server`) that serves
the app from the repo root, exactly like Netlify does. No backend or real
account is needed — backend-touching flows are mocked at the network layer.

## What's covered

- **smoke** — app boots with no uncaught errors; landing screen + sign-in form
  render; critical globals survived parsing; PWA assets (manifest, sw.js, icons)
  are served.
- **navigation** — Sign In ⇄ Join tabs, the forgot-password panel, and the Join
  password-match indicator.
- **recovery** — a reset link (`?reset=1`) lands on the *set-new-password* panel
  (the flow that regressed twice).
- **auth** — invalid credentials show an error; valid credentials enter the app
  (Supabase auth + profile mocked; E2EE setup stubbed).

## Add a test

Drop a `*.spec.js` in `e2e/` and `require('./_setup')` for `test`/`expect`
(it auto-blocks the production error-log endpoint so test runs never pollute it).
When you fix a bug, add a test that would have caught it — that's how the net grows.

CI runs the whole suite on every push (`.github/workflows/tests.yml`).
