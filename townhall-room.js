// ═════════════════════════ TOWNHALL ROOM ═════════════════════════
// The in-app townhall: an audio-only, Spaces-style room built on Daily's call
// object (the same Daily rooms, tokens and recording as before; we just draw
// our own screen instead of opening Daily's page in a new tab).
//
// Loaded after app.js as a classic script, so it shares app.js globals
// (_SERVER_URL, _authHeaders, currentUser, _esc, _avInner, refreshTownhallCard).
//
// Who can do what:
//   everyone        mic on/off (joins muted), raise hand, react, chat, leave
//   host + co-host  mute one person, mute everyone, remove someone, lower a hand
//   host only       make or unmake a co-host, end the townhall
//
// Muting locks the mic: the muted person can't unmute themselves, and only
// whoever muted them can unmute them (a host can step in once that person has
// left). Hosts can never be muted. The lock is Daily's send permission, set by
// the muter's app and carried on rejoin tokens; who holds each lock is kept by
// the server (/townhall/mute) and shared over app messages.
// "Host" = Daily meeting owner (prep_townhall_hosts). "Co-host" = a member a
// host promoted, which gives them Daily's participant-admin permission.
//
// Live-only state (hands, reactions, chat) travels over Daily app messages and
// participant userData; nothing here is stored.

const _TH_DAILY_SRC = 'https://unpkg.com/@daily-co/daily-js@0.92.2/dist/daily.js';
const _TH_REACTIONS = ['💯', '😂', '❤️', '👏', '👋', '✊', '✌️'];
const _TH_SPEAK_LEVEL = 0.03;   // audio level (0..1) that counts as talking
const _TH_CHAT_MAX = 500;

let _th = null; // the open room, or null

// Rollout switch. While false, only townhall hosts get the in-app room and
// everyone else keeps Daily's own page, so a host can try it in a real
// townhall first. Anyone can opt in on their own device by opening the app
// once with ?throom=1 (and opt out with ?throom=0). Flip to true to give
// it to everyone.
const _TH_ROOM_FOR_ALL = true;
(function(){
  try {
    const q = new URLSearchParams(location.search).get('throom');
    if(q === '1') localStorage.setItem('th_room', '1');
    if(q === '0') localStorage.removeItem('th_room');
  } catch(_){}
})();
function _thRoomEnabled(isOwner){
  if(_TH_ROOM_FOR_ALL || isOwner) return true;
  try { return localStorage.getItem('th_room') === '1'; } catch(_){ return false; }
}

function _thLoadDaily(){
  if(window.Daily) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = _TH_DAILY_SRC;
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load the call. Check your connection and try again.'));
    document.head.appendChild(s);
  });
}

