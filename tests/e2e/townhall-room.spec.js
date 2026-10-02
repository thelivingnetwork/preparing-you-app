const fs = require('fs');
const path = require('path');
const { test, expect } = require('./_setup');

// A stand-in for daily-js, served in place of the unpkg script so the room's
// real loader runs. It records every command the room sends to Daily.
const FAKE_DAILY = `
(function(){
  const H = {};
  const fire = (ev, d) => (H[ev] || []).forEach(f => f(d));
  const mk = (sid, name, o) => Object.assign({ session_id: sid, user_id: 'u-' + sid, user_name: name, local: false, owner: false,
    permissions: { canAdmin: false }, joined_at: new Date(Date.now() - sid.length * 1000).toISOString(),
    tracks: { audio: { state: 'off' } }, userData: { av: '', hand: 0 } }, o || {});
  const ps = {
    local: mk('me', 'Test Host', { local: true, owner: !!window.__asHost }),
    s1: mk('s1', 'Caleb Eaton', { tracks: { audio: { state: 'playable' } } }),
    s2: mk('s2', 'Ruth Adams', { userData: { av: '', hand: 1 } }),
    s3: mk('s3', 'Sarah Long', { permissions: { canAdmin: ['participants'] } })
  };
  window.__log = [];
  const call = {
    on(ev, f){ (H[ev] = H[ev] || []).push(f); return call; },
    async join(o){ window.__joinOpts = o; ps.local.userData = o.userData; return ps; },
    participants(){ return ps; },
    setLocalAudio(on){ ps.local.tracks.audio.state = on ? 'playable' : 'off'; fire('participant-updated', {}); },
    setUserData(d){ ps.local.userData = d; fire('participant-updated', {}); },
    sendAppMessage(d, to){ __log.push(['msg', d.t, to]); },
    updateParticipant(sid, p){ __log.push(['upd', sid, Object.keys(p)[0]]); },
    updateParticipants(m){ __log.push(['updAll', Object.keys(m['*'])[0]]); },
    async leave(){ __log.push(['leave']); }, destroy(){},
    startLocalAudioLevelObserver(){}, startRemoteParticipantsAudioLevelObserver(){}
  };
  window.__fire = fire;
  window.Daily = { createCallObject(opts){ window.__createOpts = opts; return call; } };
})();`;

async function openRoom(page, asHost){
  await page.route('**/unpkg.com/@daily-co/daily-js**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_DAILY }));
  await page.route('**/townhall/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await page.goto('/app/');
  await page.evaluate((h) => {
    window.__asHost = h;
    window._authHeaders = async () => ({ 'Content-Type': 'application/json' });
    window.confirm = () => true;
    openTownhallRoom({ roomUrl: 'https://x.daily.co/t', token: 't', title: 'Weekly Townhall', topic: 'Open discussion', url: 'https://x.daily.co/t?t=1' });
  }, asHost);
  await expect(page.locator('#th-grid .th-p')).toHaveCount(4);
}

test.describe('townhall room', () => {
  test('joins audio-only and muted, and lists host and co-host first', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openRoom(page, true);
    const opts = await page.evaluate(() => window.__createOpts);
    expect(opts).toMatchObject({ videoSource: false, startAudioOff: true, startVideoOff: true });
    await expect(page.locator('#th-grid .th-p').nth(0).locator('.th-role')).toHaveText('Host');
    await expect(page.locator('#th-grid .th-p').nth(1).locator('.th-role')).toHaveText('Co-host');
    await expect(page.locator('.th-p[data-sid="s2"] .th-badge')).toHaveText('✋');
    await expect(page.locator('#th-sub')).toContainText('4 here');
    expect(errors).toEqual([]);
  });

  test('reactions cover the sender and survive a redraw', async ({ page }) => {
    await openRoom(page, false);
    await page.locator('#th-react').click();
    await page.locator('.th-react-btn', { hasText: '💯' }).click();
    await expect(page.locator('.th-p[data-sid="me"] .th-rx')).toHaveText('💯');
    await page.locator('#th-hand').click();   // forces a redraw mid-animation
    await expect(page.locator('.th-p[data-sid="me"] .th-rx')).toHaveText('💯');
    expect(await page.evaluate(() => __log.filter(x => x[1] === 'react').length)).toBe(1);
  });

  test('hosts get person options; members do not', async ({ page }) => {
    await openRoom(page, true);
    await page.locator('.th-p[data-sid="s2"]').click();
    await expect(page.locator('#th-sheet .th-row')).toHaveText(['Make co-host', 'Lower hand', 'Remove from townhall']);
    await page.locator('#th-sheet .th-row', { hasText: 'Remove from townhall' }).click();
    await expect.poll(() => page.evaluate(() => __log.map(x => x.join(':')))).toContain('upd:s2:eject');
    await page.locator('.th-icon-btn').click();
    await expect(page.locator('#th-sheet .th-row', { hasText: 'Mute everyone' })).toBeVisible();
    await expect(page.locator('#th-sheet .th-row', { hasText: 'End townhall for everyone' })).toBeVisible();
  });

  test('members cannot moderate and only see the browser fallback', async ({ page }) => {
    await openRoom(page, false);
    await page.locator('.th-p[data-sid="s1"]').click();
    await expect(page.locator('#th-sheet-wrap')).not.toHaveClass(/show/);
    await page.locator('.th-icon-btn').click();
    await expect(page.locator('#th-sheet .th-row')).toHaveText(['Trouble hearing? Open in browser']);
    // A "removed" message from someone without admin rights is ignored.
    await page.evaluate(() => __fire('app-message', { data: { t: 'removed', to: 'me' }, fromId: 's1' }));
    await expect(page.locator('#th-grid .th-p')).toHaveCount(4);
  });

  test('chat sends and shows messages', async ({ page }) => {
    await openRoom(page, false);
    await page.evaluate(() => __fire('app-message', { data: { t: 'chat', x: 'Amen' }, fromId: 's1' }));
    await expect(page.locator('#th-unread')).toHaveClass(/show/);
    await page.locator('#th-chat').click();
    await page.locator('#th-chat-input').fill('Welcome everyone');
    await page.locator('.th-chat-form button').click();
    await expect(page.locator('#th-chat-list')).toContainText('Caleb Eaton Amen');
    await expect(page.locator('#th-chat-list')).toContainText('Welcome everyone');
  });

  // The CSP header isn't served locally, so check the deployed config allows Daily.
  test('Netlify CSP allows the call to load and connect', async () => {
    const toml = fs.readFileSync(path.join(__dirname, '..', '..', 'netlify.toml'), 'utf8');
    const csp = toml.match(/Content-Security-Policy = "([^"]+)"/)[1];
    const dir = (n) => (csp.split(';').map(s => s.trim()).find(s => s.startsWith(n + ' ')) || '');
    expect(dir('script-src')).toContain('https://unpkg.com');
    expect(dir('script-src')).toContain('https://*.daily.co');
    expect(dir('connect-src')).toContain('wss://*.daily.co');
    expect(dir('connect-src')).toContain('https://*.daily.co');
    expect(dir('worker-src')).toContain('blob:');
  });
});
