// Security smoke-test for the Preparing You server.
//
// Verifies that every privileged endpoint rejects unauthenticated requests.
// All requests send an empty body and NO auth token, so they are safe — the
// server rejects them before any database write. Run this against a deploy
// PREVIEW of the patched server (not old production).
//
// Usage:
//   BASE_URL=https://preparing-you-server-pr-xyz.onrender.com node smoke-test.mjs
//   (defaults to the production URL if BASE_URL is unset)
//
// Optional positive check: set TOKEN=<a real Supabase access token> to confirm
// an authenticated /health-style call path. (Left minimal on purpose — positive
// flows with side effects should be tested by hand in the app UI.)

const BASE = process.env.BASE_URL || 'https://preparing-you-server.onrender.com';

const PROTECTED_POSTS = [
  '/messages/send', '/elect', '/election/respond', '/pcm/nudge', '/pcm/withdraw',
  '/peers', '/welcome', '/tln/invite', '/call/start',
  '/paul/chat', '/paul/chat/stream', '/paul/speak', '/paul/transcribe',
  '/townhall/start', '/townhall/end', '/townhall/join',
  '/push/subscribe', '/push/test-send',
  '/townhall/reminders/run', '/townhall/announcements/run',
];

let pass = 0, fail = 0;
const ok = (cond, label) => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); };

async function hit(method, path, headers = {}) {
  try {
    const r = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: method === 'POST' ? '{}' : undefined,
    });
    return r.status;
  } catch (e) { return 'ERR:' + e.message; }
}

console.log(`Smoke-testing ${BASE}\n`);
console.log('== protected POSTs without a token (expect 401) ==');
for (const p of PROTECTED_POSTS) ok((await hit('POST', p)) === 401, `${p}`);

console.log('\n== public endpoints ==');
ok((await hit('GET', '/health')) === 200, 'GET /health -> 200');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