// Only show avatar photos from our own Supabase storage — userData is set by
// each member's own app, so treat it as untrusted.
function _thSafeAv(url){
  return (typeof url === 'string' && /^https:\/\/[a-z0-9-]+\.supabase\.co\/storage\//.test(url)) ? url : '';
}

function _thIsAdmin(p){
  if(!p) return false;
  if(p.owner) return true;
  const c = p.permissions && p.permissions.canAdmin;
  if(c === true) return true;
  if(!c) return false;
  return (typeof c.has === 'function') ? c.has('participants') : (Array.isArray(c) && c.includes('participants'));
}
function _thRole(p){ return p.owner ? 'Host' : (_thIsAdmin(p) ? 'Co-host' : ''); }
function _thMicOn(p){
  const a = p.tracks && p.tracks.audio;
  return a ? a.state === 'playable' || a.state === 'loading' : !!p.audio;
}
function _thMe(){ return _th && _th.call ? _th.call.participants().local : null; }

// Daily's send permission — false once a moderator has locked this person's mic.
function _thCanSpeak(p){
  const c = p && p.permissions && p.permissions.canSend;
  if(c === undefined || c === true) return true;
  if(!c) return false;
  return (typeof c.has === 'function') ? c.has('audio') : (Array.isArray(c) && c.includes('audio'));
}
// Who muted this person, from the server's lock list: {by, name} or null.
function _thLockFor(p){
  if(!_th || !p || p.owner || !p.user_id) return null;
  const L = _th.locks || {};
  const uid = String(p.user_id);
  if(L.people && L.people[uid]) return L.people[uid];
  const r = L.room;
  if(r && r.by !== uid && !(r.allow || []).includes(uid)) return r;
  return null;
}
function _thHere(uid){
  return !!(_th && _th.call && Object.values(_th.call.participants()).some(p => String(p.user_id) === String(uid)));
}
// You may undo a lock you set, or — as a host — one whose muter has gone.
function _thMayUnlock(lock){
  const me = _thMe();
  if(!lock || !me) return false;
  return String(lock.by) === String(me.user_id) || (me.owner && !_thHere(lock.by));
}

// ── Opening and closing ────────────────────────────────────────────
// j = the /townhall/join (or /townhall/start) response.
async function openTownhallRoom(j){
  if(_th){ _thShow(); return; }
  _thBuild(j);
  _thStatus('Connecting…');
  try {
    await _thLoadDaily();
    const call = window.Daily.createCallObject({
      audioSource: true, videoSource: false,
      startAudioOff: true, startVideoOff: true,
      dailyConfig: { avoidEval: true }
    });
    _th.call = call;
    _thWire(call);
    await call.join({
      url: j.roomUrl, token: j.token,
      userData: { av: (currentUser && currentUser.avatar_url) || '', hand: 0 }
    });
    _thStatus('');
    _thRender();
    _thAttachExistingAudio();
    try { call.startLocalAudioLevelObserver && call.startLocalAudioLevelObserver(150); } catch(_){}
    try { call.startRemoteParticipantsAudioLevelObserver && call.startRemoteParticipantsAudioLevelObserver(150); } catch(_){}
    _thWake(true);
  } catch(e){
    _thStatus((e && e.message) || 'Could not join the townhall.', true);
  }
}

function _thBuild(j){
  _th = {
    call: null, title: j.title || 'Weekly townhall', topic: j.topic || '',
    fallbackUrl: j.url || '', chat: [], unread: 0, sig: '', ended: false,
    lastReact: 0, wakeLock: null, leaving: false, speaking: new Set(),
    locks: j.locks || { room: null, people: {} }, enforced: {}
  };
  let el = document.getElementById('th-room');
  if(el) el.remove();
  el = document.createElement('div');
  el.id = 'th-room';
  el.className = 'th-room';
  el.innerHTML =
    '<div class="th-head">' +
      '<div class="th-head-text">' +
        '<div class="th-live"><span class="th-dot"></span>Live</div>' +
        '<div class="th-title">' + _esc(_th.title) + '</div>' +
        '<div class="th-sub" id="th-sub">' + _esc(_th.topic) + '</div>' +
      '</div>' +
      '<button class="th-icon-btn" aria-label="Room options" onclick="_thOpenRoomMenu()">' + _thSvg('dots') + '</button>' +
    '</div>' +
    '<div class="th-status" id="th-status"></div>' +
    '<div class="th-grid" id="th-grid"></div>' +
    '<div class="th-sheet-wrap" id="th-sheet-wrap" onclick="if(event.target===this)_thCloseSheet()"><div class="th-sheet" id="th-sheet"></div></div>' +
    '<div class="th-bar">' +
      '<button class="th-round" id="th-mic" aria-label="Unmute" onclick="_thToggleMic()">' + _thSvg('mic-off') + '</button>' +
      '<button class="th-round" id="th-hand" aria-label="Raise hand" onclick="_thToggleHand()">✋</button>' +
      '<button class="th-round" id="th-react" aria-label="React" onclick="_thOpenReactions()">' + _thSvg('smile') + '</button>' +
      '<button class="th-round" id="th-chat" aria-label="Chat" onclick="_thOpenChat()">' + _thSvg('chat') + '<span class="th-unread" id="th-unread"></span></button>' +
      '<button class="th-leave" onclick="leaveTownhallRoom()">Leave</button>' +
    '</div>' +
    '<div id="th-audio" style="display:none"></div>';
  document.body.appendChild(el);
  _thShow();
}

function _thShow(){
  const el = document.getElementById('th-room');
  if(el) el.classList.add('open');
  document.documentElement.classList.add('th-open');
}

async function leaveTownhallRoom(msg){
  if(!_th) return;
  const t = _th;
  t.leaving = true;
  try { if(t.call){ await t.call.leave(); t.call.destroy(); } } catch(_){}
  _thWake(false);
  _th = null;
  const el = document.getElementById('th-room');
  if(msg && el){
    el.querySelector('.th-grid').innerHTML = '';
    el.querySelector('.th-live').style.visibility = 'hidden';
    el.querySelector('.th-icon-btn').style.display = 'none';
    el.querySelector('#th-sub').textContent = '';
    el.querySelector('.th-bar').innerHTML = '<button class="th-leave th-close" onclick="_thDismiss()">Close</button>';
    _thCloseSheet();
    const s = document.getElementById('th-status');
    if(s){ s.textContent = msg; s.className = 'th-status show'; }
  } else {
    _thDismiss();
  }
  if(typeof refreshTownhallCard === 'function') refreshTownhallCard();
}
function _thDismiss(){
  const el = document.getElementById('th-room');
  if(el) el.remove();
  document.documentElement.classList.remove('th-open');
}

async function _thWake(on){
  try {
    if(on && navigator.wakeLock && _th){ _th.wakeLock = await navigator.wakeLock.request('screen'); }
    else if(!on && _th && _th.wakeLock){ _th.wakeLock.release(); }
  } catch(_){}
}

function _thStatus(text, isError){
  const s = document.getElementById('th-status');
  if(!s) return;
  s.textContent = text || '';
  s.className = 'th-status' + (text ? ' show' : '') + (isError ? ' err' : '');
}
let _thStatusTimer = null;
function _thFlash(text){
  _thStatus(text);
  clearTimeout(_thStatusTimer);
  _thStatusTimer = setTimeout(() => _thStatus(''), 3500);
}

// ── Daily events ───────────────────────────────────────────────────
function _thWire(call){
  const rerender = () => { _thEnforceLocks(); _thRender(); };
  call.on('participant-joined', rerender);
  call.on('participant-updated', rerender);
  call.on('participant-left', ev => {
    const sid = ev && ev.participant && ev.participant.session_id;
    _thDropAudio(sid);
    if(_th) _th.speaking.delete(sid);
    _thRender();
  });
  call.on('track-started', ev => {
    if(ev && ev.track && ev.track.kind === 'audio' && ev.participant && !ev.participant.local) _thPlay(ev.participant.session_id, ev.track);
    _thRender();
  });
  call.on('track-stopped', ev => {
    if(ev && ev.track && ev.track.kind === 'audio' && ev.participant && !ev.participant.local) _thDropAudio(ev.participant.session_id);
    _thRender();
  });
  call.on('local-audio-level', ev => {
    const me = _thMe();
    if(me) _thSpeaking(me.session_id, _thMicOn(me) && ev.audioLevel > _TH_SPEAK_LEVEL);
  });
  call.on('remote-participants-audio-level', ev => {
    const lv = (ev && ev.participantsAudioLevel) || {};
    Object.keys(lv).forEach(sid => _thSpeaking(sid, lv[sid] > _TH_SPEAK_LEVEL));
  });
  call.on('app-message', ev => _thOnMessage(ev && ev.data, ev && ev.fromId));
  call.on('left-meeting', () => {
    if(_th && !_th.leaving) leaveTownhallRoom(_th.ended ? 'The townhall has ended.' : 'You have left the townhall.');
  });
  call.on('camera-error', () => _thFlash('Allow microphone access in your settings so you can speak.'));
  call.on('error', ev => {
    if(_th && !_th.leaving) leaveTownhallRoom((ev && ev.errorMsg) ? 'The call ended: ' + ev.errorMsg : 'The call ended.');
  });
}

// Remote audio has to be played by us in call-object mode.
function _thPlay(sid, track){
  const box = document.getElementById('th-audio');
  if(!box || !sid) return;
  let a = document.getElementById('th-a-' + sid);
  if(!a){
    a = document.createElement('audio');
    a.id = 'th-a-' + sid;
    a.autoplay = true;
    a.setAttribute('playsinline', '');
    box.appendChild(a);
  }
  const cur = a.srcObject && a.srcObject.getAudioTracks()[0];
  if(cur !== track){ a.srcObject = new MediaStream([track]); }
  const p = a.play(); if(p && p.catch) p.catch(() => {});
}
function _thDropAudio(sid){
  const a = sid && document.getElementById('th-a-' + sid);
  if(a){ a.srcObject = null; a.remove(); }
}
function _thAttachExistingAudio(){
  if(!_th || !_th.call) return;
  const ps = _th.call.participants();
  Object.keys(ps).forEach(k => {
    const p = ps[k];
    if(p.local) return;
    const t = p.tracks && p.tracks.audio && p.tracks.audio.persistentTrack;
    if(t && p.tracks.audio.state === 'playable') _thPlay(p.session_id, t);
  });
}

function _thOnMessage(d, fromId){
  if(!_th || !d || typeof d !== 'object') return;
  const me = _thMe();
  const from = _th.call.participants()[fromId] ||
    Object.values(_th.call.participants()).find(p => p.session_id === fromId);
  if(d.t === 'react' && _TH_REACTIONS.includes(d.e)) _thShowReaction(fromId, d.e);
  else if(d.t === 'chat' && typeof d.x === 'string'){
    _thAddChat(from ? from.user_name : 'Someone', d.x.slice(0, _TH_CHAT_MAX), false);
  }
  else if(d.t === 'lower' && me && d.to === me.session_id && _thIsAdmin(from)){
    _thSetHand(false);
    _thFlash('Your hand was lowered.');
  }
  else if(d.t === 'removed' && me && d.to === me.session_id && _thIsAdmin(from)){
    _th.ended = true;
    leaveTownhallRoom('You were removed from the townhall.');
  }
  else if(d.t === 'locks' && _thIsAdmin(from) && d.s && typeof d.s === 'object'){
    _th.locks = d.s;
    _th.sig = '';
    _thRender();
  }
  else if(d.t === 'unlocked' && me && (d.to === me.session_id || d.to === '*') && _thIsAdmin(from)){
    _thFlash(d.to === '*' ? 'Everyone can unmute again.' : 'You’ve been unmuted. Tap the mic to speak.');
  }
  else if(d.t === 'end' && from && from.owner){
    _th.ended = true;
    leaveTownhallRoom('The townhall has ended.');
  }
}

// ── Drawing ────────────────────────────────────────────────────────
function _thList(){
  const ps = Object.values(_th.call.participants());
  const rank = p => p.owner ? 0 : (_thIsAdmin(p) ? 1 : 2);
  return ps.sort((a, b) => (rank(a) - rank(b)) ||
    (new Date(a.joined_at || 0) - new Date(b.joined_at || 0)));
}

function _thRender(){
  if(!_th || !_th.call) return;
  const list = _thList();
  const me = _thMe();
  const sig = list.map(p => [p.session_id, p.user_name, (p.userData || {}).av, (p.userData || {}).hand ? 1 : 0, _thRole(p), _thMicOn(p) ? 1 : 0, _thCanSpeak(p) ? 1 : 0].join('|')).join(';');
  const sub = document.getElementById('th-sub');
  if(sub) sub.textContent = (_th.topic ? _th.topic + ' · ' : '') + list.length + ' here';
  if(me){
    const mic = document.getElementById('th-mic');
    const locked = !_thCanSpeak(me);
    if(locked && _thMicOn(me)) _th.call.setLocalAudio(false);
    const on = !locked && _thMicOn(me);
    if(mic){
      mic.innerHTML = _thSvg(locked ? 'lock' : (on ? 'mic' : 'mic-off'));
      mic.classList.toggle('on', on);
      mic.classList.toggle('locked', locked);
      mic.setAttribute('aria-label', locked ? 'Muted by a moderator' : (on ? 'Mute' : 'Unmute'));
    }
    const hand = document.getElementById('th-hand');
    if(hand) hand.classList.toggle('on', !!(me.userData || {}).hand);
  }
  if(sig === _th.sig) return;
  _th.sig = sig;
  const grid = document.getElementById('th-grid');
  if(!grid) return;
  // Update tiles in place, keyed by session id, so a reaction mid-animation or
  // a talking ring isn't wiped every time someone mutes or raises a hand.
  const keep = new Set();
  list.forEach((p, i) => {
    const sid = p.session_id;
    keep.add(sid);
    let t = _thTile(sid);
    if(!t){
      t = document.createElement('div');
      t.className = 'th-p';
      t.dataset.sid = sid;
      t.onclick = () => _thOpenPerson(sid);
      t.innerHTML = '<div class="th-av"><div class="th-avi"></div><span class="th-badge-slot"></span></div><div class="th-name"></div><div class="th-role"></div>';
    }
    const ud = p.userData || {};
    const av = _thSafeAv(ud.av);
    const avKey = av + '|' + (p.user_name || '');
    const avi = t.querySelector('.th-avi');
    if(avi.dataset.k !== avKey){ avi.dataset.k = avKey; avi.innerHTML = _avInner({ avatar_url: av, name: p.user_name }); }
    t.querySelector('.th-badge-slot').innerHTML = ud.hand ? '<span class="th-badge">✋</span>'
      : (!_thCanSpeak(p) ? '<span class="th-badge th-badge-lock">' + _thSvg('lock', 12) + '</span>'
      : (!_thMicOn(p) ? '<span class="th-badge">' + _thSvg('mic-off', 12) + '</span>' : ''));
    t.querySelector('.th-name').textContent = p.local ? (p.user_name || 'You') + ' (you)' : (p.user_name || 'Guest');
    t.querySelector('.th-role').textContent = _thRole(p);
    t.classList.toggle('speaking', _th.speaking.has(sid) && _thMicOn(p));
    if(grid.children[i] !== t) grid.insertBefore(t, grid.children[i] || null);
  });
  Array.from(grid.children).forEach(c => { if(!keep.has(c.dataset.sid)) c.remove(); });
}

function _thTile(sid){
  return document.querySelector('#th-grid .th-p[data-sid="' + (window.CSS && CSS.escape ? CSS.escape(sid) : sid) + '"]');
}
function _thSpeaking(sid, on){
  if(!_th) return;
  if(on) _th.speaking.add(sid); else _th.speaking.delete(sid);
  const t = _thTile(sid);
  if(t) t.classList.toggle('speaking', !!on);
}
function _thShowReaction(sid, emoji){
  const t = _thTile(sid);
  const av = t && t.querySelector('.th-av');
  if(!av) return;
  const old = av.querySelector('.th-rx'); if(old) old.remove();
  const x = document.createElement('div');
  x.className = 'th-rx';
  x.textContent = emoji;
  av.appendChild(x);
  setTimeout(() => x.remove(), 2600);
}

// ── Your own controls ──────────────────────────────────────────────
function _thToggleMic(){
  if(!_th || !_th.call) return;
  const me = _thMe();
  const on = !_thMicOn(me);
  if(on && !_thCanSpeak(me)){
    const lock = _thLockFor(me);
    _thFlash((lock && lock.name ? lock.name : 'A moderator') + ' muted you. Raise your hand to ask to speak.');
    return;
  }
  _th.call.setLocalAudio(on);
  if(on && (me.userData || {}).hand) _thSetHand(false); // speaking lowers your hand, like Spaces
}
function _thSetHand(up){
  if(!_th || !_th.call) return;
  const me = _thMe();
  const ud = Object.assign({}, (me && me.userData) || {}, { hand: up ? Date.now() : 0 });
  _th.call.setUserData(ud);
}
function _thToggleHand(){
  const me = _thMe();
  _thSetHand(!(me && (me.userData || {}).hand));
}
function _thReact(emoji){
  if(!_th || !_th.call || !_TH_REACTIONS.includes(emoji)) return;
  const now = Date.now();
  if(now - _th.lastReact < 700) return;
  _th.lastReact = now;
  _th.call.sendAppMessage({ t: 'react', e: emoji }, '*');
  const me = _thMe();
  if(me) _thShowReaction(me.session_id, emoji);
  _thCloseSheet();
}

// ── Sheets (reactions, chat, person, room menu) ────────────────────
function _thSheet(html){
  const wrap = document.getElementById('th-sheet-wrap');
  const sheet = document.getElementById('th-sheet');
  if(!wrap || !sheet) return;
  sheet.innerHTML = html;
  wrap.classList.add('show');
}
function _thCloseSheet(){
  const wrap = document.getElementById('th-sheet-wrap');
  if(wrap) wrap.classList.remove('show');
  if(_th) _th.chatOpen = false;
}
function _thSheetHead(title){
  return '<div class="th-sheet-head"><span>' + _esc(title) + '</span><button class="th-x" aria-label="Close" onclick="_thCloseSheet()">&times;</button></div>';
}

function _thOpenReactions(){
  _thSheet('<div class="th-reacts">' + _TH_REACTIONS.map(e =>
    '<button class="th-react-btn" onclick="_thReact(\'' + e + '\')">' + e + '</button>').join('') + '</div>');
}

function _thOpenChat(){
  if(!_th) return;
  _th.chatOpen = true;
  _th.unread = 0;
  _thUnread();
  _thSheet(_thSheetHead('Chat') +
    '<div class="th-chat-list" id="th-chat-list">' + _thChatHtml() + '</div>' +
    '<form class="th-chat-form" onsubmit="event.preventDefault();_thSendChat()">' +
      '<input id="th-chat-input" maxlength="' + _TH_CHAT_MAX + '" placeholder="Say something" autocomplete="off">' +
      '<button type="submit">Send</button>' +
    '</form>' +
    '<div class="th-chat-note">Chat is for this townhall only and isn’t saved.</div>');
  const list = document.getElementById('th-chat-list');
  if(list) list.scrollTop = list.scrollHeight;
}
function _thChatHtml(){
  if(!_th.chat.length) return '<div class="th-chat-empty">No messages yet.</div>';
  return _th.chat.map(m => '<div class="th-chat-msg' + (m.me ? ' me' : '') + '"><b>' + _esc(m.n) + '</b> ' + _esc(m.x) + '</div>').join('');
}
function _thAddChat(name, text, mine){
  if(!_th || !text.trim()) return;
  _th.chat.push({ n: name || 'Someone', x: text, me: mine });
  if(_th.chat.length > 200) _th.chat.shift();
  const list = document.getElementById('th-chat-list');
  if(_th.chatOpen && list){ list.innerHTML = _thChatHtml(); list.scrollTop = list.scrollHeight; }
  else if(!mine){ _th.unread++; _thUnread(); }
}
function _thUnread(){
  const u = document.getElementById('th-unread');
  if(u) u.classList.toggle('show', !!(_th && _th.unread));
}
function _thSendChat(){
  const inp = document.getElementById('th-chat-input');
  if(!inp || !_th || !_th.call) return;
  const text = inp.value.trim().slice(0, _TH_CHAT_MAX);
  if(!text) return;
  _th.call.sendAppMessage({ t: 'chat', x: text }, '*');
  const me = _thMe();
  _thAddChat(me ? me.user_name : 'You', text, true);
  inp.value = '';
  inp.focus();
}

function _thOpenPerson(sid){
  if(!_th || !_th.call) return;
  const me = _thMe();
  const p = Object.values(_th.call.participants()).find(x => x.session_id === sid);
  if(!p || p.local || !_thIsAdmin(me)) return;   // only hosts and co-hosts get person options
  const ud = p.userData || {};
  let html = _thSheetHead(p.user_name || 'Guest');
  if(me.owner && !p.owner){
    html += _thIsAdmin(p)
      ? '<button class="th-row" onclick="_thSetCohost(\'' + _esc(sid) + '\', false)">Remove as co-host</button>'
      : '<button class="th-row" onclick="_thSetCohost(\'' + _esc(sid) + '\', true)">Make co-host</button>';
  }
  if(ud.hand) html += '<button class="th-row" onclick="_thLowerHand(\'' + _esc(sid) + '\')">Lower hand</button>';
  if(!p.owner){   // hosts can't be muted
    const lock = _thLockFor(p);
    if(!lock) html += '<button class="th-row" onclick="_thMute(\'' + _esc(sid) + '\')">Mute</button>';
    else if(_thMayUnlock(lock)) html += '<button class="th-row" onclick="_thUnmute(\'' + _esc(sid) + '\')">Unmute</button>';
    else html += '<div class="th-row th-row-note">Muted by ' + _esc(lock.name || 'a moderator') + '</div>';
  }
  if(!p.owner) html += '<button class="th-row danger" onclick="_thRemove(\'' + _esc(sid) + '\')">Remove from townhall</button>';
  _thSheet(html);
}

function _thOpenRoomMenu(){
  const me = _thMe();
  let html = _thSheetHead('Townhall');
  if(_thIsAdmin(me)){
    const room = _th && _th.locks && _th.locks.room;
    if(!room) html += '<button class="th-row" onclick="_thMuteAll()">Mute everyone</button>';
    else if(_thMayUnlock(room)) html += '<button class="th-row" onclick="_thUnmuteAll()">Unmute everyone</button>';
    else html += '<div class="th-row th-row-note">Everyone muted by ' + _esc(room.name || 'a moderator') + '</div>';
  }
  if(me && me.owner) html += '<button class="th-row danger" onclick="_thEnd()">End townhall for everyone</button>';
  if(_th && _th.fallbackUrl) html += '<button class="th-row" onclick="_thOpenFallback()">Trouble hearing? Open in browser</button>';
  _thSheet(html);
}

// ── Host and co-host actions ───────────────────────────────────────
function _thPart(sid){ return _th && _th.call && Object.values(_th.call.participants()).find(x => x.session_id === sid); }

async function _thSetCohost(sid, on){
  const p = _thPart(sid);
  if(!p) return;
  _thCloseSheet();
  try {
    if(p.user_id){
      const r = await fetch(_SERVER_URL + '/townhall/cohost', {
        method: 'POST', headers: await _authHeaders(),
        body: JSON.stringify({ targetUserId: p.user_id, on: !!on, userName: (_thMe() || {}).user_name })
      });
      if(!r.ok) throw new Error('not allowed');
      const j = await r.json().catch(() => ({}));
      if(j.locks){ _th.locks = j.locks; _th.sig = ''; _th.call.sendAppMessage({ t: 'locks', s: j.locks }, '*'); }
    }
    _th.call.updateParticipant(sid, { updatePermissions: { canAdmin: on ? ['participants'] : [] } });
    _thFlash(on ? (p.user_name || 'They') + ' is now a co-host.' : (p.user_name || 'They') + ' is no longer a co-host.');
  } catch(e){ _thFlash('Could not change co-host. Try again.'); }
}
function _thLowerHand(sid){
  _th.call.sendAppMessage({ t: 'lower', to: sid }, sid);
  _thCloseSheet();
}
// Record the lock with the server, then share the new lock list with the room.
// Returns true when the server agreed.
async function _thSetLock(body){
  const me = _thMe();
  try {
    const r = await fetch(_SERVER_URL + '/townhall/mute', {
      method: 'POST', headers: await _authHeaders(),
      body: JSON.stringify(Object.assign({ userName: me && me.user_name }, body))
    });
    const j = await r.json().catch(() => ({}));
    if(j.locks && _th){ _th.locks = j.locks; _th.sig = ''; _th.call.sendAppMessage({ t: 'locks', s: j.locks }, '*'); }
    if(r.status === 409){ _thFlash('Already muted by ' + (j.by || 'another moderator') + '.'); _thRender(); return false; }
    if(!r.ok) throw new Error('not allowed');
    return true;
  } catch(e){ _thFlash('Could not change that. Try again.'); return false; }
}
const _TH_LOCK = { setAudio: false, updatePermissions: { canSend: false } };
const _TH_UNLOCK = { updatePermissions: { canSend: true } };

async function _thMute(sid){
  const p = _thPart(sid);
  _thCloseSheet();
  if(!p || p.owner || !await _thSetLock({ targetUserId: p.user_id, on: true })) return;
  _th.call.updateParticipant(sid, _TH_LOCK);
  _thRender();
}
async function _thUnmute(sid){
  const p = _thPart(sid);
  _thCloseSheet();
  if(!p || !await _thSetLock({ targetUserId: p.user_id, on: false })) return;
  if(!_thLockFor(p)){
    _th.call.updateParticipant(sid, _TH_UNLOCK);
    _th.call.sendAppMessage({ t: 'unlocked', to: sid }, sid);
  }
  _thRender();
}
// Locks everyone except hosts and you — and anyone who joins afterwards.
async function _thMuteAll(){
  _thCloseSheet();
  if(!await _thSetLock({ all: true, on: true })) return;
  const ups = {};
  _thList().forEach(p => { if(!p.local && !p.owner) ups[p.session_id] = _TH_LOCK; });
  if(Object.keys(ups).length) _th.call.updateParticipants(ups);
  _thFlash('Everyone else is muted.');
  _thRender();
}
async function _thUnmuteAll(){
  _thCloseSheet();
  if(!await _thSetLock({ all: true, on: false })) return;
  const ups = {};
  _thList().forEach(p => { if(!p.local && !p.owner && !_thLockFor(p) && !_thCanSpeak(p)) ups[p.session_id] = _TH_UNLOCK; });
  if(Object.keys(ups).length) _th.call.updateParticipants(ups);
  _th.call.sendAppMessage({ t: 'unlocked', to: '*' }, '*');
  _thFlash('Everyone can unmute again.');
  _thRender();
}
// Keep locks in force for people who join (or rejoin) after you muted them.
// Only the lock's holder does this (or a host, once the holder has gone), so
// two moderators never fight over someone's permission.
function _thEnforceLocks(){
  if(!_th || !_th.call) return;
  const me = _thMe();
  if(!_thIsAdmin(me)) return;
  const now = Date.now();
  _thList().forEach(p => {
    if(p.local || p.owner || !_thCanSpeak(p)) return;
    const lock = _thLockFor(p);
    if(!lock || !_thMayUnlock(lock)) return;
    if(now - (_th.enforced[p.session_id] || 0) < 3000) return;
    _th.enforced[p.session_id] = now;
    _th.call.updateParticipant(p.session_id, _TH_LOCK);
  });
}
async function _thRemove(sid){
  const p = _thPart(sid);
  if(!p) return;
  if(!confirm('Remove ' + (p.user_name || 'this person') + ' from the townhall? They won’t be able to rejoin it.')) return;
  _thCloseSheet();
  try {
    if(p.user_id){
      const r = await fetch(_SERVER_URL + '/townhall/remove', {
        method: 'POST', headers: await _authHeaders(),
        body: JSON.stringify({ targetUserId: p.user_id })
      });
      if(!r.ok) throw new Error('not allowed');
    }
    _th.call.sendAppMessage({ t: 'removed', to: sid }, sid);
    _th.call.updateParticipant(sid, { eject: true });
  } catch(e){ _thFlash('Could not remove them. Try again.'); }
}
async function _thEnd(){
  if(!confirm('End the townhall for everyone?')) return;
  _thCloseSheet();
  try {
    const r = await fetch(_SERVER_URL + '/townhall/end', {
      method: 'POST', headers: await _authHeaders(),
      body: JSON.stringify({ userId: currentUser && currentUser.id })
    });
    if(!r.ok) throw new Error('end failed');
    _th.ended = true;
    _th.call.sendAppMessage({ t: 'end' }, '*');
    try { _th.call.updateParticipants({ '*': { eject: true } }); } catch(_){}
    leaveTownhallRoom('You ended the townhall.');
  } catch(e){ _thFlash('Could not end the townhall. Try again.'); }
}
function _thOpenFallback(){
  const url = _th && _th.fallbackUrl;
  leaveTownhallRoom();
  if(url) window.open(url, '_blank');
}

// ── Icons (Feather-style, matching the app) ────────────────────────
function _thSvg(name, size){
  const s = size || 22;
  const open = '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  const paths = {
    'mic': '<rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/>',
    'mic-off': '<line x1="2" y1="2" x2="22" y2="22"/><path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.9-.6"/><path d="M17 16.9A7 7 0 0 1 5 11v-1m14 0v1a7 7 0 0 1-.1 1.2"/><line x1="12" y1="18" x2="12" y2="22"/>',
    'smile': '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>',
    'chat': '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.8-.9L3 21l1.9-5.2A8.4 8.4 0 1 1 21 11.5z"/>',
    'lock': '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    'dots': '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>'
  };
  return open + (paths[name] || '') + '</svg>';
}
