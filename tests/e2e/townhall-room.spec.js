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
    local: mk('me', 'Test Host', { local: true, owner: !!window.__asHost,
      permissions: { canAdmin: window.__asCohost ? ['participants'] : false, canSend: window.__locked ? false : true } }),
    s1: mk('s1', 'Caleb Eaton', { owner: !!window.__s1Host, tracks: { audio: { state: 'playable' } } }),
    s2: mk('s2', 'Ruth Adams', { userData: { av: '', hand: 1 } }),
    s3: mk('s3', 'Sarah Long', { permissions: { canAdmin: ['participants'] } })
  };
  window.__log = [];
  const call = {
    on(ev, f){ (H[ev] = H[ev] || []).push(f); return call; },
    async join(o){ window.__joinOpts = o; ps.local.userData = o.userData; return ps; },
    participants(){ return ps; },
    setLocalAudio(on){ __log.push(['local', on]); ps.local.tracks.audio.state = on ? 'playable' : 'off'; fire('participant-updated', {}); },
    setUserData(d){ ps.local.userData = d; fire('participant-updated', {}); },
    sendAppMessage(d, to){ __log.push(['msg', d.t, to]); },
    updateParticipant(sid, p){
      __log.push(['upd', sid, Object.keys(p).join('+')]);
      const t = Object.values(ps).find(x => x.session_id === sid);
      if(t && p.updatePermissions && 'canSend' in p.updatePermissions){
        __log.push(['canSend', sid, p.updatePermissions.canSend]);
        t.permissions = Object.assign({}, t.permissions, { canSend: p.updatePermissions.canSend });
      }
      if(t && p.setAudio === false) t.tracks = { audio: { state: 'off' } };
      fire('participant-updated', {});
    },
    updateParticipants(m){ Object.keys(m).forEach(sid => call.updateParticipant(sid, m[sid])); },
    async leave(){ __log.push(['leave']); }, destroy(){},
    startLocalAudioLevelObserver(){}, startRemoteParticipantsAudioLevelObserver(){}
  };
  window.__fire = fire;
  window.Daily = { createCallObject(opts){ window.__createOpts = opts; return call; } };
})();`;

// o: { cohost, locked, s1Host, locks } — who you are and what the server says.
async function openRoom(page, asHost, o = {}){
  const mutes = [];
  await page.route('**/unpkg.com/@daily-co/daily-js**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_DAILY }));
  // A tiny stand-in for the server's lock list: the muter is always 'u-me'.
  const locks = o.locks || { room: null, people: {} };
  await page.route('**/townhall/**', (r) => {
    if(!r.request().url().endsWith('/townhall/mute')) return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    const b = JSON.parse(r.request().postData() || '{}');
    mutes.push(b);
    if(b.all) locks.room = b.on ? { by: 'u-me', name: b.userName, allow: [] } : null;
    else if(b.on) locks.people[b.targetUserId] = { by: 'u-me', name: b.userName };
    else { delete locks.people[b.targetUserId]; if(locks.room) locks.room.allow.push(b.targetUserId); }
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, locks }) });
  });
  await page.goto('/app/');
  await page.evaluate(([h, o]) => {
    window.__asHost = h;
    window.__asCohost = !!o.cohost;
    window.__locked = !!o.locked;
    window.__s1Host = !!o.s1Host;
    window._authHeaders = async () => ({ 'Content-Type': 'application/json' });
    window.confirm = () => true;
    openTownhallRoom({ roomUrl: 'https://x.daily.co/t', token: 't', title: 'Weekly Townhall', topic: 'Open discussion', url: 'https://x.daily.co/t?t=1', locks: o.locks });
  }, [asHost, o]);
  await expect(page.locator('#th-grid .th-p')).toHaveCount(4);
  return mutes;
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
    await expect(page.locator('#th-sheet .th-row')).toHaveText(['Make co-host', 'Lower hand', 'Mute', 'Remove from townhall']);
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

  test('muting locks the mic until the same moderator unmutes', async ({ page }) => {
    const mutes = await openRoom(page, true);
    await page.locator('.th-p[data-sid="s1"]').click();
    await page.locator('#th-sheet .th-row', { hasText: /^Mute$/ }).click();
    await expect.poll(() => page.evaluate(() => __log.map(x => x.join(':')))).toContain('canSend:s1:false');
    expect(mutes[0]).toMatchObject({ targetUserId: 'u-s1', on: true });
    expect(await page.evaluate(() => __log.some(x => x[1] === 'locks' && x[2] === '*'))).toBe(true);
    await expect(page.locator('.th-p[data-sid="s1"] .th-badge-lock')).toBeVisible();
    await page.locator('.th-p[data-sid="s1"]').click();
    await page.locator('#th-sheet .th-row', { hasText: 'Unmute' }).click();
    await expect.poll(() => page.evaluate(() => __log.map(x => x.join(':')))).toContain('canSend:s1:true');
    expect(mutes[1]).toMatchObject({ targetUserId: 'u-s1', on: false });
    expect(await page.evaluate(() => __log.some(x => x[1] === 'unlocked' && x[2] === 's1'))).toBe(true);
  });

  test('a locked member cannot unmute themselves', async ({ page }) => {
    await openRoom(page, false, { locked: true, locks: { room: null, people: { 'u-me': { by: 'u-s3', name: 'Sarah Long' } } } });
    await expect(page.locator('#th-mic')).toHaveClass(/locked/);
    await page.locator('#th-mic').click();
    await expect(page.locator('#th-status')).toContainText('Sarah Long muted you');
    expect(await page.evaluate(() => __log.filter(x => x[0] === 'local' && x[1] === true).length)).toBe(0);
    // Once the moderator lifts the lock, the mic works again.
    await page.evaluate(() => { const me = Daily.createCallObject().participants().local; me.permissions.canSend = true; __fire('participant-updated', {}); });
    await page.locator('#th-mic').click();
    await expect(page.locator('#th-mic')).toHaveClass(/on/);
  });

  test('the host cannot be muted, and others only see who muted someone', async ({ page }) => {
    await openRoom(page, false, { cohost: true, s1Host: true,
      locks: { room: null, people: { 'u-s2': { by: 'u-s3', name: 'Sarah Long' } } } });
    await page.locator('.th-p[data-sid="s1"]').click();
    await expect(page.locator('#th-sheet .th-row', { hasText: /Mute/ })).toHaveCount(0);
    await page.locator('#th-sheet .th-x').click();
    await page.locator('.th-p[data-sid="s2"]').click();
    await expect(page.locator('#th-sheet .th-row-note')).toHaveText('Muted by Sarah Long');
    await expect(page.locator('#th-sheet .th-row', { hasText: /^Unmute$/ })).toHaveCount(0);
    await page.locator('#th-sheet .th-x').click();
    await page.locator('.th-icon-btn').click();
    await page.locator('#th-sheet .th-row', { hasText: 'Mute everyone' }).click();
    await expect.poll(() => page.evaluate(() => __log.map(x => x.join(':')))).toContain('canSend:s3:false');
    const log = await page.evaluate(() => __log.map(x => x.join(':')));
    expect(log).not.toContain('canSend:s1:false');   // the host
    expect(log).not.toContain('canSend:me:false');   // whoever muted the room
    await page.locator('.th-icon-btn').click();
    await page.locator('#th-sheet .th-row', { hasText: 'Unmute everyone' }).click();
    await expect.poll(() => page.evaluate(() => __log.map(x => x.join(':')))).toContain('canSend:s3:true');
    // Ruth was muted on her own by Sarah, so the room unmute leaves her locked.
    expect(await page.evaluate(() => __log.map(x => x.join(':')))).not.toContain('canSend:s2:true');
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
