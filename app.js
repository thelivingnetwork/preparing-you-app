// ═════════════════════════ CONFIG ═════════════════════════
// Fill these in once the new Supabase project is created.
const _SB_URL  = 'https://qvcfgcwecykilbddgqzv.supabase.co';
const _SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF2Y2ZnY3dlY3lraWxiZGRncXp2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5NTQ2MzQsImV4cCI6MjA5MzUzMDYzNH0.cn-xvirE9JOG-m9vNFITVRiDLAZQQzE9yzoKEYUGUZg';
const _SERVER_URL = 'https://preparing-you-server.onrender.com';

// ═════════════════════════ ERROR REPORTING ═════════════════════════
// Self-hosted: forward uncaught errors, promise rejections, and CSP
// violations to the server's /client-error sink (→ prep_client_errors).
// Strictly fire-and-forget and heavily guarded — reporting must never throw,
// block, or loop. Deduped per-message and capped per session so a tight error
// loop can't flood the table.
const _ERR_VERSION = '2026-06-10';   // bump on notable releases for triage
const _errSeen = new Map();          // message -> last-sent ms
let _errCount = 0;                    // per-session cap
function _reportError(kind, message, stack, extra){
  try {
    if (_errCount >= 30) return;                       // session flood cap
    const key = kind + '|' + String(message || '').slice(0, 160);
    const now = Date.now();
    if (_errSeen.get(key) && (now - _errSeen.get(key)) < 60000) return; // dedupe 60s
    _errSeen.set(key, now);
    _errCount++;
    let uid = null;
    try { uid = (window.currentUser && (currentUser.id || currentUser.uid)) || null; } catch(_){}
    const body = JSON.stringify({
      kind: kind,
      message: String(message || '').slice(0, 2000),
      stack: stack ? String(stack).slice(0, 6000) : null,
      url: location.href,
      app_version: _ERR_VERSION,
      user_uid: uid,
      extra: extra || null
    });
    // keepalive so reports still flush during navigation/unload.
    fetch(_SERVER_URL + '/client-error', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: body, keepalive: true
    }).catch(function(){ /* swallow — never surface a reporting failure */ });
  } catch(_) { /* never throw from the reporter */ }
}
window.addEventListener('error', function(e){
  // Resource-load errors (img/script) have no e.error; still useful to know.
  var msg = (e && e.message) || (e && e.target && e.target.src ? ('resource load failed: ' + e.target.src) : 'unknown error');
  _reportError('error', msg, e && e.error && e.error.stack, { line: e && e.lineno, col: e && e.colno, src: e && e.filename });
});
window.addEventListener('unhandledrejection', function(e){
  var r = e && e.reason;
  _reportError('unhandledrejection', (r && (r.message || r)) || 'unhandled rejection', r && r.stack);
});
window.addEventListener('securitypolicyviolation', function(e){
  // Fires for both enforced and report-only CSP blocks — our visibility net
  // for anything the allow-list missed.
  _reportError('csp', e.violatedDirective + ' blocked ' + e.blockedURI, null,
    { directive: e.effectiveDirective, blockedURI: e.blockedURI, sourceFile: e.sourceFile, line: e.lineNumber });
});

// Build headers for an authenticated server call. The backend now derives the
// caller's identity from this Supabase access token (never from the request
// body), so every privileged endpoint must be called with these headers.
async function _authHeaders(extra){
  const h = Object.assign({ 'Content-Type':'application/json' }, extra||{});
  try {
    let { data:{ session } } = await _sb.auth.getSession();
    // Proactively refresh when the access token is missing or about to expire.
    // Safari/PWA tabs that have been backgrounded pause the auto-refresh timer,
    // so getSession() can hand back a stale token the server rejects as
    // invalid_token. Refreshing (via the longer-lived refresh token) avoids that.
    const _exp = session?.expires_at ? session.expires_at * 1000 : 0;
    if(!session?.access_token || (_exp && _exp < Date.now() + 60000)){
      try { const { data: _rd } = await _sb.auth.refreshSession(); if(_rd?.session) session = _rd.session; } catch(_){}
    }
    if(session?.access_token) h['Authorization'] = 'Bearer ' + session.access_token;
  } catch(_){}
  return h;
}

// Web Push — VAPID public key. Safe to expose; private key lives on the server.
const _VAPID_PUBLIC = 'BPWUdWr9Sf8hk1ydMdpRLIeH_ce8lNWyfMydf1bBfh0bJoP78o2JRG2GH28D33m4fuLXpBzdy8Vq9KKU14MaIvY';

// ── EmailJS (shared with The Living Network) ──
const EJS_PUB  = 'UXOmF9EejeF3j4EEZ';
const EJS_SVC  = 'service_l43x4ow';
const EJS_TMPL = 'template_xob8ydi';
let _ejsReady = false;
function _initEJS(){
  if(_ejsReady || typeof emailjs === 'undefined') return;
  try{ emailjs.init({publicKey: EJS_PUB}); _ejsReady = true; } catch(e){ console.warn('EJS init', e); }
}
function sendEmail(toName, toEmail, subject, message){
  _initEJS();
  if(!toEmail) return Promise.resolve();
  return emailjs.send(EJS_SVC, EJS_TMPL, {
    to_name: toName || 'Friend',
    email: toEmail,
    minister_name: 'Preparing You',
    message: message || '',
    subject: subject || 'Preparing You',
    from_name: 'Preparing You',
    company_name: 'Preparing You',
    company_email: 'tofnotifications@gmail.com',
    reply_to: 'tofnotifications@gmail.com'
  }).catch(e => console.warn('Email failed:', e));
}

// ── Password-recovery capture — MUST run before the supabase client below ──
// A reset link lands on the app with the access token in the URL hash
// (#...type=recovery) and, when the redirect URL is allow-listed, also ?reset=1.
// supabase-js (detectSessionInUrl, on by default) parses that token to establish
// the recovery session and then STRIPS the hash — so by window 'load' the signal
// is gone, and the old check fell through and auto-entered the app instead of
// showing the "set a new password" form. We capture the signal synchronously
// here, before the client exists, so the reset form reliably wins.
// Three recovery-link shapes are supported:
//   • ?token_hash=…&type=recovery  — robust query link; survives the mobile
//     email→browser handoff (a URL #fragment does NOT) — verified via verifyOtp
//   • #…type=recovery              — legacy implicit fragment (works on desktop)
//   • ?reset=1                     — legacy redirect marker
const _resetQuery = (function(){
  try {
    var q = new URLSearchParams(window.location.search || '');
    return { token_hash: q.get('token_hash') || '', type: q.get('type') || '', reset: q.get('reset') || '' };
  } catch(_) { return { token_hash:'', type:'', reset:'' }; }
})();
let _recoveryMode = (function(){
  try {
    var h = window.location.hash || '';
    return h.indexOf('type=recovery') >= 0
        || _resetQuery.reset === '1'
        || (!!_resetQuery.token_hash && _resetQuery.type === 'recovery');
  } catch(_) { return false; }
})();

const _sb = (window.supabase && _SB_URL.startsWith('http'))
  ? window.supabase.createClient(_SB_URL, _SB_ANON, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;

// ═════════════════════════ END-TO-END ENCRYPTION ═════════════════════════
// Password-locked E2EE for private messages. Each member has an ECDH P-256
// identity keypair generated on-device. The PUBLIC key is published; the
// PRIVATE key is wrapped with a key derived from the LOGIN PASSWORD (PBKDF2)
// and only that unreadable blob is stored server-side — so the server can
// never read messages, yet a member restores history on any device just by
// logging in (no extra passphrase). Messages are sealed with a per-pair
// AES-256-GCM key derived via ECDH + HKDF. All primitives are native Web
// Crypto. The private key is cached as a NON-EXTRACTABLE CryptoKey in
// IndexedDB; the raw JWK is held in memory for the session only (never
// persisted), so an attacker with the device storage still can't export it.
const E2EE = (() => {
  if(!(window.crypto && crypto.subtle)) {
    // Insecure context / ancient browser — degrade to no-E2EE (server-side).
    return { unavailable:true, ready:()=>false, forget:()=>{}, async loadCached(){return false;},
             async setupOrUnlock(){return 'error';}, async rewrap(){return false;},
             async encrypt(){throw new Error('e2ee unavailable');}, async decrypt(){throw new Error('e2ee unavailable');} };
  }
  const ALG_EC = { name:'ECDH', namedCurve:'P-256' };
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = str => Uint8Array.from(atob(str), c => c.charCodeAt(0));

  // ── IndexedDB cache for the non-extractable private CryptoKey ──
  const DB='pp_e2ee', STORE='keys';
  function _idb(){ return new Promise((res,rej)=>{ const r=indexedDB.open(DB,1);
    r.onupgradeneeded=()=>r.result.createObjectStore(STORE);
    r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
  async function _idbGet(k){ const db=await _idb(); return new Promise((res,rej)=>{ const t=db.transaction(STORE,'readonly').objectStore(STORE).get(k); t.onsuccess=()=>res(t.result); t.onerror=()=>rej(t.error); }); }
  async function _idbPut(k,v){ const db=await _idb(); return new Promise((res,rej)=>{ const t=db.transaction(STORE,'readwrite'); t.objectStore(STORE).put(v,k); t.oncomplete=()=>res(); t.onerror=()=>rej(t.error); }); }
  async function _idbDel(k){ const db=await _idb(); return new Promise((res,rej)=>{ const t=db.transaction(STORE,'readwrite'); t.objectStore(STORE).delete(k); t.oncomplete=()=>res(); t.onerror=()=>rej(t.error); }); }

  // ── session state (memory) ──
  let _priv = null;       // ECDH private CryptoKey (non-extractable)
  let _privJwk = null;    // raw JWK — memory only, for in-session re-wrap; never persisted
  let _myId = null;
  const _peerPub = new Map();   // peerId -> public CryptoKey
  const _shared = new Map();    // peerId -> AES-GCM CryptoKey

  async function _wrapKeyFromPassword(password, salt, iters){
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name:'PBKDF2', salt, iterations:iters, hash:'SHA-256' },
      base, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']);
  }
  async function _getPeerPublic(peerId){
    if(_peerPub.has(peerId)) return _peerPub.get(peerId);
    const { data } = await _sb.from('prep_public_keys').select('public_key').eq('user_id', peerId).maybeSingle();
    if(!data || !data.public_key){ _peerPub.set(peerId, null); return null; }
    const key = await crypto.subtle.importKey('jwk', JSON.parse(data.public_key), ALG_EC, false, []);
    _peerPub.set(peerId, key); return key;
  }
  async function _sharedKey(peerId){
    if(_shared.has(peerId)) return _shared.get(peerId);
    const pub = await _getPeerPublic(peerId);
    if(!pub || !_priv) return null;
    const bits = await crypto.subtle.deriveBits({ name:'ECDH', public: pub }, _priv, 256);
    const ikm = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    const info = enc.encode('pp-msg-v1:' + [_myId, peerId].sort().join(':')); // symmetric both sides
    const key = await crypto.subtle.deriveKey({ name:'HKDF', hash:'SHA-256', salt:new Uint8Array(0), info },
      ikm, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']);
    _shared.set(peerId, key); return key;
  }
  async function _storeBackup(userId, privJwk, password){
    const salt = crypto.getRandomValues(new Uint8Array(16)), iters = 310000;
    const wrapKey = await _wrapKeyFromPassword(password, salt, iters);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, wrapKey, enc.encode(JSON.stringify(privJwk)));
    await _sb.from('prep_key_backups').upsert({ user_id:userId, wrapped_private_key:b64(ct),
      kdf_salt:b64(salt), kdf_iterations:iters, wrap_iv:b64(iv), updated_at:new Date().toISOString() }, { onConflict:'user_id' });
  }
  async function _adopt(userId, privJwk){
    _privJwk = privJwk;
    _priv = await crypto.subtle.importKey('jwk', privJwk, ALG_EC, false, ['deriveBits','deriveKey']);
    _shared.clear();
    try { await _idbPut('priv:'+userId, _priv); } catch(_){}  // non-extractable; safe to persist
  }

  return {
    unavailable:false,
    ready(){ return !!_priv; },
    forget(){ _priv=null; _privJwk=null; _myId=null; _peerPub.clear(); _shared.clear(); },
    async clearDevice(userId){ this.forget(); try { await _idbDel('priv:'+userId); } catch(_){} },

    // Restore the cached private key without a password (fails after iOS eviction).
    async loadCached(userId){
      _myId = userId;
      try { const k = await _idbGet('priv:'+userId); if(k){ _priv = k; return true; } } catch(_){}
      return false;
    },

    // First-time setup OR unlock-from-backup using the login password.
    // Returns 'created' | 'unlocked' | 'error' (wrong password / failure).
    async setupOrUnlock(userId, password){
      _myId = userId;
      try {
        const { data: backup } = await _sb.from('prep_key_backups').select('*').eq('user_id', userId).maybeSingle();
        if(backup){
          const wrapKey = await _wrapKeyFromPassword(password, unb64(backup.kdf_salt), backup.kdf_iterations||310000);
          let jwkBuf;
          try { jwkBuf = await crypto.subtle.decrypt({ name:'AES-GCM', iv:unb64(backup.wrap_iv) }, wrapKey, unb64(backup.wrapped_private_key)); }
          catch(e){ return 'error'; } // wrong password → GCM auth fails
          await _adopt(userId, JSON.parse(dec.decode(jwkBuf)));
          return 'unlocked';
        }
        // Brand-new identity keypair.
        const pair = await crypto.subtle.generateKey(ALG_EC, true, ['deriveBits','deriveKey']);
        const pubJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
        const privJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
        await _sb.from('prep_public_keys').upsert({ user_id:userId, public_key:JSON.stringify(pubJwk), alg:'ECDH-P256', updated_at:new Date().toISOString() }, { onConflict:'user_id' });
        await _storeBackup(userId, privJwk, password);
        await _adopt(userId, privJwk);
        return 'created';
      } catch(e){ console.warn('[e2ee] setupOrUnlock failed', e); return 'error'; }
    },

    // Re-wrap the private key under a NEW password (in-session change, no history loss).
    async rewrap(userId, newPassword){
      if(!_privJwk) return false;           // post-reload we lack the raw JWK; caller falls back
      try { await _storeBackup(userId, _privJwk, newPassword); return true; } catch(_){ return false; }
    },

    // Forcibly start a FRESH identity under `password`, overwriting any existing
    // backup + public key. Used after a forgot-password reset, where the new
    // password can no longer unlock the old backup. Old E2EE history becomes
    // unreadable (the member accepted this), but messaging keeps working.
    async resetIdentity(userId, password){
      _myId = userId;
      try {
        const pair = await crypto.subtle.generateKey(ALG_EC, true, ['deriveBits','deriveKey']);
        const pubJwk  = await crypto.subtle.exportKey('jwk', pair.publicKey);
        const privJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
        await _sb.from('prep_public_keys').upsert({ user_id:userId, public_key:JSON.stringify(pubJwk), alg:'ECDH-P256', updated_at:new Date().toISOString() }, { onConflict:'user_id' });
        await _storeBackup(userId, privJwk, password);
        await _adopt(userId, privJwk);
        return true;
      } catch(e){ console.warn('[e2ee] resetIdentity failed', e); return false; }
    },

    // Encrypt plaintext for a peer → base64(iv || AES-GCM ciphertext).
    async encrypt(peerId, plaintext){
      const key = await _sharedKey(peerId);
      if(!key) throw new Error('no_shared_key');
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, enc.encode(plaintext));
      const packed = new Uint8Array(12 + ct.byteLength); packed.set(iv,0); packed.set(new Uint8Array(ct),12);
      return b64(packed);
    },
    // Decrypt base64(iv || ciphertext) from a peer → plaintext.
    async decrypt(peerId, packedB64){
      const key = await _sharedKey(peerId);
      if(!key) throw new Error('no_shared_key');
      const packed = unb64(packedB64);
      const pt = await crypto.subtle.decrypt({ name:'AES-GCM', iv:packed.slice(0,12) }, key, packed.slice(12));
      return dec.decode(pt);
    }
  };
})();

let currentUser = null;

// ═════════════════════════ AUTH UI ═════════════════════════
function showAuthTab(name){
  document.querySelectorAll('.auth-tab').forEach(t=>t.classList.remove('active'));
  const tab = document.getElementById('tab-'+name); if(tab) tab.classList.add('active');
  ['signin','join','forgot','reset'].forEach(n => {
    const p = document.getElementById('panel-'+n); if(p) p.style.display = (n===name) ? 'block' : 'none';
  });
}

function openForgotPassword(){
  document.getElementById('forgot-error').classList.remove('show');
  document.getElementById('forgot-success').style.display = 'none';
  document.getElementById('forgot-email').value = document.getElementById('si-email').value || '';
  showAuthTab('forgot');
}

async function doForgotPassword(){
  const email = document.getElementById('forgot-email').value.trim().toLowerCase();
  const err   = document.getElementById('forgot-error');
  const ok    = document.getElementById('forgot-success');
  err.classList.remove('show'); ok.style.display = 'none';
  if(!email){ err.textContent='Enter your email.'; err.classList.add('show'); return; }
  const { error } = await _sb.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + '/?reset=1'
  });
  if(error){ err.textContent = error.message; err.classList.add('show'); return; }
  ok.style.display = 'block';
}

async function doResetPassword(){
  const pw  = document.getElementById('reset-pw').value;
  const err = document.getElementById('reset-error');
  err.classList.remove('show');
  if(!pw || pw.length < 8){ err.textContent='Password must be at least 8 characters.'; err.classList.add('show'); return; }
  const { error } = await _sb.auth.updateUser({ password: pw });
  if(error){ err.textContent = error.message; err.classList.add('show'); return; }
  // Reset complete. Sign out and return to the login screen so the member signs
  // in fresh with their new password — clearer and more secure than silently
  // entering the app on the recovery session. The E2EE identity is re-keyed
  // under the new password on that next sign-in (doSignIn → _initE2EEWithPassword,
  // which starts a fresh identity since the old key backup can't be unlocked).
  _recoveryMode = false;
  let _email = '';
  try { const { data } = await _sb.auth.getSession(); _email = data?.session?.user?.email || ''; } catch(_){}
  try { await _sb.auth.signOut(); } catch(_){}
  currentUser = null;
  document.getElementById('reset-pw').value = '';
  history.replaceState({}, '', window.location.pathname);
  const si = document.getElementById('si-email'); if(si && _email) si.value = _email;
  const sp = document.getElementById('si-pw');   if(sp) sp.value = '';
  showAuthTab('signin');
  const ok = document.getElementById('signin-success'); if(ok) ok.style.display = 'block';
}

async function doSignIn(){
  const email = document.getElementById('si-email').value.trim().toLowerCase();
  const pw    = document.getElementById('si-pw').value;
  const err   = document.getElementById('signin-error');
  err.classList.remove('show');
  const _ss = document.getElementById('signin-success'); if(_ss) _ss.style.display='none';
  if(!_sb){ err.textContent='Supabase is not configured yet.'; err.classList.add('show'); return; }
  const { data, error } = await _sb.auth.signInWithPassword({ email, password: pw });
  if(error || !data?.user){ err.textContent='Invalid email or password.'; err.classList.add('show'); return; }
  await _loadProfile(data.user);
  await _initE2EEWithPassword(data.user.id, pw);
  enterApp();
}

// ── Region helpers ─────────────────────────────────────────────────────
// We keep ONE combined "State, Country" string in `region` (backward-compatible
// with matching, display and the server). These compose it from / split it back
// into the two form fields.
function _composeRegion(country, state){
  country = (country||'').trim(); state = (state||'').trim();
  if(country && state) return state + ', ' + country;
  return country || state;
}
function _regionCountry(region){
  region = (region||'').trim(); if(!region) return '';
  const i = region.lastIndexOf(',');
  return (i >= 0 ? region.slice(i+1) : region).trim();
}
function _regionState(region){
  region = (region||'').trim();
  const i = region.lastIndexOf(',');
  return i >= 0 ? region.slice(0, i).trim() : '';
}

// ── Password reveal + confirm-match (Join form) ────────────────────────
const _PW_EYE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const _PW_EYE_OFF = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.2A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a13.2 13.2 0 0 1-2.2 3M6.6 6.6A13.3 13.3 0 0 0 2 11s3.5 7 10 7a9 9 0 0 0 3.5-.7M3 3l18 18"/></svg>';
function _togglePwReveal(id, btn){
  const inp = document.getElementById(id); if(!inp) return;
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  btn.innerHTML = show ? _PW_EYE_OFF : _PW_EYE;
  btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
}
function _joinPwCheck(){
  const a = (document.getElementById('j-pw')||{}).value || '';
  const b = (document.getElementById('j-pw2')||{}).value || '';
  const m = document.getElementById('j-pw-match'); if(!m) return;
  if(!a && !b){ m.textContent=''; m.className='pw-match'; return; }
  if(a.length < 8){ m.textContent='Password must be at least 8 characters.'; m.className='pw-match bad'; return; }
  if(!b){ m.textContent=''; m.className='pw-match'; return; }
  if(a === b){ m.textContent='✓ Passwords match'; m.className='pw-match ok'; }
  else { m.textContent='Passwords don’t match yet.'; m.className='pw-match bad'; }
}

// Canonical country list — a fixed dropdown removes "USA" vs "United States"
// mismatches so country-based PCM matching is reliable. Stored as a '|'-joined
// string to avoid per-name quoting issues (apostrophes/accents).
const _COUNTRIES = ("Afghanistan|Albania|Algeria|Andorra|Angola|Antigua and Barbuda|Argentina|Armenia|Australia|Austria|Azerbaijan|Bahamas|Bahrain|Bangladesh|Barbados|Belarus|Belgium|Belize|Benin|Bhutan|Bolivia|Bosnia and Herzegovina|Botswana|Brazil|Brunei|Bulgaria|Burkina Faso|Burundi|Cabo Verde|Cambodia|Cameroon|Canada|Central African Republic|Chad|Chile|China|Colombia|Comoros|Congo (Brazzaville)|Congo (Kinshasa)|Costa Rica|Côte d'Ivoire|Croatia|Cuba|Cyprus|Czechia|Denmark|Djibouti|Dominica|Dominican Republic|Ecuador|Egypt|El Salvador|Equatorial Guinea|Eritrea|Estonia|Eswatini|Ethiopia|Fiji|Finland|France|Gabon|Gambia|Georgia|Germany|Ghana|Greece|Grenada|Guatemala|Guinea|Guinea-Bissau|Guyana|Haiti|Honduras|Hungary|Iceland|India|Indonesia|Iran|Iraq|Ireland|Israel|Italy|Jamaica|Japan|Jordan|Kazakhstan|Kenya|Kiribati|Kuwait|Kyrgyzstan|Laos|Latvia|Lebanon|Lesotho|Liberia|Libya|Liechtenstein|Lithuania|Luxembourg|Madagascar|Malawi|Malaysia|Maldives|Mali|Malta|Marshall Islands|Mauritania|Mauritius|Mexico|Micronesia|Moldova|Monaco|Mongolia|Montenegro|Morocco|Mozambique|Myanmar|Namibia|Nauru|Nepal|Netherlands|New Zealand|Nicaragua|Niger|Nigeria|North Korea|North Macedonia|Norway|Oman|Pakistan|Palau|Palestine|Panama|Papua New Guinea|Paraguay|Peru|Philippines|Poland|Portugal|Qatar|Romania|Russia|Rwanda|Saint Kitts and Nevis|Saint Lucia|Saint Vincent and the Grenadines|Samoa|San Marino|Sao Tome and Principe|Saudi Arabia|Senegal|Serbia|Seychelles|Sierra Leone|Singapore|Slovakia|Slovenia|Solomon Islands|Somalia|South Africa|South Korea|South Sudan|Spain|Sri Lanka|Sudan|Suriname|Sweden|Switzerland|Syria|Taiwan|Tajikistan|Tanzania|Thailand|Timor-Leste|Togo|Tonga|Trinidad and Tobago|Tunisia|Turkey|Turkmenistan|Tuvalu|Uganda|Ukraine|United Arab Emirates|United Kingdom|United States|Uruguay|Uzbekistan|Vanuatu|Vatican City|Venezuela|Vietnam|Yemen|Zambia|Zimbabwe").split('|');

// Fill a <select> with the country options, selecting `selected` if present.
// If an existing value isn't in the list (legacy free-text), it's added so the
// member's data is preserved rather than silently blanked on next save.
function _fillCountrySelect(sel, selected){
  if(!sel) return;
  selected = (selected || '').trim();
  let html = '<option value="">Select</option>';
  let found = false;
  for(const c of _COUNTRIES){
    const isSel = selected && c.toLowerCase() === selected.toLowerCase();
    if(isSel) found = true;
    html += '<option' + (isSel ? ' selected' : '') + '>' + c + '</option>';
  }
  if(selected && !found){ html += '<option selected>' + _esc(selected) + '</option>'; }
  sel.innerHTML = html;
}

// Populate the Join form's country dropdown as soon as the DOM is ready.
function _initJoinCountry(){ try { _fillCountrySelect(document.getElementById('j-country'), ''); } catch(e){} }
if(document.readyState !== 'loading') _initJoinCountry();
else document.addEventListener('DOMContentLoaded', _initJoinCountry);

async function doJoin(){
  const name   = document.getElementById('j-name').value.trim();
  const email  = document.getElementById('j-email').value.trim().toLowerCase();
  const country = document.getElementById('j-country').value.trim();
  const state   = document.getElementById('j-state').value.trim();
  const region  = _composeRegion(country, state);
  const pw      = document.getElementById('j-pw').value;
  const pw2     = document.getElementById('j-pw2').value;
  const err     = document.getElementById('join-error');
  err.classList.remove('show');
  if(!name || !email || !country || !pw || pw.length < 8){
    err.textContent='Please fill every field. Password must be at least 8 characters.';
    err.classList.add('show'); return;
  }
  if(pw !== pw2){
    err.textContent='Passwords don’t match. Please re-enter them.';
    err.classList.add('show'); return;
  }
  if(!_sb){ err.textContent='Supabase is not configured yet.'; err.classList.add('show'); return; }
  const { data, error } = await _sb.auth.signUp({
    email, password: pw,
    options: { data: { name, region } }
  });
  if(error){ err.textContent = error.message; err.classList.add('show'); return; }
  await _loadProfile(data.user);
  await _initE2EEWithPassword(data.user.id, pw);
  // Welcome email (client-side via EmailJS; server still inserts welcome notif)
  sendEmail(name, email, 'Welcome to Preparing You',
    'Peace to you, '+name+'.\n\nYou have begun the work of preparation. Three short videos and five short books wait inside, along with Paul — an AI guide drawn from those books — and a community of Personal Contact Ministers ready to walk this with you.\n\nBegin where you are: https://preparingyou.app');
  // Server still drops a notification + records the welcome event
  _authHeaders().then(h => fetch(_SERVER_URL + '/welcome', {
    method:'POST', headers: h,
    body: JSON.stringify({ userId: data.user.id, skipEmail: true })
  })).catch(()=>{});
  enterApp();
}

async function _loadProfile(authUser){
  // Upsert prep_users row keyed on auth.users.id
  if(_sb && authUser){
    // Each member's IANA timezone — lets townhall emails show the start time in
    // their own local time. Best-effort; older browsers may not resolve a zone.
    let tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch(e) {}
    const { data } = await _sb.from('prep_users').select('*').eq('id', authUser.id).maybeSingle();
    currentUser = data || {
      id: authUser.id,
      email: authUser.email,
      name: authUser.user_metadata?.name || authUser.email.split('@')[0],
      region: authUser.user_metadata?.region || '',
      timezone: tz || null
    };
    if(!data){
      await _sb.from('prep_users').insert(currentUser);
    } else if(tz && data.timezone !== tz){
      // Keep the stored zone in sync if the member moved / travels. Fire-and-forget.
      currentUser.timezone = tz;
      _sb.from('prep_users').update({ timezone: tz }).eq('id', authUser.id).then(()=>{}, ()=>{});
    }
  }
}

// ═══════════════════ E2EE KEY LIFECYCLE (UI glue) ═══════════════════
// Set up (or unlock) the member's encryption identity using their login
// password. If the old backup can't be opened (password was reset), start a
// fresh identity under the current password — old history is lost, which the
// member accepted when choosing password-locked E2EE.
async function _initE2EEWithPassword(userId, password){
  if(!E2EE || E2EE.unavailable || !userId || !password) return;
  try {
    const res = await E2EE.setupOrUnlock(userId, password);
    if(res === 'error') await E2EE.resetIdentity(userId, password);
  } catch(e){ console.warn('[e2ee] init failed', e); }
}

// Lazy unlock prompt — shown when the member opens Messenger but their key
// isn't loaded on this device (e.g. iOS evicted it). Non-blocking: the inbox
// still renders; encrypted messages read as locked until they unlock.
function _maybePromptE2EEUnlock(){
  if(!E2EE || E2EE.unavailable) return;   // no crypto here → legacy messaging
  if(E2EE.ready()) return;                 // already unlocked
  if(!currentUser || !currentUser.id) return;
  _openE2EEUnlock();
}
function _openE2EEUnlock(){
  let el = document.getElementById('e2ee-unlock');
  if(!el){
    el = document.createElement('div');
    el.id = 'e2ee-unlock';
    el.style.cssText = 'display:none;position:fixed;inset:0;z-index:10000;background:rgba(20,16,12,.55);align-items:center;justify-content:center;padding:24px';
    el.innerHTML =
      '<div style="background:var(--cream);border-radius:18px;max-width:360px;width:100%;padding:24px;box-shadow:0 18px 50px rgba(0,0,0,.3)">'
      + '<h2 style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;color:var(--walnut);margin:0 0 8px;font-size:24px">Unlock your messages</h2>'
      + '<p style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:var(--walnut-mid);margin:0 0 14px">Your private messages are end-to-end encrypted. Enter your password to unlock them on this device.</p>'
      + '<input id="e2ee-unlock-pw" class="form-input" type="password" placeholder="Your password" style="margin-bottom:10px" onkeydown="if(event.key===\'Enter\')doE2EEUnlock()">'
      + '<div id="e2ee-unlock-err" class="auth-error">That password didn\u2019t unlock your messages.</div>'
      + '<button class="btn-primary" style="width:100%" onclick="doE2EEUnlock()">Unlock</button>'
      + '<div style="text-align:center;margin-top:10px"><a onclick="closeE2EEUnlock()" style="font-size:12px;color:var(--walnut-mid);font-style:italic;cursor:pointer;text-decoration:underline">Not now</a></div>'
      + '</div>';
    document.body.appendChild(el);
  }
  const err = document.getElementById('e2ee-unlock-err'); if(err) err.classList.remove('show');
  const pw = document.getElementById('e2ee-unlock-pw'); if(pw) pw.value = '';
  el.style.display = 'flex';
  if(pw) setTimeout(() => pw.focus(), 50);
}
function closeE2EEUnlock(){
  const el = document.getElementById('e2ee-unlock'); if(el) el.style.display = 'none';
}
async function doE2EEUnlock(){
  const pwEl = document.getElementById('e2ee-unlock-pw');
  const err  = document.getElementById('e2ee-unlock-err');
  const pw   = pwEl ? pwEl.value : '';
  if(err) err.classList.remove('show');
  if(!pw){ if(err){ err.textContent='Please enter your password.'; err.classList.add('show'); } return; }
  const res = await E2EE.setupOrUnlock(currentUser.id, pw);
  if(res === 'unlocked' || res === 'created'){
    closeE2EEUnlock();
    _msgSig = ''; _inboxSig = null;           // force a fresh, decrypted render
    if(_msgView === 'thread') loadMessages(); else refreshInbox();
  } else {
    if(err){ err.textContent='That password didn\u2019t unlock your messages.'; err.classList.add('show'); }
  }
}

// ═════════════════════════ THEME ═════════════════════════
function toggleTheme(){
  const root = document.documentElement;
  const goingDark = root.getAttribute('data-theme') !== 'dark';
  if (goingDark) root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme');
  try { localStorage.setItem('pp_theme', goingDark ? 'dark' : 'light'); } catch (e) {}
}

// ═════════════════════════ APP NAV ═════════════════════════
// ── Background pollers (POLLERGUARD-MARKER) ──────────────────────────
// 30s safety-net refreshes for the message badge, nav badges and townhall
// card. Guarded so re-entering the app never stacks duplicate timers, and
// paused while the tab is backgrounded so a long idle session stops doing
// wasted network + render work. Realtime channels stay subscribed the whole
// time, so live updates keep arriving regardless of these fallbacks.
let _msgBadgeTimer = null;
let _appPollersOn = false;
function _startAppPollers(){
  _stopAppPollers();
  _appPollersOn = true;
  _msgBadgeTimer     = setInterval(refreshMessageBadge, 30000);
  _notifPollTimer    = setInterval(refreshNavBadges, 30000);
  _townhallPollTimer = setInterval(refreshTownhallCard, 30000);
}
function _stopAppPollers(){
  _appPollersOn = false;
  if(_msgBadgeTimer) clearInterval(_msgBadgeTimer);
  if(_notifPollTimer) clearInterval(_notifPollTimer);
  if(_townhallPollTimer) clearInterval(_townhallPollTimer);
  _msgBadgeTimer = null; _notifPollTimer = null; _townhallPollTimer = null;
}
document.addEventListener('visibilitychange', () => {
  const inApp = document.getElementById('screen-app');
  if(!currentUser || !inApp || !inApp.classList.contains('active')) return;
  if(document.visibilityState === 'hidden'){
    _stopAppPollers();
  } else if(!_appPollersOn){
    // Back in the foreground: refresh once immediately, then resume polling.
    refreshMessageBadge(); refreshNavBadges(); refreshTownhallCard();
    _startAppPollers();
  }
});

function enterApp(){
  if(!currentUser) return;
  // First-run gate: members must accept the community guidelines once before
  // entering. Re-running enterApp() after acceptance falls through to the app.
  if(!currentUser.guidelines_accepted_at){
    document.getElementById('screen-landing').classList.remove('active');
    document.getElementById('screen-app').classList.remove('active');
    document.getElementById('guidelines-gate').style.display = 'flex';
    return;
  }
  document.getElementById('guidelines-gate').style.display = 'none';
  document.getElementById('screen-landing').classList.remove('active');
  document.getElementById('screen-app').classList.add('active');
  if(window.syncNavClearance) window.syncNavClearance(); // nav now rendered — measure it
  _refreshProfileAv();
  showPage('home');
  refreshMessageBadge();
  refreshNavBadges();
  refreshTownhallCard();
  renderAlmanac();
  _startAppPollers();
  _subscribeNotifRealtime();
  _subscribeMsgRealtime();
  _maybeOfferPushPrompt();
  _maybeShowIosInstallHint();
  _maybeShowAndroidInstallHint();
}

// Stamp acceptance of the first-run community guidelines, then enter the app.
async function acceptGuidelines(){
  const btn = document.getElementById('gl-accept-btn');
  const err = document.getElementById('gl-err');
  if(err) err.style.display = 'none';
  if(btn){ btn.disabled = true; btn.textContent = 'Entering…'; }
  const now = new Date().toISOString();
  try {
    if(_sb && currentUser && currentUser.id){
      const { error } = await _sb.from('prep_users')
        .update({ guidelines_accepted_at: now }).eq('id', currentUser.id);
      if(error) throw new Error(error.message);
    }
    currentUser.guidelines_accepted_at = now;
    enterApp();
  } catch(e){
    if(btn){ btn.disabled = false; btn.textContent = 'Accept & Enter'; }
    if(err) err.style.display = 'block';
  }
}

// Share the app via the device's native share sheet, falling back to copying
// the link when Web Share isn't available (e.g. some desktop browsers).
async function shareApp(){
  const url = 'https://preparingyou.app';
  // Distinct URL key so iOS/Android don't reuse a stale cached link preview.
  const shareUrl = 'https://preparingyou.app/?s=tln';
  const data = { title: 'Preparing You', text: 'I\u2019d like to share Preparing You with you \u2014 a quiet place to begin your preparation.', url: shareUrl };
  if(navigator.share){
    try { await navigator.share(data); } catch(_){ /* user cancelled — ignore */ }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    alert('Link copied:\n' + url);
  } catch(_){
    window.prompt('Copy this link to share Preparing You:', url);
  }
}

function showPage(name){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  const p = document.getElementById('page-'+name); if(p) p.classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b=>{
    if(b.getAttribute('onclick')?.includes("'"+name+"'")) b.classList.add('active');
  });
  window.scrollTo(0,0);
  // Lazy-load page contents on entry
  if(name === 'pcm') buildPcmPage();
  if(name === 'join-tln') buildJoinTlnPage();
  if(name === 'library') buildLibraryPage();
  if(name === 'video') buildGatewayPage();
  if(name !== 'video') stopGatewayPlayer();
  if(name === 'home'){ refreshHomeTiles(); refreshTownhallCard(); renderAlmanac(); }
  if(name === 'books') buildBooksPage();
  if(name !== 'books') closeBookListen();
  if(name === 'messages') buildMessagesPage();
  // The Messages screen is a fixed chat layout: lock the shell to the
  // viewport height so the thread (not the page) scrolls and the compose bar
  // stays pinned above the nav. Every other page scrolls normally.
  document.documentElement.classList.toggle('chat-lock', name === 'messages');
  if(name === 'messages') _enableMsgViewport(); else _disableMsgViewport();
  // Visiting a page clears the red badge on its nav icon (Messages clears its
  // own badge when the thread opens + marks messages read server-side).
  _clearNavNotifs(name);
}

// ═════════════════════════ JOIN TLN ═════════════════════════
async function buildJoinTlnPage(){
  if(!_sb || !currentUser) return;
  // Cache-first paint from what we already know in memory, then refresh in the
  // background (gate fields + book progress in parallel) and re-paint.
  const paint = () => {
    if(_gateJourneyPage('page-join-tln', 'join-tln-content', 4)) return;
    const cta = document.getElementById('join-tln-cta');
    const empty = document.getElementById('join-tln-empty');
    const text = document.getElementById('join-tln-text');
    // Reaching this page means the journey gate passed — all five book audio
    // overviews are complete (stage 4). That IS the requirement for entering
    // The Living Network; no PCM sign-off needed for the door itself.
    cta.style.display = 'block';
    empty.style.display = 'none';
    text.textContent = 'You have listened to all five books — the door is open. '
      + 'Join The Living Network with your REAL name and a REAL email address: '
      + 'your church record forms (the Declaration of Sacred Purpose and the records of the congregation) are generated from them.';
    const whenEl = document.getElementById('join-tln-when');
    if(whenEl){
      if(currentUser.tln_invited_at){
        const when = new Date(currentUser.tln_invited_at);
        whenEl.textContent = 'Invited ' + when.toLocaleString(undefined, { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
      } else {
        whenEl.textContent = '';
      }
    }
  };
  paint();
  await Promise.all([ _refreshJourneyFields(), loadBookAudioProgress() ]);
  paint();
}

function openTlnHandoff(){
  if(!currentUser) return;
  // Deliberately NO name/email in the handoff: Preparing You permits aliases
  // and alternate emails, but The Living Network needs real details (church
  // record forms are generated from them) — the user types those fresh on
  // TLN's Join screen. The opaque pyid links the two accounts so TLN's
  // Overseer seal can later unlock Volunteer-as-PCM here.
  const handoff = 'https://livingnetwork.netlify.app/?'
    + 'from=preparingyou'
    + '&pyid=' + encodeURIComponent(currentUser.id || '');
  window.open(handoff, '_blank');
}

// ── TLN seal check (cross-app) ────────────────────────────────────
// Asks The Living Network's Supabase whether this PY account belongs to a
// CURRENT sealed congregant (boolean-only RPC, safe with the public anon
// key). Cached per session only — membership can end (account deletion), so
// the verdict must not be persisted on the device.
const TLN_SB_URL  = 'https://ahtdvcqyxxjdqrkxsovw.supabase.co';
const TLN_SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFodGR2Y3F5eHhqZHFya3hzb3Z3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwOTcwODcsImV4cCI6MjA5MTY3MzA4N30.NHv2uVAvPNWFmVYPL1xqwhOwpw-RdYWFt4X-XQF-Gdg';
let _tlnSealedCache = null;   // null = unknown this session
async function tlnIsSealedMember(){
  if(!currentUser) return false;
  if(_tlnSealedCache !== null) return _tlnSealedCache;
  try{
    const r = await fetch(TLN_SB_URL + '/rest/v1/rpc/tln_is_sealed_member', {
      method:'POST',
      headers:{ apikey: TLN_SB_ANON, Authorization:'Bearer '+TLN_SB_ANON, 'Content-Type':'application/json' },
      body: JSON.stringify({ p_pyid: String(currentUser.id||''), p_email: String(currentUser.email||'') })
    });
    if(!r.ok) return false;          // fail closed, don't cache failures
    _tlnSealedCache = (await r.json()) === true;
    return _tlnSealedCache;
  }catch(_){ return false; }
}

// ═════════════════════════ TOWNHALL ═════════════════════════
let _townhallState = null;        // last fetched state from /townhall/state
let _townhallIsHost = false;      // am I in prep_townhall_hosts?
let _townhallPollTimer = null;
const TOWNHALL_MINUTES = 120; // mirrors server TOWNHALL_AUTOCLOSE_MS (auto-close after 120 min)

async function refreshTownhallCard(){
  if(!_sb || !currentUser) return;

  // Are we a host? (cached after first lookup)
  if(_townhallIsHost === false){
    const { data: hostRow } = await _sb.from('prep_townhall_hosts').select('user_id').eq('user_id', currentUser.id).maybeSingle();
    _townhallIsHost = !!hostRow;
  }

  let st = null;
  try {
    const r = await fetch(_SERVER_URL + '/townhall/state');
    if(r.ok) st = await r.json();
  } catch(_){}
  _townhallState = st;

  const card = document.getElementById('townhall-card');
  const banner = document.getElementById('live-banner');
  if(!card) return;
  if(!st){ card.style.display='none'; if(banner) banner.style.display='none'; return; }

  card.style.display = 'block';
  const at = new Date(st.scheduled_at);
  const end = new Date(at.getTime() + TOWNHALL_MINUTES * 60000);
  const _thDay = at.toLocaleString(undefined, { weekday:'short', month:'short', day:'numeric' });
  const _thTime = d => d.toLocaleString(undefined, { hour:'numeric', minute:'2-digit' });
  const localTime = _thDay + ' \u00b7 ' + _thTime(at) + ' \u2013 ' + _thTime(end);

  if(st.isLive){
    document.getElementById('townhall-title-text').textContent = '🔴 Townhall is LIVE';
    document.getElementById('townhall-when').textContent = 'Started ' + new Date(st.live_at).toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
    document.getElementById('townhall-text').textContent = (st.topic || 'Townhall') + ' — tap to join';
    if(banner) banner.style.display = 'block';
  } else {
    document.getElementById('townhall-title-text').textContent = (st.title || 'Weekly Townhall');
    document.getElementById('townhall-when').textContent = localTime;
    document.getElementById('townhall-text').textContent = (st.topic || 'Open discussion') + ' — click to join at the scheduled time';
    if(banner) banner.style.display = 'none';
  }

  // Host-only control: End early. Townhalls auto-open on schedule and
  // auto-close after 120 min, so there is no manual Start — a host just taps the
  // live card to join. End lets them wrap up before the auto-close.
  const actions = document.getElementById('townhall-actions');
  const endBtn = document.getElementById('townhall-end-btn');
  if(_townhallIsHost && st.isLive){
    actions.style.display = 'block';
    endBtn.style.display = 'inline-block';
  } else {
    actions.style.display = 'none';
    endBtn.style.display = 'none';
  }

  // Replay button — most recent ended townhall with a recording_url
  const replayWrap = document.getElementById('townhall-replay');
  if(replayWrap){
    const { data: lastRec } = await _sb.from('prep_townhalls')
      .select('id, recording_url, ended_at, title')
      .not('recording_url', 'is', null).not('ended_at', 'is', null)
      .order('ended_at', { ascending:false }).limit(1).maybeSingle();
    if(lastRec?.recording_url){
      replayWrap.style.display = 'block';
      replayWrap.dataset.url = lastRec.recording_url;
    } else {
      replayWrap.style.display = 'none';
      delete replayWrap.dataset.url;
    }
  }
}

function replayLastTownhall(){
  const url = document.getElementById('townhall-replay')?.dataset?.url;
  if(url) window.open(url, '_blank');
}

function onTownhallCardClick(){
  if(_townhallState?.isLive) joinTownhall();
  // not live: the townhall opens automatically at its scheduled time — nothing
  // to do yet (applies to hosts and members alike).
}

async function startTownhall(){
  if(!_sb || !currentUser) return;
  try {
    const r = await fetch(_SERVER_URL + '/townhall/start', {
      method:'POST', headers: await _authHeaders(),
      body: JSON.stringify({ userId: currentUser.id, userName: currentUser.name || 'Host' })
    });
    const j = await r.json();
    if(!r.ok) throw new Error(j.error || 'start failed');
    window.open(j.url, '_blank');
    refreshTownhallCard();
  } catch(e){
    alert('Could not start: ' + e.message);
  }
}

async function endTownhall(){
  if(!confirm('End the townhall for everyone?')) return;
  try {
    const r = await fetch(_SERVER_URL + '/townhall/end', {
      method:'POST', headers: await _authHeaders(),
      body: JSON.stringify({ userId: currentUser.id })
    });
    if(!r.ok){ const j = await r.json(); throw new Error(j.error || 'end failed'); }
    refreshTownhallCard();
  } catch(e){
    alert('Could not end: ' + e.message);
  }
}

async function joinTownhall(){
  if(!_sb || !currentUser) return;
  try {
    const r = await fetch(_SERVER_URL + '/townhall/join', {
      method:'POST', headers: await _authHeaders(),
      body: JSON.stringify({ userId: currentUser.id, userName: currentUser.name || 'Guest' })
    });
    const j = await r.json();
    if(!r.ok){
      if(j.error === 'not_started') alert(j.message || 'The townhall has not started yet.');
      else throw new Error(j.error || 'join failed');
      return;
    }
    window.open(j.url, '_blank');
  } catch(e){
    alert('Could not join: ' + e.message);
  }
}

// ═════════════════════════ MESSAGES ═════════════════════════
let _msgPeerId = null;
let _msgPollTimer = null;
let _msgSig = '';            // signature of the last-rendered message set
let _msgRenderedPeer = null; // peer whose thread is currently rendered

let _msgPeers = [];          // everyone the member can message (for "New message")
let _msgConvos = [];         // conversation rows from /messages/inbox
let _msgView = 'list';       // 'list' (inbox) | 'thread'
let _msgOpenPeer = null;     // peer to deep-link straight into a thread
let _pendingAttachment = null; // { url, name, type }
const _ATTACH_MAX_BYTES = 25 * 1024 * 1024; // 25 MB

// Find a peer's identity (name/avatar/role/region) from whichever source
// has it — the messageable-peers list or the conversation rows.
function _findPeer(id){
  return _msgPeers.find(p => p.id === id) || _msgConvos.find(c => c.peerId === id) || null;
}

async function buildMessagesPage(){
  if(!_sb || !currentUser) return;
  // If our encryption key isn't loaded on this device (e.g. iOS evicted it),
  // offer to unlock with the password before reading the thread / inbox.
  _maybePromptE2EEUnlock();

  // Deep-link straight into a thread (PCM "Message" button / New-message pick).
  // A brand-new thread has no inbox row yet, so its header identity comes from
  // the peer directory — wait for it on that path only.
  if(_msgOpenPeer){
    const id = _msgOpenPeer; _msgOpenPeer = null;
    await _loadMsgPeers();
    await openThread(id);
    return;
  }
  // Normal inbox open: the peer directory is only needed for the "New message"
  // picker, so load it in the BACKGROUND and render the inbox right away rather
  // than blocking on a second server round-trip.
  _loadMsgPeers();
  await showMsgList();
}

// Fetch everyone this member can message (server bypasses RLS). Used for the
// "New message" picker and as a thread-header identity fallback.
async function _loadMsgPeers(){
  if(!_sb || !currentUser) return;
  try {
    const r = await fetch(_SERVER_URL + '/peers', {
      method:'POST', headers: await _authHeaders(),
      body: JSON.stringify({ userId: currentUser.id })
    });
    const j = await r.json();
    if(r.ok) _msgPeers = j.peers || [];
  } catch(e){ console.warn('peers fetch failed', e); }
}

// ── Inbox (conversation list) ──────────────────────────────────────
async function showMsgList(){
  _msgView = 'list';
  _closeTypingChannel(); // leaving the thread — drop its typing channel
  closeNewMessagePicker();
  document.getElementById('msg-thread-wrap').style.display = 'none';
  _msgUnpin(); // release the viewport pin so the inbox lays out normally
  document.getElementById('msg-empty').style.display = 'none';
  document.getElementById('msg-inbox').style.display = 'flex';
  await refreshInbox();
  if(_msgPollTimer) clearInterval(_msgPollTimer);
  _msgPollTimer = setInterval(() => {
    if(document.getElementById('page-messages').classList.contains('active') && _msgView === 'list') refreshInbox();
  }, 15000); // Realtime is primary now; this is a dropped-socket fallback
}

async function refreshInbox(){
  if(!_sb || !currentUser) return;
  let convos = [];
  try {
    // Use _authHeaders() (not a raw getSession token): a backgrounded iOS PWA
    // pauses Supabase's auto-refresh timer, so the cached token can be expired.
    // _authHeaders refreshes it, otherwise the server 401s and the inbox renders
    // blank with no error.
    const r = await fetch(_SERVER_URL + '/messages/inbox', {
      method:'POST',
      headers: await _authHeaders()
    });
    const j = await r.json().catch(() => ({}));
    if(r.ok) convos = j.conversations || [];
  } catch(e){ return; } // offline / transient — keep prior render
  // Decrypt previews for client-encrypted conversations (server can't read them).
  for(const c of convos){
    if(c && c.last_e2ee && c.last_preview){
      if(E2EE && !E2EE.unavailable && E2EE.ready()){
        try { c.last_preview = await E2EE.decrypt(c.peerId, c.last_preview); }
        catch(e){ c.last_preview = '\uD83D\uDD12 Encrypted message'; }
      } else { c.last_preview = '\uD83D\uDD12 Encrypted message'; }
    }
  }
  _msgConvos = convos;
  renderInbox();
  refreshMessageBadge();
}

let _inboxSig = null;
function renderInbox(){
  const listEl  = document.getElementById('msg-convo-list');
  const emptyEl = document.getElementById('msg-inbox-empty');
  if(!_msgConvos.length){
    _inboxSig = '';
    listEl.innerHTML = '';
    emptyEl.innerHTML = _msgPeers.length
      ? '<span class="ico"><svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg></span>No conversations yet. Tap the + to reach out to your PCM.'
      : '<span class="ico"><svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg></span>You’ll be able to message your PCM here once your choice is accepted.';
    emptyEl.style.display = 'block';
    return;
  }
  // Skip the rebuild when nothing changed, so the 6s poll never snaps a row
  // closed mid-swipe or flickers the list.
  const sig = _msgConvos.map(c => c.peerId + ':' + c.last_at + ':' + c.unread).join('|');
  if(sig === _inboxSig) return;
  _inboxSig = sig;
  emptyEl.style.display = 'none';
  listEl.innerHTML = _msgConvos.map(c => {
    const unread = c.unread > 0;
    const prev = (c.last_mine ? 'You: ' : '') + (c.last_preview || '');
    return '<div class="convo-swipe">'
      + '<button class="convo-del" onclick="hideConvo(\'' + c.peerId + '\',event)">Delete</button>'
      + '<div class="convo-row' + (unread ? ' unread' : '') + '" data-peer="' + c.peerId + '" onclick="onConvoTap(\'' + c.peerId + '\',event,this)">'
      + '<div class="convo-av">' + _avInner(c) + '</div>'
      + '<div class="convo-main">'
      +   '<div class="convo-top"><span class="convo-name">' + _esc(c.name) + '</span>'
      +     '<span class="convo-time">' + _msgTime(c.last_at) + '</span></div>'
      +   '<div class="convo-sub"><span class="convo-prev">' + (prev ? _esc(prev) : '<i>No messages</i>') + '</span>'
      +     (unread ? '<span class="convo-badge">' + (c.unread > 9 ? '9+' : c.unread) + '</span>' : '')
      +   '</div>'
      + '</div>'
      + '</div>'
      + '</div>';
  }).join('');
  _wireConvoSwipe();
}

// ── Left-swipe to reveal a per-row Delete ──────────────────────────
const _CONVO_ACTION_W = 88;     // width of the revealed Delete button
let _convoSwipeWired = false;
let _convoDrag = null;          // active drag: {row, startX, startY, baseX, dir, moved}
let _convoTapBlock = false;     // swallow the click that trails a swipe

function _convoRowX(row){ return parseFloat(row.dataset.x || '0'); }
function _setConvoRowX(row, x, animate){
  row.style.transition = animate ? 'transform .2s ease' : 'none';
  row.style.transform = 'translateX(' + x + 'px)';
  row.dataset.x = x;
  row.dataset.open = (x <= -_CONVO_ACTION_W + 1) ? '1' : '';
}
function _closeConvoRow(row){ if(row) _setConvoRowX(row, 0, true); }
function _closeOtherConvoRows(except){
  document.querySelectorAll('#msg-convo-list .convo-row').forEach(r => {
    if(r !== except && _convoRowX(r) !== 0) _setConvoRowX(r, 0, true);
  });
}
function _wireConvoSwipe(){
  if(_convoSwipeWired) return;
  const list = document.getElementById('msg-convo-list');
  if(!list) return;
  _convoSwipeWired = true;
  list.addEventListener('touchstart', e => {
    const row = e.target.closest('.convo-row');
    if(!row){ _convoDrag = null; return; }
    const t = e.touches[0];
    _convoDrag = { row, startX:t.clientX, startY:t.clientY, baseX:_convoRowX(row), dir:null, moved:false };
    row.style.transition = 'none';
  }, { passive:true });
  list.addEventListener('touchmove', e => {
    if(!_convoDrag) return;
    const t = e.touches[0];
    const dx = t.clientX - _convoDrag.startX;
    const dy = t.clientY - _convoDrag.startY;
    if(_convoDrag.dir === null){
      if(Math.abs(dx) < 8 && Math.abs(dy) < 8) return;   // wait for a clear intent
      _convoDrag.dir = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
      if(_convoDrag.dir === 'h') _closeOtherConvoRows(_convoDrag.row);
    }
    if(_convoDrag.dir !== 'h') return;                    // vertical → let the list scroll
    e.preventDefault();
    const x = Math.max(-_CONVO_ACTION_W, Math.min(0, _convoDrag.baseX + dx));
    _convoDrag.row.style.transform = 'translateX(' + x + 'px)';
    _convoDrag.row.dataset.x = x;
    _convoDrag.moved = true;
  }, { passive:false });
  const endDrag = () => {
    if(!_convoDrag) return;
    const { row, dir, moved } = _convoDrag;
    if(dir === 'h'){
      const open = _convoRowX(row) < -_CONVO_ACTION_W * 0.4;  // forgiving snap threshold
      _setConvoRowX(row, open ? -_CONVO_ACTION_W : 0, true);
      if(moved){ _convoTapBlock = true; setTimeout(() => { _convoTapBlock = false; }, 400); }
    }
    _convoDrag = null;
  };
  list.addEventListener('touchend', endDrag, { passive:true });
  list.addEventListener('touchcancel', endDrag, { passive:true });
}

// Tap an open row to close it; swallow the click that trails a swipe;
// otherwise open the conversation.
function onConvoTap(peerId, ev, row){
  if(row && row.dataset.open === '1'){ _closeConvoRow(row); return; }
  if(_convoTapBlock) return;
  openThread(peerId);
}

// Hide a conversation from my inbox (non-destructive — see /messages/clear).
async function hideConvo(peerId, ev){
  if(ev) ev.stopPropagation();
  const prev = _msgConvos;
  _msgConvos = _msgConvos.filter(c => c.peerId !== peerId);
  renderInbox();
  try {
    const r = await fetch(_SERVER_URL + '/messages/clear', {
      method:'POST',
      headers: await _authHeaders(),
      body: JSON.stringify({ peerId })
    });
    if(!r.ok){ const j = await r.json().catch(() => ({})); throw new Error(j.error || r.status); }
    refreshMessageBadge();
  } catch(e){
    _msgConvos = prev;          // restore the row on failure
    _inboxSig = null;           // force a re-render
    renderInbox();
    alert('Could not delete conversation: ' + (e.message || e));
  }
}

// ── Thread (individual conversation) ───────────────────────────────
async function openThread(id){
  _msgPeerId = id;
  _msgView = 'thread';
  _msgSig = ''; _msgRenderedPeer = null; // force a fresh render
  _hidePeerTyping();
  _openTypingChannel(id); // ephemeral typing-presence channel for this conversation
  closeNewMessagePicker();
  document.getElementById('msg-inbox').style.display = 'none';
  document.getElementById('msg-empty').style.display = 'none';
  document.getElementById('msg-thread-wrap').style.display = 'flex';
  _enableMsgViewport(); // pin the thread to the visual viewport (keyboard-safe)
  _wireMsgScroll();     // let the user break out of auto-pin by scrolling up
  await renderActivePeer();
  if(_msgPollTimer) clearInterval(_msgPollTimer);
  _msgPollTimer = setInterval(() => {
    if(document.getElementById('page-messages').classList.contains('active') && _msgView === 'thread') loadMessages();
  }, 12000); // Realtime is primary now; this is a dropped-socket fallback
}

async function renderActivePeer(){
  const peer = _findPeer(_msgPeerId);
  document.getElementById('msg-peer-av').innerHTML = peer ? _avInner(peer) : '?';
  document.getElementById('msg-peer-name').textContent = (peer && peer.name) || '—';
  document.getElementById('msg-peer-role').textContent = peer
    ? ((peer.role || '') + (peer.region ? ' · ' + peer.region : ''))
    : '';
  // One-way system sender (e.g. "Preparing You"): read-only thread — no reply
  // box, no call button, a small "can't reply" note instead.
  const sys = !!(peer && peer.is_system);
  const _compose = document.getElementById('msg-compose');
  if(_compose) _compose.style.display = sys ? 'none' : 'flex';
  const _note = document.getElementById('msg-readonly-note');
  if(_note) _note.style.display = sys ? 'block' : 'none';
  const _call = document.getElementById('msg-call-btn');
  if(_call) _call.style.display = sys ? 'none' : 'inline-flex';
  await loadMessages();
}

// ── New-message picker ─────────────────────────────────────────────
async function openNewMessagePicker(){
  const listEl = document.getElementById('msg-newpicker-list');
  document.getElementById('msg-newpicker').style.display = 'flex';
  // Peers load in the background when Messages opens; if the user taps + before
  // they arrive, fetch on demand (brief loading state) instead of wrongly
  // claiming there's no one to message.
  if(!_msgPeers.length){
    listEl.innerHTML = '<div class="empty" style="padding:24px">Loading…</div>';
    await _loadMsgPeers();
  }
  if(!_msgPeers.length){
    listEl.innerHTML = '<div class="empty" style="padding:24px"><span class="ico"><svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></span>There’s no one to message yet. Once your PCM choice is accepted, they’ll appear here.</div>';
  } else {
    listEl.innerHTML = _msgPeers.map(p =>
      '<div class="picker-row" onclick="openThread(\'' + p.id + '\')">'
      + '<div class="convo-av" style="width:42px;height:42px;font-size:13px">' + _avInner(p) + '</div>'
      + '<div class="convo-main"><div class="convo-name">' + _esc(p.name) + '</div>'
      +   '<div class="convo-prev">' + _esc((p.role || '') + (p.region ? ' · ' + p.region : '')) + '</div></div>'
      + '</div>'
    ).join('');
  }
}
function closeNewMessagePicker(){
  const el = document.getElementById('msg-newpicker');
  if(el) el.style.display = 'none';
}

// Relative timestamp for inbox rows: just-now / 5m / 3h / Tue / Apr 3.
function _msgTime(iso){
  if(!iso) return '';
  const d = new Date(iso), now = new Date();
  const s = Math.floor((now - d) / 1000);
  if(s < 45) return 'now';
  if(s < 3600) return Math.floor(s / 60) + 'm';
  if(s < 86400) return Math.floor(s / 3600) + 'h';
  if(s < 7 * 86400) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Pin the thread to the newest message. We can't trust a single synchronous
// scroll right after innerHTML: the serif bubble font re-wraps and heights
// settle a frame or two later, so scrollHeight grows after we set it and the
// view ends up a couple of messages short of the bottom. So we "stick" to the
// bottom and keep re-pinning until scrollHeight stops growing (font reflow done),
// plus re-pin when web fonts finish and when each image/attachment loads. The
// stick flag is cleared the moment the user scrolls up, so we never fight them.
let _msgStick = false;

// Re-pin to the bottom only if we're still in stick mode (set by a scroll-to-
// bottom and not yet cancelled by the user scrolling up).
function _msgPinIfStuck(){
  if(!_msgStick) return;
  const list = document.getElementById('msg-list');
  if(list) list.scrollTop = list.scrollHeight;
}

function _scrollMsgBottom(){
  const list = document.getElementById('msg-list');
  if(!list) return;
  _msgStick = true;
  let last = -1, stable = 0;
  const tick = () => {
    if(!_msgStick) return;
    list.scrollTop = list.scrollHeight;
    if(list.scrollHeight !== last){ last = list.scrollHeight; stable = 0; }
    else stable++;
    // Keep going until height has held steady for several frames (reflow settled).
    if(stable < 8) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // Web fonts can land well after the first frames; re-pin when they're ready.
  if(document.fonts && document.fonts.ready){
    document.fonts.ready.then(() => { if(_msgStick && list) list.scrollTop = list.scrollHeight; });
  }
}

// Wire a one-time scroll listener that drops stick mode as soon as the user
// scrolls meaningfully up from the bottom, so auto-pinning never traps them.
let _msgScrollWired = false;
let _lastMsgScrollTop = 0;
function _wireMsgScroll(){
  if(_msgScrollWired) return;
  const list = document.getElementById('msg-list');
  if(!list) return;
  _msgScrollWired = true;
  list.addEventListener('scroll', () => {
    const top = list.scrollTop;
    const fromBottom = list.scrollHeight - top - list.clientHeight;
    // Require scrollTop to have actually decreased (a genuine upward drag) before
    // letting go of the bottom — a viewport resize raises fromBottom on its own.
    if(fromBottom > 40 && top < _lastMsgScrollTop - 2) _msgStick = false;
    _lastMsgScrollTop = top;
  }, { passive: true });
}

// The soft keyboard is the hard part on phones. Earlier we tried resizing the
// shared app shell to visualViewport.height, but that shell also holds the top
// header and the *fixed* bottom nav, and it ignored the iOS viewport shift
// (vv.offsetTop) — so "the bottom" was mis-located and the newest message drifted
// down behind the keyboard. Instead, mirror the Paul drawer exactly: while a
// thread is open, pin the thread panel to the visual-viewport rectangle
// (top = offsetTop, height = vv.height), full-bleed above the keyboard. The panel
// is then independent of the app chrome, so the compose bar sits flush over the
// keyboard and the list re-pins to the true bottom.
let _msgVVHandler = null;
function _msgUnpin(){
  const wrap = document.getElementById('msg-thread-wrap');
  if(!wrap) return;
  wrap.classList.remove('msg-pinned');
  wrap.style.position = ''; wrap.style.left = ''; wrap.style.right = '';
  wrap.style.top = ''; wrap.style.bottom = ''; wrap.style.height = ''; wrap.style.zIndex = '';
}
function _msgFitViewport(e){ // MSGVIEWPORT-FIX-MARKER
  const vv = window.visualViewport;
  if(!vv) return;
  const wrap = document.getElementById('msg-thread-wrap');
  if(!wrap || wrap.style.display === 'none') return; // only act on an open thread
  // Keyboard is "open" when the visual viewport is meaningfully shorter than the
  // layout viewport. A collapsing Safari toolbar only trims ~60-100px, so a 150px
  // threshold isolates a real soft keyboard from incidental toolbar shifts.
  const kbOpen = (window.innerHeight - vv.height) > 150;
  if(kbOpen){
    // Keyboard up: float the thread over the keys, mirroring the visual-viewport
    // rectangle so the compose bar sits flush above the keyboard.
    wrap.classList.add('msg-pinned');
    wrap.style.position = 'fixed';
    wrap.style.left = '0'; wrap.style.right = '0';
    wrap.style.top = vv.offsetTop + 'px';
    wrap.style.bottom = 'auto';
    wrap.style.height = vv.height + 'px';
    wrap.style.zIndex = '60';
  } else {
    // Keyboard down: give layout back to the native flex+dvh shell (no JS height
    // mirroring) and restore the bottom-nav clearance on the compose bar.
    _msgUnpin();
  }
  // Only a resize (real geometry change) re-pins to the newest message; a bare
  // visualViewport scroll must not fight the user while they read back.
  if((!e || e.type === 'resize') && _msgStick) _scrollMsgBottom();
}
function _enableMsgViewport(){
  if(!window.visualViewport) return;
  if(!_msgVVHandler){
    _msgVVHandler = _msgFitViewport;
    window.visualViewport.addEventListener('resize', _msgVVHandler);
    window.visualViewport.addEventListener('scroll', _msgVVHandler);
  }
  _msgFitViewport();
}
function _disableMsgViewport(){
  if(window.visualViewport && _msgVVHandler){
    window.visualViewport.removeEventListener('resize', _msgVVHandler);
    window.visualViewport.removeEventListener('scroll', _msgVVHandler);
  }
  _msgVVHandler = null;
  _msgUnpin();
}

async function loadMessages(){
  if(!_msgPeerId) return;
  // Message bodies are encrypted at rest; only the server (which holds the
  // key) can return plaintext, and only to the two participants. So the
  // thread is fetched from /messages/thread rather than read directly.
  // Use _authHeaders() so a stale token on a backgrounded iOS PWA is refreshed
  // rather than silently 401'ing and leaving the thread blank.
  let msgs = [];
  try {
    const r = await fetch(_SERVER_URL + '/messages/thread', {
      method: 'POST',
      headers: await _authHeaders(),
      body: JSON.stringify({ peerId: _msgPeerId })
    });
    const j = await r.json().catch(() => ({}));
    if(r.ok) msgs = j.messages || [];
  } catch(e){ /* offline / transient — keep prior render */ return; }
  // Decrypt client-encrypted (e2ee) bodies in place before rendering. Every
  // message in this thread is with the same peer (_msgPeerId), so the shared
  // key is identical for messages I sent and ones I received.
  for(const m of msgs){
    if(m && m.e2ee && m.body){
      try { m.body = await E2EE.decrypt(_msgPeerId, m.body); }
      catch(e){ m.body = '\uD83D\uDD12 Encrypted — unlock your messages on this device to read this.'; }
    }
  }
  const list = document.getElementById('msg-list');

  // Skip the rebuild when nothing changed. The 5s poll would otherwise reflow
  // the thread and re-download attachment images (signed URLs change each
  // fetch), which is what made the view flicker and jump.
  // Include per-message read state so the poll re-renders when the peer reads
  // my message (the id set is unchanged, only read_at flips) — drives "Seen".
  const sig = (msgs || []).map(m => m.id + (m.read_at ? 'r' : '') + '|' + (m.reactions ? Object.keys(m.reactions).sort().map(k => k.slice(0,6) + m.reactions[k]).join('') : '')).join(',');
  const peerChanged = _msgRenderedPeer !== _msgPeerId;
  if(sig === _msgSig && !peerChanged){ refreshMessageBadge(); return; }

  // Preserve scroll position unless the user is already at the bottom, just
  // opened this thread, or the newest message is their own (just sent).
  const nearBottom = (list.scrollHeight - list.scrollTop - list.clientHeight) < 80;
  const prevTop = list.scrollTop;
  const lastMine = msgs.length && msgs[msgs.length - 1].sender_id === currentUser.id;

  const CALL_TTL_MS = 10 * 60 * 1000;
  const _bubbles = (msgs || []).map(m => {
    const mine = m.sender_id === currentUser.id;
    const ageMs = Date.now() - new Date(m.created_at).getTime();
    const isCallInvite = /daily\.co\//.test(m.body);
    const expired = isCallInvite && ageMs > CALL_TTL_MS;
    // Auto-link URLs (https only). For Daily.co room URLs we route through joinDailyLink so
    // the recipient mints their own token instead of joining as the caller. Expired calls
    // get a visual dim + strikethrough but remain technically clickable.
    let linked = _esc(m.body).replace(/(https?:\/\/[^\s]+)/g, (url) => {
      const linkColor = mine?'var(--cream)':'var(--accent-ink)';
      const decor = expired ? 'line-through' : 'underline';
      const op = expired ? 'opacity:.55;' : '';
      if(/daily\.co\//.test(url)){
        // Daily room names are restricted to [A-Za-z0-9_-]; strip anything else
        // so an attacker-controlled message body can't break out of the onclick.
        const room = (url.split('/').pop() || '').split('?')[0].replace(/[^A-Za-z0-9_-]/g, '');
        return `<a href="javascript:void(0)" onclick="joinDailyLink('${room}')" style="${op}color:${linkColor};text-decoration:${decor}">${url}</a>`;
      }
      return `<a href="${url}" target="_blank" rel="noopener" style="${op}color:${linkColor};text-decoration:${decor}">${url}</a>`;
    });
    if(expired) linked += ` <span style="font-size:11px;font-style:italic;opacity:.7">(expired)</span>`;
    const att = _renderAttachment(m, mine);
    const hasBody = !!(m.body && m.body.trim());
    const inner = (hasBody ? linked : '') + (hasBody && att ? '<div style="height:8px"></div>' : '') + att;
    const _rc = m.reactions ? Object.values(m.reactions) : [];
    const _rcCounts = {}; _rc.forEach(e => { _rcCounts[e] = (_rcCounts[e] || 0) + 1; });
    const _rcStr = Object.keys(_rcCounts).map(e => e + (_rcCounts[e] > 1 ? '<span style="font-size:11px;margin-left:1px">' + _rcCounts[e] + '</span>' : '')).join(' ');
    const _rcHtml = _rcStr ? `<div class="msg-react" style="margin-top:-7px;background:var(--cream);border:1px solid var(--terra-soft);border-radius:12px;padding:0 6px;font-size:14px;line-height:1.5;box-shadow:0 1px 3px rgba(0,0,0,.18)">${_rcStr}</div>` : '';
    const _bub = `<div class="msg-bubble" style="padding:8px 12px;border-radius:16px;background:${mine?'var(--teal)':'var(--terra-soft)'};color:${mine?'var(--cream)':'var(--walnut)'};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:18px;line-height:1.5;white-space:pre-wrap;word-break:break-word;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none${expired?';opacity:.75':''}">${inner}</div>`;
    return `<div class="msg-item" data-mid="${m.id}" style="align-self:${mine?'flex-end':'flex-start'};max-width:80%;display:flex;flex-direction:column;align-items:${mine?'flex-end':'flex-start'}">${_bub}${_rcHtml}<div class="msg-time" style="display:none;font-size:11px;color:var(--walnut-mid);margin:3px 4px 1px">${_fmtMsgTime(m.created_at)}</div></div>`;
  }).join('');

  // Read receipt: if my message is the newest in the thread, show its delivery
  // state underneath it (read_at comes from /messages/thread). When the peer is
  // the last to speak they've clearly seen mine, so no receipt is shown.
  let _receipt = '';
  const _lastMsg = msgs.length ? msgs[msgs.length - 1] : null;
  if(_lastMsg && _lastMsg.sender_id === currentUser.id){
    const _seen = !!_lastMsg.read_at;
    _receipt = `<div style="align-self:flex-end;font-size:11px;font-style:italic;color:var(--walnut-mid);margin:-2px 2px 2px">${_seen ? 'Seen' : 'Delivered'}</div>`;
  }
  list.innerHTML = _bubbles + _receipt;
  _wireMsgInteractions();

  if(peerChanged || nearBottom || lastMine) _scrollMsgBottom();
  else { _msgStick = false; list.scrollTop = prevTop; }

  // Image attachments load after innerHTML and push the thread taller; re-pin to
  // the bottom as each one settles (only while we're still sticking).
  list.querySelectorAll('img').forEach(img => {
    if(img.complete) return;
    img.addEventListener('load', _msgPinIfStuck, { once: true });
    img.addEventListener('error', _msgPinIfStuck, { once: true });
  });

  _msgSig = sig;
  _msgRenderedPeer = _msgPeerId;

  // Inbound messages are marked read server-side by /messages/thread.
  refreshMessageBadge();
}

// ─────────── Messenger interactions: tap-back reactions + tap-for-time ───────────
// Short tap on a bubble toggles its day/time line; a long-press (or right-click)
// opens an emoji picker. Reactions persist server-side (one per user per message).
const _REACT_EMOJIS = ['❤️', '😆', '😮', '😢', '😠', '👍'];
let _hapticEl = null;
function _ensureHaptic(){
  if(_hapticEl) return _hapticEl;
  try {
    const l = document.createElement('label');
    l.setAttribute('aria-hidden', 'true');
    // Must be RENDERED (in layout) for the switch toggle to fire the Taptic
    // engine on iOS — display:none / opacity:0 suppress the haptic. Park it
    // off-screen so it is laid out but never seen.
    l.style.cssText = 'position:fixed;left:-9999px;top:0;width:24px;height:16px;pointer-events:none';
    const c = document.createElement('input');
    c.type = 'checkbox'; c.setAttribute('switch', '');
    l.appendChild(c);
    document.body.appendChild(l);
    _hapticEl = l;
  } catch(_){}
  return _hapticEl;
}
function _haptic(){ // HAPTICv3-MARKER
  if(navigator.vibrate){ try { navigator.vibrate(10); } catch(_){} }
  try { const el = _ensureHaptic(); if(el) el.click(); } catch(_){}
}
function _fmtMsgTime(iso){
  if(!iso) return '';
  try { return new Date(iso).toLocaleString(undefined, { weekday:'short', day:'numeric', month:'short', hour:'numeric', minute:'2-digit' }); }
  catch(_){ return ''; }
}
function _toggleMsgTime(item){
  const t = item.querySelector('.msg-time'); if(!t) return;
  const show = (t.style.display === 'none' || !t.style.display);
  t.style.display = show ? 'block' : 'none';
  if(show && _msgStick) _scrollMsgBottom();
}
let _reactPopupEl = null;
function _reactOutside(e){ if(_reactPopupEl && !_reactPopupEl.contains(e.target)) _closeReactionPopup(); }
function _closeReactionPopup(){
  if(_reactPopupEl){ _reactPopupEl.remove(); _reactPopupEl = null; document.removeEventListener('pointerdown', _reactOutside, true); }
}
function _openReactionPopup(item){
  _closeReactionPopup();
  const mid = item.getAttribute('data-mid'); if(!mid) return;
  const bub = item.querySelector('.msg-bubble'); if(!bub) return;
  const rect = bub.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.style.cssText = 'position:fixed;z-index:80;display:flex;gap:4px;padding:6px 8px;background:var(--cream,#f5efe4);border:1px solid var(--terra-soft,#e6d8c3);border-radius:26px;box-shadow:0 6px 20px rgba(0,0,0,.28)';
  pop.innerHTML = _REACT_EMOJIS.map(e => '<button type="button" data-emoji="' + e + '" style="background:none;border:none;font-size:27px;line-height:1;padding:2px 3px;cursor:pointer">' + e + '</button>').join('');
  document.body.appendChild(pop);
  let top = rect.top - pop.offsetHeight - 8;
  if(top < 8) top = Math.min(rect.bottom + 8, window.innerHeight - pop.offsetHeight - 8);
  let left = rect.left;
  if(left + pop.offsetWidth > window.innerWidth - 8) left = window.innerWidth - 8 - pop.offsetWidth;
  if(left < 8) left = 8;
  pop.style.top = top + 'px'; pop.style.left = left + 'px';
  pop.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    // Buzz here: picking a reaction is a genuine tap, the one context where iOS
    // will actually run the Taptic from a web page (a mid-hold buzz is native-only).
    const em = b.getAttribute('data-emoji'); _haptic(); _closeReactionPopup(); reactToMessage(mid, em);
  }));
  _reactPopupEl = pop;
  setTimeout(() => document.addEventListener('pointerdown', _reactOutside, true), 0);
}
async function reactToMessage(mid, emoji){
  try {
    const r = await fetch(_SERVER_URL + '/messages/react', {
      method:'POST', headers: await _authHeaders(),
      body: JSON.stringify({ messageId: mid, emoji })
    });
    if(!r.ok){ const j = await r.json().catch(() => ({})); alert('Could not add reaction: ' + (j.error || r.status)); return; }
    _msgSig = ''; // force the next render to include the new reaction
    loadMessages();
  } catch(e){ alert('Could not add reaction: ' + e.message); }
}
let _msgInteractWired = false;
let _lpTimer = null, _lpStartXY = null, _lpFired = false, _lpHapticDone = false;
function _lpHaptic(){ if(_lpHapticDone) return; _lpHapticDone = true; _haptic(); } // LPHAPTIC-MARKER
function _wireMsgInteractions(){
  if(_msgInteractWired) return;
  const list = document.getElementById('msg-list');
  if(!list) return;
  _msgInteractWired = true;
  _ensureHaptic();
  const cancelLP = () => { if(_lpTimer){ clearTimeout(_lpTimer); _lpTimer = null; } _lpStartXY = null; };
  list.addEventListener('pointerdown', e => {
    const item = e.target.closest('.msg-item');
    if(!item || e.target.closest('a,button')) return;
    _lpFired = false; _lpHapticDone = false; _lpStartXY = { x:e.clientX, y:e.clientY };
    _lpTimer = setTimeout(() => {
      _lpFired = true; _lpTimer = null;
      // Android can buzz straight from the timer (navigator.vibrate works in the
      // activation window). iOS cannot fire a haptic from a timer, so there we
      // defer the buzz to the trusted finger-lift handler (lpLift) below.
      if(navigator.vibrate){ try { navigator.vibrate(10); } catch(_){} _lpHapticDone = true; }
      _openReactionPopup(item);
    }, 450);
  });
  list.addEventListener('pointermove', e => {
    if(_lpStartXY && (Math.abs(e.clientX - _lpStartXY.x) > 10 || Math.abs(e.clientY - _lpStartXY.y) > 10)) cancelLP();
  });
  // The reaction tray is appended to <body>, so when the finger lifts after a
  // long-press it is usually OVER the tray, not over #msg-list — a list-scoped
  // listener misses that lift entirely (the bug that left the long-press silent
  // on iOS). Listen at the window in the capture phase so we always catch it,
  // and fire the haptic there: the lift is a trusted, user-activated event, the
  // only context in which iOS will actually run the Taptic for a long-press.
  const lpLift = () => { if(_lpFired){ _lpFired = false; _lpHaptic(); } };
  window.addEventListener('pointerup', lpLift, true);
  window.addEventListener('touchend', lpLift, true);
  list.addEventListener('pointerup', e => {
    // A long-press already buzzed + opened the tray; don't also toggle the time.
    if(_lpHapticDone || _lpFired){ cancelLP(); return; }
    cancelLP();
    const item = e.target.closest('.msg-item');
    if(!item || e.target.closest('a,button')) return;
    _toggleMsgTime(item);
  });
  list.addEventListener('pointercancel', cancelLP);
  // Desktop right-click still opens the tray (and buzzes where supported).
  list.addEventListener('contextmenu', e => {
    const item = e.target.closest('.msg-item');
    if(item){ e.preventDefault(); _lpHaptic(); _openReactionPopup(item); }
  });
}

async function sendMessage(){
  const input = document.getElementById('msg-input');
  const text = (input.value || '').trim();
  const attach = _pendingAttachment;
  if(!text && !attach){ return; } // nothing to send
  if(!_msgPeerId){
    alert('No peer selected. Refresh the page.');
    return;
  }
  if(!currentUser?.id){
    alert('You appear to be signed out. Refresh and sign in again.');
    return;
  }
  input.value = '';
  clearAttachment();
  // End-to-end encrypt the text body to the peer's published key when ours is
  // unlocked. If anything is missing we fall back to legacy server-side
  // encryption so a message is never lost.
  let _bodyOut = text, _e2ee = false;
  if(text && E2EE && !E2EE.unavailable && E2EE.ready()){
    try { _bodyOut = await E2EE.encrypt(_msgPeerId, text); _e2ee = true; }
    catch(e){ _bodyOut = text; _e2ee = false; }
  }
  const r = await fetch(_SERVER_URL + '/messages/send', {
    method: 'POST',
    headers: await _authHeaders(),
    body: JSON.stringify({
      senderId: currentUser.id, recipientId: _msgPeerId, body: _bodyOut, e2ee: _e2ee,
      attachmentPath: attach?.path || null, attachmentName: attach?.name || null, attachmentType: attach?.type || null
    })
  });
  if(!r.ok){
    const j = await r.json().catch(() => ({}));
    if(j.error === 'readonly_recipient'){
      // Replied into a one-way "Preparing You" thread (stale/cached client).
      // Don't restore the text — it can't be sent. Lock the thread read-only.
      const _c = document.getElementById('msg-compose'); if(_c) _c.style.display = 'none';
      const _n = document.getElementById('msg-readonly-note'); if(_n) _n.style.display = 'block';
      const _cb = document.getElementById('msg-call-btn'); if(_cb) _cb.style.display = 'none';
      alert('This is a one-way message from Preparing You \u2014 you can\u2019t reply to it.');
      return;
    }
    input.value = text; // restore so they don't lose their message
    _autoGrow(input);
    if(attach){ _pendingAttachment = attach; _renderAttachChip(); } // restore attachment too
    alert('Could not send: ' + (j.error || r.status));
    return;
  }
  _autoGrow(input); // collapse the box back to one line after sending
  _closeEmoji('msg-emoji','msg-emoji-btn');
  await loadMessages();
}

// ═══════════════ COMPOSER UX — grow-with-text + emoji ═══════════════
// COMPOSER-UX-MARKER
// Grow a textarea with its content up to data-maxh (px), then scroll inside.
// An empty textarea reports an inflated scrollHeight (a phantom extra line) in
// some engines, so when the box is empty we drop the inline height and let the
// rows="1" default size it back to a single line.
function _autoGrow(el){
  if(!el) return;
  if(!el.value){ el.style.height = ''; el.style.overflowY = 'hidden'; return; }
  const max = parseInt(el.dataset.maxh || '140', 10);
  el.style.height = 'auto';
  const sh = el.scrollHeight;
  el.style.height = Math.min(sh, max) + 'px';
  el.style.overflowY = sh > max ? 'auto' : 'hidden';
}

// Curated, faith-friendly emoji set for the Messenger-style picker. No library.
const _EMOJIS = [
  ['Smileys', '😀 😃 😄 😁 😆 😅 😂 🤣 🙂 🙃 😉 😊 😇 🥰 😍 😘 😗 😙 😚 😋 😛 😜 🤪 😝 🤗 🤭 🤫 🤔 😶 😐 😏 😌 😔 😪 😴 🥺 😢 😭 😤 😠 🤯 😳 🥳 😎 🤩 😬'],
  ['Gestures', '👍 👎 👌 ✌️ 🤞 🤟 🤙 👋 🙌 👏 🙏 💪 🤝 👐 ✋ 🤲 👀'],
  ['Hearts', '❤️ 🧡 💛 💚 💙 💜 🤎 🖤 🤍 💕 💞 💓 💗 💖 💘 💝 ❣️'],
  ['Faith & Nature', '✝️ 🙏 🕊️ 📖 ✨ ⭐ 🌟 🔥 🌈 🌿 🌸 🌻 🌅 🍞 🍷 🕯️ 👑 ⛪'],
  ['Symbols', '🎉 🎊 ✅ ❌ ⚠️ ❓ ❗ 💯 💬 📞 📌 ☕ 🎵 🔔 ⏰ 📅']
];

// Recently-used emoji (most-recent-first), persisted across sessions.
function _emojiRecents(){
  try { return JSON.parse(localStorage.getItem('pu_emoji_recent') || '[]'); } catch(_){ return []; }
}
function _pushEmojiRecent(emoji){
  let r = _emojiRecents().filter(function(x){ return x !== emoji; });
  r.unshift(emoji);
  r = r.slice(0, 16);
  try { localStorage.setItem('pu_emoji_recent', JSON.stringify(r)); } catch(_){}
}
function _emojiCell(targetId, e){
  return '<button type="button" onclick="_pickEmoji(\'' + targetId + '\',\'' + e + '\')">' + e + '</button>';
}

// Rebuild a panel's grid each time it opens, so the Recent row stays fresh.
function _buildEmojiPanel(panelId, targetId){
  const panel = document.getElementById(panelId);
  if(!panel) return;
  let html = '';
  const recents = _emojiRecents();
  if(recents.length){
    html += '<div class="emoji-cat">Recent</div><div class="emoji-grid">'
          + recents.map(function(e){ return _emojiCell(targetId, e); }).join('')
          + '</div>';
  }
  html += _EMOJIS.map(function(pair){
    const cells = pair[1].trim().split(/\s+/).map(function(e){ return _emojiCell(targetId, e); }).join('');
    return '<div class="emoji-cat">' + pair[0] + '</div><div class="emoji-grid">' + cells + '</div>';
  }).join('');
  panel.innerHTML = html;
}

// Insert an emoji at the cursor without stealing focus (keeps the panel open
// for rapid entry and avoids re-summoning the soft keyboard).
function _pickEmoji(targetId, emoji){
  const el = document.getElementById(targetId);
  if(!el) return;
  const s = (el.selectionStart != null) ? el.selectionStart : el.value.length;
  const e = (el.selectionEnd != null) ? el.selectionEnd : el.value.length;
  el.value = el.value.slice(0, s) + emoji + el.value.slice(e);
  const pos = s + emoji.length;
  try { el.selectionStart = el.selectionEnd = pos; } catch(_){}
  _pushEmojiRecent(emoji);
  _autoGrow(el);
  if(targetId === 'msg-input' && typeof _msgPinIfStuck === 'function') _msgPinIfStuck();
}

function toggleEmoji(panelId, targetId, btn){
  const panel = document.getElementById(panelId);
  if(!panel) return;
  _buildEmojiPanel(panelId, targetId);
  const opening = !panel.classList.contains('open');
  panel.classList.toggle('open', opening);
  if(btn) btn.classList.toggle('active', opening);
  if(opening){
    const el = document.getElementById(targetId);
    if(el) el.blur(); // drop the soft keyboard so the panel is visible
    if(targetId === 'msg-input' && typeof _scrollMsgBottom === 'function') _scrollMsgBottom();
  }
}

// Close a panel (called when its input regains focus / after sending).
function _closeEmoji(panelId, btnId){
  const panel = document.getElementById(panelId);
  if(panel) panel.classList.remove('open');
  const btn = document.getElementById(btnId);
  if(btn) btn.classList.remove('active');
}

// ── Attachments ───────────────────────────────────────────
async function onAttachSelected(inputEl){
  const file = inputEl.files && inputEl.files[0];
  inputEl.value = ''; // allow re-picking the same file later
  if(!file) return;
  if(!currentUser?.id){ alert('You appear to be signed out. Refresh and sign in again.'); return; }
  if(file.size > _ATTACH_MAX_BYTES){ alert('That file is too large (max 25 MB).'); return; }

  const btn = document.getElementById('msg-attach-btn');
  if(btn){ btn.disabled = true; btn.dataset.icon = btn.innerHTML; btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;animation:ptrspin .8s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>'; }
  _pendingAttachment = null;
  _renderAttachChip('Uploading ' + file.name + '…');
  try {
    const safe = file.name.replace(/[^\w.\-]+/g, '_').slice(-100);
    const path = currentUser.id + '/' + Date.now() + '-' + safe;
    const { error: upErr } = await _sb.storage.from('message-attachments')
      .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
    if(upErr) throw upErr;
    // The bucket is private. Store the path (sent to the server on send); for
    // the local preview chip, mint a short-lived signed URL (the owner-read
    // policy lets the uploader sign their own just-uploaded file).
    let previewUrl = '';
    try { const { data: s } = await _sb.storage.from('message-attachments').createSignedUrl(path, 600); previewUrl = s?.signedUrl || ''; } catch(_){}
    _pendingAttachment = { path, url: previewUrl, name: file.name, type: file.type || '' };
    _renderAttachChip();
  } catch(e){
    _pendingAttachment = null;
    _renderAttachChip();
    alert('Could not upload: ' + (e.message || e));
  } finally {
    if(btn){ btn.disabled = false; btn.style.fontSize = ''; if(btn.dataset.icon){ btn.innerHTML = btn.dataset.icon; delete btn.dataset.icon; } }
  }
}

function clearAttachment(){
  _pendingAttachment = null;
  _renderAttachChip();
}

function _renderAttachChip(loadingLabel){
  const chip = document.getElementById('msg-attach-chip');
  if(!chip) return;
  if(loadingLabel){
    chip.style.display = 'flex';
    chip.innerHTML = `<span style="font-size:13px;font-style:italic;opacity:.8">${_esc(loadingLabel)}</span>`;
    return;
  }
  if(!_pendingAttachment){ chip.style.display = 'none'; chip.innerHTML = ''; return; }
  const a = _pendingAttachment;
  const isImg = (a.type || '').startsWith('image/');
  const thumb = isImg
    ? `<img src="${a.url}" alt="" style="width:32px;height:32px;border-radius:4px;object-fit:cover">`
    : `<span style="display:flex;align-items:center;justify-content:center;width:32px;height:32px;color:var(--walnut)"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg></span>`;
  chip.style.display = 'flex';
  chip.innerHTML = `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);max-width:100%">
      ${thumb}
      <span style="font-size:13px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(a.name)}</span>
      <button onclick="clearAttachment()" title="Remove" aria-label="Remove attachment" style="border:none;background:none;cursor:pointer;font-size:16px;color:var(--walnut);line-height:0;display:flex;align-items:center;justify-content:center"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>`;
}

function _renderAttachment(m, mine){
  if(!m.attachment_url) return '';
  const url = m.attachment_url;
  const name = m.attachment_name || 'attachment';
  const isImg = (m.attachment_type || '').startsWith('image/');
  if(isImg){
    return `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${_esc(name)}" style="max-width:100%;border-radius:10px;display:block"></a>`;
  }
  const linkColor = mine ? 'var(--cream)' : 'var(--accent-ink)';
  return `<a href="${url}" target="_blank" rel="noopener" download style="display:inline-flex;align-items:center;gap:6px;color:${linkColor};text-decoration:underline"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>${_esc(name)}</a>`;
}

async function _pairRoomName(a, b){
  const ids = [a, b].sort().join('|');
  const buf = new TextEncoder().encode(ids);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  const hex = [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2,'0')).join('');
  return 'py-' + hex.slice(0, 16); // 64 bits of entropy — collision-safe
}

async function joinDailyLink(roomName){
  if(!roomName) return;
  try {
    const r = await fetch(_SERVER_URL + '/call/start', {
      method:'POST', headers: await _authHeaders(),
      body: JSON.stringify({ roomName, userName: currentUser?.name || 'Guest', isOwner: false })
    });
    const j = await r.json();
    if(!r.ok) throw new Error(j.error || 'join failed');
    window.open(j.url, '_blank');
  } catch(e){
    alert('Could not join: ' + e.message);
  }
}

// ═════════════════════════ PUSH + PWA INSTALL ═════════════════════════
// Register the service worker as early as possible — needed for both the
// home-screen install prompt and for Web Push.
// Capture Android's deferred install prompt so we can trigger it on demand.
let _androidInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _androidInstallPrompt = e;
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(e => console.warn('SW register failed', e));
  });
  // Re-register push subscription whenever the active service worker changes.
  // iOS invalidates the previous push endpoint on SW update, so we must
  // re-subscribe immediately to get a fresh endpoint into the server.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (Notification.permission === 'granted' && currentUser) {
      navigator.serviceWorker.ready.then(async reg => {
        try {
          // Unsubscribe the now-stale endpoint, get a fresh one from Apple.
          const old = await reg.pushManager.getSubscription();
          if (old) await old.unsubscribe();
          const sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: _urlB64ToUint8(_VAPID_PUBLIC)
          });
          await fetch(_SERVER_URL + '/push/subscribe', {
            method: 'POST',
            headers: await _authHeaders(),
            body: JSON.stringify({ userId: currentUser.id, subscription: sub.toJSON() })
          });
        } catch(e) { console.warn('[push] re-subscribe after SW update failed', e); }
      });
    }
  });
  navigator.serviceWorker.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.kind === 'notif-click' && msg.action && msg.action.type === 'page') {
      try { showPage(msg.action.page); } catch(_) {}
    }
  });
}

function _urlB64ToUint8(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const s = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function _subscribeToPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  if (!currentUser) return null;
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: _urlB64ToUint8(_VAPID_PUBLIC)
    });
  }
  await fetch(_SERVER_URL + '/push/subscribe', {
    method: 'POST',
    headers: await _authHeaders(),
    body: JSON.stringify({ userId: currentUser.id, subscription: sub.toJSON() })
  });
  return sub;
}

async function _maybeOfferPushPrompt() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') { _subscribeToPush().catch(()=>{}); return; }
  if (Notification.permission === 'denied') return;
  // Soft prompt — don't auto-fire the browser dialog; require a tap so iOS
  // counts it as a user gesture (required on iOS Safari).
  if (localStorage.getItem('pp_push_dismissed') === '1') return;
  _renderPushBanner();
}

function _renderPushBanner() {
  if (document.getElementById('push-banner')) return;
  const div = document.createElement('div');
  div.id = 'push-banner';
  div.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(84px + env(safe-area-inset-bottom));z-index:90;background:var(--teal);color:var(--cream);border:1px solid var(--teal-deep);border-radius:12px;padding:12px 14px;box-shadow:0 6px 24px rgba(0,0,0,.25);display:flex;align-items:center;gap:10px;font-size:13px;line-height:1.4';
  div.innerHTML = '<div style="flex:1">Want a badge on your home-screen icon when you have new notifications?</div>' +
    '<button id="push-banner-yes" style="background:var(--terra);color:#fff;border:none;border-radius:8px;padding:8px 12px;font-family:inherit;font-weight:500;cursor:pointer">Enable</button>' +
    '<button id="push-banner-no" style="background:transparent;color:var(--cream);border:1px solid var(--cream);border-radius:8px;padding:8px 10px;font-family:inherit;cursor:pointer">Not now</button>';
  document.body.appendChild(div);
  document.getElementById('push-banner-yes').onclick = async () => {
    div.remove();
    try {
      const perm = await Notification.requestPermission();
      if (perm === 'granted') await _subscribeToPush();
    } catch(e) { console.warn('push prompt', e); }
  };
  document.getElementById('push-banner-no').onclick = () => {
    localStorage.setItem('pp_push_dismissed', '1');
    div.remove();
  };
}

function _maybeShowIosInstallHint() {
  // iOS Safari requires the user to "Add to Home Screen" before
  // notifications + badging work at all. If we're on iOS and not running
  // as standalone, show a one-time hint.
  const ua = navigator.userAgent || '';
  const isIos = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (!isIos || isStandalone) return;
  if (localStorage.getItem('pp_ios_hint_dismissed') === '1') return;
  if (document.getElementById('ios-hint')) return;
  const div = document.createElement('div');
  div.id = 'ios-hint';
  div.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(84px + env(safe-area-inset-bottom));z-index:90;background:var(--surface);color:var(--walnut);border:1px solid var(--line);border-radius:12px;padding:12px 14px;box-shadow:0 6px 24px rgba(0,0,0,.18);display:flex;align-items:center;gap:10px;font-size:13px;line-height:1.4';
  div.innerHTML = '<div style="flex:1">For home-screen alerts: tap <strong>Share</strong> in Safari, then <strong>Add to Home Screen</strong>.</div>' +
    '<button id="ios-hint-close" style="background:transparent;color:var(--walnut);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-family:inherit;cursor:pointer">Got it</button>';
  document.body.appendChild(div);
  document.getElementById('ios-hint-close').onclick = () => {
    localStorage.setItem('pp_ios_hint_dismissed', '1');
    div.remove();
  };
}

function _maybeShowAndroidInstallHint() {
  // Android Chrome: if the app isn't installed yet and the browser has
  // signalled it's installable (beforeinstallprompt fired), nudge the user
  // so the homescreen icon badge works after they install.
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches;
  if (isStandalone) return; // already installed
  const ua = navigator.userAgent || '';
  const isIos = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  if (isIos) return; // iOS handled separately
  if (!_androidInstallPrompt) return; // not installable / already installed
  if (localStorage.getItem('pp_android_hint_dismissed') === '1') return;
  if (document.getElementById('android-hint')) return;
  const div = document.createElement('div');
  div.id = 'android-hint';
  div.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(84px + env(safe-area-inset-bottom));z-index:90;background:var(--surface);color:var(--walnut);border:1px solid var(--line);border-radius:12px;padding:12px 14px;box-shadow:0 6px 24px rgba(0,0,0,.18);display:flex;align-items:center;gap:10px;font-size:13px;line-height:1.4';
  div.innerHTML = '<div style="flex:1">Add to your home screen to get a badge on the app icon when messages arrive.</div>' +
    '<button id="android-hint-install" style="background:var(--terra);color:#fff;border:none;border-radius:8px;padding:8px 12px;font-family:inherit;font-weight:500;cursor:pointer;white-space:nowrap">Add</button>' +
    '<button id="android-hint-close" style="background:transparent;color:var(--walnut);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-family:inherit;cursor:pointer">Not now</button>';
  document.body.appendChild(div);
  document.getElementById('android-hint-install').onclick = async () => {
    div.remove();
    if (_androidInstallPrompt) {
      _androidInstallPrompt.prompt();
      await _androidInstallPrompt.userChoice;
      _androidInstallPrompt = null;
    }
  };
  document.getElementById('android-hint-close').onclick = () => {
    localStorage.setItem('pp_android_hint_dismissed', '1');
    div.remove();
  };
}

// ═════════════════════════ NOTIFICATIONS ═════════════════════════
let _notifPollTimer = null;
let _notifChannel = null;

function _subscribeNotifRealtime(){
  if(!_sb || !currentUser) return;
  // Tear down any previous channel (e.g. after sign-out/re-in)
  if(_notifChannel){ _sb.removeChannel(_notifChannel); _notifChannel = null; }
  _notifChannel = _sb
    .channel('user-notifs-' + currentUser.id)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'prep_notifications',
      filter: `user_id=eq.${currentUser.id}`
    }, () => {
      // New notification arrived — refresh the nav badges + home-screen badge immediately
      refreshNavBadges();
    })
    .subscribe();
}

// ─────────────────── REAL-TIME MESSAGES (signal only) ───────────────────
// Message bodies are encrypted at rest; only the server can decrypt them, so
// Realtime can't carry readable text. Instead we use the postgres_changes
// event purely as a SIGNAL ("a row landed in your conversation") and then call
// the existing server endpoints to fetch the decrypted thread/inbox. This
// drops delivery latency from the poll interval to ~instant without touching
// the encryption model. The RLS SELECT policy (see SQL migration) only exposes
// ciphertext + metadata to the participant, who already sees the plaintext.
let _msgChannel = null;
function _subscribeMsgRealtime(){
  if(!_sb || !currentUser) return;
  if(_msgChannel){ _sb.removeChannel(_msgChannel); _msgChannel = null; }
  _msgChannel = _sb
    .channel('user-msgs-' + currentUser.id)
    // Someone messaged me — pull it in immediately.
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'prep_messages',
      filter: `recipient_id=eq.${currentUser.id}`
    }, (payload) => { _onRealtimeMsgInsert(payload && payload.new || {}); })
    // A message I SENT was just read (peer flipped read_at) — flip "Seen" live.
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'prep_messages',
      filter: `sender_id=eq.${currentUser.id}`
    }, () => {
      if(_msgView === 'thread' && document.getElementById('page-messages').classList.contains('active')) loadMessages();
    })
    // A message I received was updated (peer reacted to their own message) —
    // refresh the open thread so the reaction shows without waiting for the poll.
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'prep_messages',
      filter: `recipient_id=eq.${currentUser.id}`
    }, () => {
      if(_msgView === 'thread' && document.getElementById('page-messages').classList.contains('active')) loadMessages();
    })
    .subscribe();
}
function _onRealtimeMsgInsert(row){
  // Keep the unread badge current even when off the Messages page.
  refreshMessageBadge();
  const onMessages = document.getElementById('page-messages').classList.contains('active');
  if(!onMessages) return;
  if(_msgView === 'thread' && row.sender_id === _msgPeerId){
    loadMessages();   // the open conversation — fetch the decrypted text now
  } else if(_msgView === 'list'){
    refreshInbox();   // inbox — re-sort with the newly arrived message
  }
}

// ─────────────────── TYPING INDICATORS (ephemeral broadcast) ───────────────────
// No DB writes: a per-conversation Realtime broadcast channel both participants
// derive from the same sorted id pair. While composing, each side emits a
// throttled "typing" ping; the other side shows "<name> is typing…" and
// auto-hides it after 3s of silence.
let _typingChannel = null;
let _typingChannelKey = null;
let _typingSendThrottle = 0;
let _peerTypingTimer = null;
function _convoKey(peerId){ return [currentUser.id, peerId].sort().join('__'); }
function _openTypingChannel(peerId){
  if(!_sb || !currentUser || !peerId) return;
  const key = _convoKey(peerId);
  if(_typingChannel && _typingChannelKey === key) return; // already open for this convo
  _closeTypingChannel();
  _typingChannelKey = key;
  _typingChannel = _sb.channel('typing-' + key, { config: { broadcast: { self: false } } });
  _typingChannel.on('broadcast', { event: 'typing' }, ({ payload }) => {
    if(payload && payload.from === _msgPeerId) _showPeerTyping();
  });
  _typingChannel.subscribe();
}
function _closeTypingChannel(){
  if(_typingChannel){ try { _sb.removeChannel(_typingChannel); } catch(_){} }
  _typingChannel = null; _typingChannelKey = null;
  _hidePeerTyping();
}
function _onMsgTyping(){
  const now = Date.now();
  if(_typingChannel && now - _typingSendThrottle > 1500){
    _typingSendThrottle = now;
    _typingChannel.send({ type: 'broadcast', event: 'typing', payload: { from: currentUser.id } });
  }
}
function _showPeerTyping(){
  const el = document.getElementById('msg-typing');
  if(!el) return;
  const peer = _findPeer(_msgPeerId);
  const name = (peer && peer.name) ? String(peer.name).split(' ')[0] : 'They';
  el.textContent = name + ' is typing…';
  el.style.display = 'block';
  if(_peerTypingTimer) clearTimeout(_peerTypingTimer);
  _peerTypingTimer = setTimeout(_hidePeerTyping, 3000);
}
function _hidePeerTyping(){
  const el = document.getElementById('msg-typing');
  if(el){ el.style.display = 'none'; el.textContent = ''; }
  if(_peerTypingTimer){ clearTimeout(_peerTypingTimer); _peerTypingTimer = null; }
}

// Map a notification's target page onto the bottom-nav icon that should carry
// its red badge. Messages are counted separately (unread prep_messages), so
// 'messages' is intentionally excluded here.
const _NAV_BADGE_FOR_PAGE = {
  pcm: 'pcm',
  home: 'home', video: 'home', 'join-tln': 'home'
};

function _setNavBadge(id, n){
  const el = document.getElementById(id);
  if(!el) return;
  if(n > 0){ el.style.display = 'inline-block'; el.textContent = n > 9 ? '9+' : String(n); }
  else { el.style.display = 'none'; }
}

// Fetch unread notifications and light up the PCM / Home nav badges (Messenger
// style). The Messages badge is driven by refreshMessageBadge(). The combined
// total (messages + notifications) drives the installed-app home-screen badge.
let _navNotifUnread = [];
async function refreshNavBadges(){
  if(!_sb || !currentUser) return;
  const { data } = await _sb.from('prep_notifications')
    .select('id, action').eq('user_id', currentUser.id).is('read_at', null)
    .in('action->>page', ['pcm','home','video','join-tln']).limit(200);
  _navNotifUnread = data || [];
  let pcm = 0, home = 0;
  for(const row of _navNotifUnread){
    const icon = _NAV_BADGE_FOR_PAGE[row.action && row.action.page];
    if(icon === 'pcm') pcm++;
    else if(icon === 'home') home++;
  }
  _setNavBadge('nav-pcm-badge', pcm);
  _setNavBadge('nav-home-badge', home);
  // Home-screen icon badge = unread messages + badge-worthy notifications.
  _setHomeScreenBadge((_lastMsgUnread || 0) + pcm + home);
}

// Mark unread notifications whose target page maps to this nav icon as read,
// so visiting the page clears its badge. Returns once the badge is refreshed.
async function _clearNavNotifs(navName){
  if(!_sb || !currentUser || !_navNotifUnread.length) return;
  const pages = Object.keys(_NAV_BADGE_FOR_PAGE).filter(p => _NAV_BADGE_FOR_PAGE[p] === navName);
  if(!pages.length) return;
  const ids = _navNotifUnread
    .filter(r => pages.includes(r.action && r.action.page))
    .map(r => r.id);
  if(!ids.length) return;
  await _sb.from('prep_notifications').update({ read_at: new Date().toISOString() })
    .in('id', ids).eq('user_id', currentUser.id);
  refreshNavBadges();
}

function _setHomeScreenBadge(n){
  // Update the installed-PWA home-screen icon badge. Foreground call works
  // on Android Chrome; on iOS 16.4+ only if the user installed via Add to
  // Home Screen and granted notification permission. The service worker
  // updates this same badge from background push events.
  try {
    if (navigator && 'setAppBadge' in navigator) {
      if (n > 0) navigator.setAppBadge(n); else navigator.clearAppBadge();
    }
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ kind:'set-badge', count: n });
    }
  } catch(_) {}
}

// ═════════════════════════ PROFILE ═════════════════════════
// Render a round avatar element: a cover-fit photo if the user has an
// avatar_url, otherwise their initials on the brand fill. Used for the
// top-right header icon and the profile-drawer avatar.
function _setAvatarEl(el, user){
  if(!el) return;
  const url = user && user.avatar_url;
  if(url){
    el.innerHTML = '<img src="' + _esc(url) + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block">';
    el.style.background = 'transparent';
  } else {
    el.style.background = '';
    el.textContent = _initials(user ? user.name : '');
  }
}
function _updateAvatarRemoveBtn(){
  const btn = document.getElementById('avatar-remove-btn');
  if(btn) btn.style.display = (currentUser && currentUser.avatar_url) ? 'inline-block' : 'none';
}
function _refreshProfileAv(){
  _setAvatarEl(document.getElementById('hdr-profile-btn'), currentUser);
}
function openProfile(){
  if(!currentUser) return;
  _setAvatarEl(document.getElementById('profile-av'), currentUser);
  _updateAvatarRemoveBtn();
  document.getElementById('profile-name-display').textContent = currentUser.name || '—';
  document.getElementById('profile-email-display').textContent = currentUser.email || '';
  document.getElementById('prof-name').value = currentUser.name || '';
  _fillCountrySelect(document.getElementById('prof-country'), _regionCountry(currentUser.region || ''));
  document.getElementById('prof-state').value = _regionState(currentUser.region || '');
  document.getElementById('prof-email').value = currentUser.email || '';
  const msg = document.getElementById('profile-msg'); msg.style.display = 'none';
  document.getElementById('profile-overlay').style.display = 'block';
}
function closeProfile(){ document.getElementById('profile-overlay').style.display = 'none'; }

// ── Delete account ────────────────────────────────────────────────────────
// Irreversible: a confirmed POST to /account/delete removes the auth user,
// which cascades every prep_* row server-side. The Delete button stays locked
// until the member types DELETE exactly.
function openDeleteAccount(){
  closeProfile();
  const inp = document.getElementById('del-acct-input'); if(inp) inp.value = '';
  const msg = document.getElementById('del-acct-msg'); if(msg) msg.style.display = 'none';
  _onDelAcctInput();
  document.getElementById('del-acct-overlay').style.display = 'flex';
}
function closeDeleteAccount(){ const el = document.getElementById('del-acct-overlay'); if(el) el.style.display = 'none'; }
function _onDelAcctInput(){
  const inp = document.getElementById('del-acct-input');
  const btn = document.getElementById('del-acct-confirm');
  if(!inp || !btn) return;
  const ok = inp.value.trim().toUpperCase() === 'DELETE';
  btn.disabled = !ok;
  btn.style.opacity = ok ? '1' : '.5';
  btn.style.cursor = ok ? 'pointer' : 'not-allowed';
}
async function confirmDeleteAccount(){
  const inp = document.getElementById('del-acct-input');
  const btn = document.getElementById('del-acct-confirm');
  const msg = document.getElementById('del-acct-msg');
  if(!inp || inp.value.trim().toUpperCase() !== 'DELETE') return;
  if(btn){ btn.disabled = true; btn.textContent = 'Deleting\u2026'; btn.style.opacity = '.6'; btn.style.cursor = 'wait'; }
  if(msg) msg.style.display = 'none';
  try {
    const r = await fetch(_SERVER_URL + '/account/delete', { method:'POST', headers: await _authHeaders() });
    if(!r.ok){ const j = await r.json().catch(()=>({})); throw new Error(j.error || ('HTTP ' + r.status)); }
    // Account is gone — tear down the local session and return to landing.
    try { if(_sb) await _sb.auth.signOut().catch(()=>{}); } catch(_){}
    currentUser = null;
    alert('Your account has been deleted. We wish you well on your journey.');
    window.location.reload();
  } catch(e){
    if(btn){ btn.disabled = false; btn.textContent = 'Delete forever'; btn.style.opacity = '1'; btn.style.cursor = 'pointer'; }
    if(msg){ msg.textContent = 'Could not delete your account: ' + (e.message || 'please try again.'); msg.style.display = 'block'; }
  }
}

async function saveProfile(){
  const name   = document.getElementById('prof-name').value.trim();
  const country = document.getElementById('prof-country').value.trim();
  const state   = document.getElementById('prof-state').value.trim();
  const region  = _composeRegion(country, state);
  const msg    = document.getElementById('profile-msg');
  const btn    = document.getElementById('profile-save-btn');
  const show = (text, ok) => { msg.textContent = text; msg.style.color = ok ? 'var(--success)' : 'var(--terra)'; msg.style.display = 'block'; };
  if(!name || !country){ show('Name and country can’t be empty.', false); return; }
  if(!_sb || !currentUser){ show('Not signed in.', false); return; }
  btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Saving…';
  try {
    const { error } = await _sb.from('prep_users').update({ name, region }).eq('id', currentUser.id);
    if(error) throw new Error(error.message);
    await _sb.auth.updateUser({ data: { name, region } }).catch(()=>{});
    currentUser.name = name; currentUser.region = region;
    document.getElementById('profile-name-display').textContent = name;
    _setAvatarEl(document.getElementById('profile-av'), currentUser);
    _refreshProfileAv();
    show('Saved.', true);
  } catch(e){
    show('Could not save: ' + e.message, false);
  } finally {
    btn.disabled = false; btn.textContent = orig;
  }
}

// ── Profile photo upload / remove ────────────────────────────────────
function _profileMsg(text, ok){
  const msg = document.getElementById('profile-msg');
  if(!msg) return;
  msg.textContent = text;
  msg.style.color = ok ? 'var(--success)' : 'var(--terra)';
  msg.style.display = 'block';
}

// Picking a photo opens the framing editor (drag to centre, pinch/slider to
// zoom). The editor renders the framed circle to a square JPEG, which also
// converts iPhone HEIC -> JPEG so it displays everywhere. If the browser can't
// decode the file at all, fall back to uploading the original bytes.
async function onAvatarSelected(input){
  const file = input && input.files && input.files[0];
  if(!file) return;
  input.value = '';  // allow re-selecting the same file later
  if(!_sb || !currentUser){ _profileMsg('Not signed in.', false); return; }
  if(file.size > 15 * 1024 * 1024){ _profileMsg('Image must be under 15 MB.', false); return; }
  const msg = document.getElementById('profile-msg');
  if(msg) msg.style.display = 'none';
  openCropper(file);
}

// ── Profile photo framing editor ──────────────────────────────────────────
let _crop = null;          // active editing session
let _cropWired = false;    // pointer/zoom listeners attached once

function _cropWire(){
  if(_cropWired) return;
  const stage = document.getElementById('crop-stage');
  if(!stage) return;
  stage.addEventListener('pointerdown', _cropPointerDown);
  stage.addEventListener('pointermove', _cropPointerMove);
  stage.addEventListener('pointerup', _cropPointerUp);
  stage.addEventListener('pointercancel', _cropPointerUp);
  _cropWired = true;
}

function openCropper(file){
  _cropWire();
  const CS = 280;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    if(!img.width || !img.height){ URL.revokeObjectURL(url); return _uploadAvatarBlob(file, (file.name.split('.').pop()||'jpg').toLowerCase().replace(/[^a-z0-9]/g,'')||'jpg', file.type||'application/octet-stream'); }
    const cover = Math.max(CS / img.width, CS / img.height); // fill the circle
    _crop = { img, url, CS, cover, zoom: 1, ox: 0, oy: 0, pointers: new Map(), pinchStart: 0, zoomStart: 1 };
    const zoomEl = document.getElementById('crop-zoom');
    if(zoomEl) zoomEl.value = '1';
    document.getElementById('cropper-overlay').style.display = 'flex';
    _cropDraw();
  };
  img.onerror = () => { URL.revokeObjectURL(url); _uploadAvatarBlob(file, (file.name.split('.').pop()||'jpg').toLowerCase().replace(/[^a-z0-9]/g,'')||'jpg', file.type||'application/octet-stream'); };
  img.src = url;
}

function closeCropper(){
  if(_crop && _crop.url) URL.revokeObjectURL(_crop.url);
  _crop = null;
  const ov = document.getElementById('cropper-overlay');
  if(ov) ov.style.display = 'none';
}

function _cropClamp(){
  const c = _crop; if(!c) return;
  const dw = c.img.width * c.cover * c.zoom, dh = c.img.height * c.cover * c.zoom;
  const maxX = Math.max(0, (dw - c.CS) / 2), maxY = Math.max(0, (dh - c.CS) / 2);
  c.ox = Math.max(-maxX, Math.min(maxX, c.ox));
  c.oy = Math.max(-maxY, Math.min(maxY, c.oy));
}

function _cropDraw(){
  const c = _crop; if(!c) return;
  const canvas = document.getElementById('crop-canvas'); if(!canvas) return;
  const ctx = canvas.getContext('2d');
  _cropClamp();
  const dw = c.img.width * c.cover * c.zoom, dh = c.img.height * c.cover * c.zoom;
  const dx = c.CS / 2 - dw / 2 + c.ox, dy = c.CS / 2 - dh / 2 + c.oy;
  ctx.clearRect(0, 0, c.CS, c.CS);
  ctx.drawImage(c.img, dx, dy, dw, dh);
}

function _cropZoomInput(el){
  if(!_crop) return;
  _crop.zoom = parseFloat(el.value) || 1;
  _cropDraw();
}

function _cropPointerDown(e){
  if(!_crop) return;
  e.preventDefault();
  const stage = document.getElementById('crop-stage');
  try { stage.setPointerCapture(e.pointerId); } catch(_){}
  _crop.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if(_crop.pointers.size === 2){
    const p = [..._crop.pointers.values()];
    _crop.pinchStart = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    _crop.zoomStart = _crop.zoom;
  }
}

function _cropPointerMove(e){
  if(!_crop || !_crop.pointers.has(e.pointerId)) return;
  e.preventDefault();
  const prev = _crop.pointers.get(e.pointerId);
  const cur = { x: e.clientX, y: e.clientY };
  _crop.pointers.set(e.pointerId, cur);
  if(_crop.pointers.size >= 2){
    const p = [..._crop.pointers.values()];
    const dist = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    if(_crop.pinchStart > 0){
      let z = _crop.zoomStart * (dist / _crop.pinchStart);
      z = Math.max(1, Math.min(4, z));
      _crop.zoom = z;
      const zoomEl = document.getElementById('crop-zoom');
      if(zoomEl) zoomEl.value = String(z);
      _cropDraw();
    }
  } else {
    _crop.ox += (cur.x - prev.x);
    _crop.oy += (cur.y - prev.y);
    _cropDraw();
  }
}

function _cropPointerUp(e){
  if(!_crop) return;
  _crop.pointers.delete(e.pointerId);
  if(_crop.pointers.size < 2) _crop.pinchStart = 0;
}

async function saveCropper(){
  if(!_crop){ closeCropper(); return; }
  const c = _crop, OUT = 512, r = OUT / c.CS;
  const out = document.createElement('canvas');
  out.width = OUT; out.height = OUT;
  const octx = out.getContext('2d');
  const dw = c.img.width * c.cover * c.zoom * r, dh = c.img.height * c.cover * c.zoom * r;
  const dx = OUT / 2 - dw / 2 + c.ox * r, dy = OUT / 2 - dh / 2 + c.oy * r;
  octx.drawImage(c.img, dx, dy, dw, dh);
  const blob = await new Promise(res => out.toBlob(res, 'image/jpeg', 0.85));
  closeCropper();
  if(blob) _uploadAvatarBlob(blob, 'jpg', 'image/jpeg');
  else _profileMsg('Could not prepare photo — please try again.', false);
}

async function _uploadAvatarBlob(blob, ext, type){
  if(!_sb || !currentUser){ _profileMsg('Not signed in.', false); return; }
  _profileMsg('Uploading photo…', true);
  try {
    const path = currentUser.id + '/' + Date.now() + '.' + (ext || 'jpg');
    const { error: upErr } = await _sb.storage.from('avatars')
      .upload(path, blob, { contentType: type || 'image/jpeg', upsert: true });
    if(upErr) throw new Error(upErr.message);
    const { data: pub } = _sb.storage.from('avatars').getPublicUrl(path);
    const url = pub && pub.publicUrl;
    if(!url) throw new Error('Could not resolve photo URL.');
    const { error: dbErr } = await _sb.from('prep_users').update({ avatar_url: url }).eq('id', currentUser.id);
    if(dbErr) throw new Error(dbErr.message);
    currentUser.avatar_url = url;
    _setAvatarEl(document.getElementById('profile-av'), currentUser);
    _refreshProfileAv();
    _updateAvatarRemoveBtn();
    _profileMsg('Photo updated.', true);
  } catch(e){
    _profileMsg('Could not upload photo: ' + e.message, false);
  }
}

async function removeAvatar(){
  const msg = document.getElementById('profile-msg');
  const show = (text, ok) => { msg.textContent = text; msg.style.color = ok ? 'var(--success)' : 'var(--terra)'; msg.style.display = 'block'; };
  if(!_sb || !currentUser){ show('Not signed in.', false); return; }
  const btn = document.getElementById('avatar-remove-btn');
  if(btn) btn.disabled = true;
  try {
    const { error } = await _sb.from('prep_users').update({ avatar_url: null }).eq('id', currentUser.id);
    if(error) throw new Error(error.message);
    currentUser.avatar_url = null;
    _setAvatarEl(document.getElementById('profile-av'), currentUser);
    _refreshProfileAv();
    _updateAvatarRemoveBtn();
    show('Photo removed.', true);
  } catch(e){
    show('Could not remove photo: ' + e.message, false);
  } finally {
    if(btn) btn.disabled = false;
  }
}

let _prevMsgCount = 0;
let _lastMsgUnread = 0;
async function refreshMessageBadge(){
  if(!_sb || !currentUser) return;
  const { count } = await _sb.from('prep_messages')
    .select('id', { count:'exact', head:true })
    .eq('recipient_id', currentUser.id).is('read_at', null);
  const badge = document.getElementById('nav-msg-badge');
  if(!badge) return;
  const n = count || 0;
  _lastMsgUnread = n;
  if(n > 0){
    badge.style.display = 'inline-block';
    badge.textContent = n > 9 ? '9+' : String(n);
  } else {
    badge.style.display = 'none';
  }
  // If new messages arrived since last check, refresh the combined home-screen badge.
  if(n !== _prevMsgCount) refreshNavBadges();
  _prevMsgCount = n;
}

// ═════════════════════════ BOOKS ═════════════════════════
let _booksData = null;

// Is this book's audio still locked? Locked until every EARLIER book (by
// order) has had its audio overview completed — enforces "listen in order".
function _bookAudioLocked(idx){
  for(let i = 0; i < idx; i++){
    if(!_bookAudioDone.has(_booksData[i].id)) return true;
  }
  return false;
}

async function buildBooksPage(){
  // Gate: the Five Books unlock only once a PCM is walking alongside you.
  await _refreshJourneyFields();
  if(_gateJourneyPage('page-books', 'books-content', 3)) return;
  const wrap = document.getElementById('books-list');
  if(!_booksData){
    if(!_sb){ wrap.innerHTML = '<div class="empty">Not signed in.</div>'; return; }
    const { data, error } = await _sb.from('prep_books').select('*').order('order_index');
    if(error){ wrap.innerHTML = '<div class="empty">Error loading books.</div>'; return; }
    _booksData = data || [];
  }
  await loadBookAudioProgress();
  if(!_booksData.length){ wrap.innerHTML = '<div class="empty">No books yet.</div>'; return; }
  wrap.innerHTML = _booksData.map((b, idx) => {
    const hasAudio = !!b.audio_overview_path;
    const hasAudiobook = !!(b.audiobook_path || _audiobookParts(b));
    const hasPdf = !!b.pdf_storage_path;
    const done = _bookAudioDone.has(b.id);
    const locked = !done && _bookAudioLocked(idx);
    // Listen button reflects sequential progress: done (✓), locked (🔒), or open.
    let listenLabel, listenStyle, listenEnabled;
    if(!hasAudio){ listenLabel = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none"/></svg>Listen'; listenStyle = 'opacity:.4;cursor:not-allowed'; listenEnabled = false; }
    else if(done){ listenLabel = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><polyline points="20 6 9 17 4 12"/></svg>Listen again'; listenStyle = ''; listenEnabled = true; }
    else if(locked){ listenLabel = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Listen'; listenStyle = 'opacity:.4;cursor:not-allowed'; listenEnabled = false; }
    else { listenLabel = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none"/></svg>Listen'; listenStyle = ''; listenEnabled = true; }
    const note = (hasAudio && locked)
      ? '<div style="font-size:11px;color:var(--walnut-mid);font-style:italic;margin-top:6px"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Finish the previous book\'s audio first</div>'
      : (done ? '<div style="font-size:11px;color:var(--success);font-style:italic;margin-top:6px"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><polyline points="20 6 9 17 4 12"/></svg>Audio overview completed</div>' : '');
    return `<div class="card" style="display:flex;align-items:flex-start;gap:14px">
      <div style="font-size:24px;width:36px;text-align:center;padding-top:2px">${done ? '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block; color:var(--success);"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>' : '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;"><path d="M2 4h6a3 3 0 0 1 3 3v13a2.5 2.5 0 0 0-2.5-2H2z"/><path d="M22 4h-6a3 3 0 0 0-3 3v13a2.5 2.5 0 0 1 2.5-2H22z"/></svg>'}</div>
      <div style="flex:1;min-width:0">
        <div class="card-title" style="margin:0 0 8px;font-size:16px">${_esc(b.title)}</div>
        <div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">
          <div style="display:flex;gap:8px;flex-wrap:wrap;flex:1 1 280px;min-width:0">
            <button class="link-btn" ${listenEnabled?'':'disabled'} onclick="openBookListen(${b.id})" style="padding:6px 12px;border:1px solid var(--terra);color:var(--accent-ink);border-radius:6px;background:var(--terra-soft);font-weight:500;${listenStyle}">${listenLabel}</button>
            <button class="link-btn" ${hasPdf?'':'disabled'} onclick="openBookRead(${b.id})" style="padding:6px 12px;border:1px solid var(--brand-ink);color:var(--brand-ink);border-radius:6px;background:transparent;font-weight:500;${hasPdf?'':'opacity:.4;cursor:not-allowed'}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><path d="M2 4h6a3 3 0 0 1 3 3v13a2.5 2.5 0 0 0-2.5-2H2z"/><path d="M22 4h-6a3 3 0 0 0-3 3v13a2.5 2.5 0 0 1 2.5-2H22z"/></svg>Read</button>
            <button class="link-btn" ${hasAudiobook?'':'disabled'} onclick="openBookAudiobook(${b.id})" style="padding:6px 12px;border:1px solid var(--gold);color:var(--gold);border-radius:6px;background:var(--gold-soft);font-weight:500;${hasAudiobook?'':'opacity:.4;cursor:not-allowed'}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>Audiobook</button>
          </div>
          ${b.description ? `<div style="flex:1;min-width:200px;font-size:16px;color:var(--walnut);font-style:italic;line-height:1.5">${_esc(b.description)}</div>` : ''}
        </div>
        ${note}
      </div>
    </div>`;
  }).join('');
}

let _bookListenMaxTime = 0;   // anti-skip ceiling (seconds) for current audio
let _bookListenId = null;     // book_id currently playing in the overview player
let _bookAudiobookId = null;  // book_id currently playing in the audiobook player
let _lastAudioPosSave = 0;    // throttle for localStorage position writes

// Remember where each audio was last left off so closing the player or the app
// (iOS swipe-away) resumes from the same spot instead of restarting.
function _audioPosKey(kind, id){ return 'pp_audiopos_' + kind + '_' + id; }
function _saveAudioPos(kind, id, t){
  if(id == null || !isFinite(t) || t < 1) return;
  try { localStorage.setItem(_audioPosKey(kind, id), String(Math.floor(t))); } catch(e){}
}
function _loadAudioPos(kind, id){
  try { const v = parseFloat(localStorage.getItem(_audioPosKey(kind, id))); return isFinite(v) ? v : 0; } catch(e){ return 0; }
}
function _clearAudioPos(kind, id){ try { localStorage.removeItem(_audioPosKey(kind, id)); } catch(e){} }
// Apply a saved start position once the audio knows its duration.
function _resumeAudioAt(player, seconds){
  if(!(seconds > 1)) return;
  const apply = () => {
    if(isFinite(player.duration) && seconds < player.duration - 1){
      try { player.currentTime = seconds; } catch(e){}
    }
  };
  if(player.readyState >= 1) apply();
  else player.addEventListener('loadedmetadata', apply, { once: true });
}

function openBookListen(bookId){
  const idx = _booksData.findIndex(x => x.id === bookId);
  const b = idx >= 0 ? _booksData[idx] : null;
  if(!b || !b.audio_overview_path) return;
  const done = _bookAudioDone.has(bookId);
  // Block playing a still-locked book (must listen in order).
  if(!done && _bookAudioLocked(idx)) return;
  _bookListenId = bookId;
  const resume = _loadAudioPos('overview', bookId);
  // First listen: the anti-skip ceiling starts where they last left off (can't
  // jump past it). Re-listening (done): free seek.
  _bookListenMaxTime = done ? Infinity : resume;
  const wrap = document.getElementById('book-listen-wrap');
  const player = document.getElementById('book-listen-player');
  document.getElementById('book-listen-title').innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>' + _esc(b.title) + ' — Audio Overview';
  player.src = b.audio_overview_path;
  wrap.style.display = 'block';
  player.load();
  player.play().catch(()=>{});       // start within the user gesture (iOS autoplay)
  _resumeAudioAt(player, resume);     // jump to last spot once metadata is ready
  wrap.scrollIntoView({behavior:'smooth', block:'start'});
}

function closeBookListen(){
  const player = document.getElementById('book-listen-player');
  if(player){ _saveAudioPos('overview', _bookListenId, player.currentTime); try{ player.pause(); }catch(_){} player.removeAttribute('src'); player.load(); }
  const wrap = document.getElementById('book-listen-wrap');
  if(wrap) wrap.style.display = 'none';
}

function openBookRead(bookId){
  const b = _booksData.find(x => x.id === bookId);
  if(!b || !b.pdf_storage_path) return;
  window.open(b.pdf_storage_path, '_blank');
}

// ── Full audiobooks (Andrew narration, generated 2026-06-12) ──────────
// Each book is split into <50MB parts (the storage per-object cap); the
// player auto-advances between parts and the saved resume position is the
// CUMULATIVE offset across the whole book. Keyed on title fragments so no
// prep_books migration is required; audiobook_path remains a legacy
// single-file fallback for any book without a manifest entry.
const AUDIOBOOK_BASE = 'https://ahtdvcqyxxjdqrkxsovw.supabase.co/storage/v1/object/public/audiobooks/';
const AUDIOBOOKS = [
  { match: /higher liberty/i,                 parts: [{f:'THL-part1.m4a',sec:11486},{f:'THL-part2.m4a',sec:8983}] },
  { match: /contracts.*covenants|covenants.*constitutions/i, parts: [{f:'CCC-part1.m4a',sec:11325},{f:'CCC-part2.m4a',sec:6070}] },
  { match: /thy kingdom come/i,               parts: [{f:'TKC-part1.m4a',sec:11392},{f:'TKC-part2.m4a',sec:11264},{f:'TKC-part3.m4a',sec:11179},{f:'TKC-part4.m4a',sec:2403}] },
];
function _audiobookParts(b){
  if(!b || !b.title) return null;
  const hit = AUDIOBOOKS.find(a => a.match.test(b.title));
  return hit ? hit.parts : null;
}
let _abParts = null;   // active parts manifest (null = legacy single file)
let _abIdx = 0;        // current part index
let _abBase = 0;       // seconds of all parts before the current one

function _abCumulative(player){
  return _abBase + ((player && player.currentTime) || 0);
}

// The Supabase public CDN intermittently 404s "cold" (un-cached) objects, so
// fetch a short-lived signed URL per part from the server. Falls back to the
// public URL only if the signing endpoint is unreachable.
async function _abSignedSrc(file){
  try {
    const r = await fetch(_SERVER_URL + '/audiobook-url?file=' + encodeURIComponent(file));
    if (r.ok) { const j = await r.json(); if (j && j.url) return j.url; }
  } catch(_) {}
  return AUDIOBOOK_BASE + file;
}

async function openBookAudiobook(bookId){
  const b = _booksData.find(x => x.id === bookId);
  const parts = _audiobookParts(b);
  if(!b || (!parts && !b.audiobook_path)) return;
  _bookAudiobookId = bookId;
  const resume = _loadAudioPos('audiobook', bookId);
  const wrap = document.getElementById('book-audiobook-wrap');
  const player = document.getElementById('book-audiobook-player');
  document.getElementById('book-audiobook-title').innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>' + _esc(b.title) + ' — Audiobook';
  if(parts){
    _abParts = parts;
    // map the cumulative resume offset to a part + local offset
    let idx = 0, base = 0;
    while(idx < parts.length - 1 && resume > base + parts[idx].sec){ base += parts[idx].sec; idx++; }
    _abIdx = idx; _abBase = base;
    player.src = await _abSignedSrc(parts[idx].f);
    _abEnsureAdvance(player);
    wrap.style.display = 'block';
    player.load();
    player.play().catch(()=>{});
    _resumeAudioAt(player, resume - base);
  } else {
    _abParts = null; _abIdx = 0; _abBase = 0;
    player.src = b.audiobook_path;
    wrap.style.display = 'block';
    player.load();
    player.play().catch(()=>{});
    _resumeAudioAt(player, resume);
  }
  wrap.scrollIntoView({behavior:'smooth', block:'start'});
}

// One-time listeners: auto-advance to the next part, and persist the
// cumulative position periodically (not just on close) so a refresh or
// app switch can't lose more than a few seconds.
let _abWired = false, _abLastSave = 0;
function _abEnsureAdvance(player){
  if(_abWired) return;
  _abWired = true;
  player.addEventListener('ended', async () => {
    if(!_abParts || _abIdx >= _abParts.length - 1){
      if(_bookAudiobookId != null) _saveAudioPos('audiobook', _bookAudiobookId, 0); // finished — restart next time
      return;
    }
    _abBase += _abParts[_abIdx].sec;
    _abIdx++;
    player.src = await _abSignedSrc(_abParts[_abIdx].f);
    player.load();
    player.play().catch(()=>{});
    _saveAudioPos('audiobook', _bookAudiobookId, _abBase);
  });
  player.addEventListener('timeupdate', () => {
    const now = Date.now();
    if(now - _abLastSave > 5000 && _bookAudiobookId != null && !player.paused){
      _abLastSave = now;
      _saveAudioPos('audiobook', _bookAudiobookId, _abParts ? _abCumulative(player) : player.currentTime);
    }
  });
}

function closeBookAudiobook(){
  const player = document.getElementById('book-audiobook-player');
  if(player){ _saveAudioPos('audiobook', _bookAudiobookId, _abParts ? _abCumulative(player) : player.currentTime); try{ player.pause(); }catch(_){} player.removeAttribute('src'); player.load(); }
  _abParts = null; _abIdx = 0; _abBase = 0;
  const wrap = document.getElementById('book-audiobook-wrap');
  if(wrap) wrap.style.display = 'none';
}

// ═════════════════════════ PAUL ═════════════════════════
let _paulHistory = []; // [{role, content}]

const PAUL_GREETINGS = {
  'English': 'Peace to you. What would you like to ask?',
  'Spanish': 'La paz sea contigo. ¿Qué te gustaría preguntar?',
  'French': 'Que la paix soit avec toi. Que veux-tu demander ?',
  'Portuguese': 'A paz esteja contigo. O que gostarias de perguntar?',
  'German': 'Friede sei mit dir. Was möchtest du fragen?',
  'Italian': 'La pace sia con te. Cosa vorresti chiedere?',
  'Russian': 'Мир тебе. Что ты хотел бы спросить?',
  'Chinese (Simplified)': '愿你平安。你想问什么?',
  'Arabic': 'السلام عليك. ماذا تريد أن تسأل؟',
  'Armenian': 'Խաղաղություն քեզ։ Ի՞նչ կցանկանայիր հարցնել։',
  'Hindi': 'आप पर शांति हो। आप क्या पूछना चाहेंगे?',
  'Swahili': 'Amani iwe nawe. Ungependa kuuliza nini?',
  'Filipino': 'Sumaiyo ang kapayapaan. Ano ang nais mong itanong?'
};

function _paulLang(){
  const sel = document.getElementById('paul-lang');
  return (sel && sel.value) || localStorage.getItem('pp_paul_lang') || 'English';
}

function _paulLangChanged(){
  const sel = document.getElementById('paul-lang');
  if (sel) localStorage.setItem('pp_paul_lang', sel.value);
}

// Keep the drawer sized to the visible viewport so the input stays above the
// on-screen keyboard (which otherwise overlaps fixed elements on iOS/Android).
function _paulFitViewport(){
  const vv = window.visualViewport;
  const panel = document.getElementById('paul-panel');
  if(!vv || !panel) return;
  panel.style.top = vv.offsetTop + 'px';
  panel.style.bottom = 'auto';
  panel.style.height = vv.height + 'px';
  const wrap = document.getElementById('paul-messages');
  if(wrap) wrap.scrollTop = wrap.scrollHeight;
}

function openPaul(){
  document.getElementById('paul-drawer').style.display = 'block';
  const sel = document.getElementById('paul-lang');
  const saved = localStorage.getItem('pp_paul_lang');
  if (sel && saved) sel.value = saved;
  if(!_paulHistory.length){
    const greet = PAUL_GREETINGS[_paulLang()] || PAUL_GREETINGS.English;
    _renderPaulMessage('assistant', greet);
  }
  if(window.visualViewport){
    window.visualViewport.addEventListener('resize', _paulFitViewport);
    window.visualViewport.addEventListener('scroll', _paulFitViewport);
    _paulFitViewport();
  }
  setTimeout(() => document.getElementById('paul-input').focus(), 50);
}

function closePaul(){
  _paulStopConversation();
  document.getElementById('paul-drawer').style.display = 'none';
  if(window.visualViewport){
    window.visualViewport.removeEventListener('resize', _paulFitViewport);
    window.visualViewport.removeEventListener('scroll', _paulFitViewport);
  }
  // Restore the full-height layout for next open.
  const panel = document.getElementById('paul-panel');
  if(panel){ panel.style.top = '0'; panel.style.bottom = '0'; panel.style.height = ''; }
}

function _renderPaulMessage(role, text){
  const wrap = document.getElementById('paul-messages');
  const isUser = role === 'user';
  const div = document.createElement('div');
  div.style.cssText = `align-self:${isUser?'flex-end':'flex-start'};max-width:85%;padding:10px 14px;border-radius:16px;background:${isUser?'var(--teal)':'var(--terra-soft)'};color:${isUser?'var(--cream)':'var(--walnut)'};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:18px;line-height:1.5;white-space:pre-wrap;border:1px solid ${isUser?'var(--teal-deep)':'var(--terra-soft)'}`;
  div.textContent = text;
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
  return div;
}

function _renderPaulThinking(){
  const wrap = document.getElementById('paul-messages');
  const div = document.createElement('div');
  div.style.cssText = `align-self:flex-start;max-width:85%;padding:12px 16px;border-radius:16px;background:var(--terra-soft);color:var(--walnut);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;border:1px solid var(--terra-soft)`;
  // Three wave-animated dots. Setting textContent later (with the answer) clears these.
  div.innerHTML = '<span class="paul-thinking"><span class="paul-dot"></span><span class="paul-dot"></span><span class="paul-dot"></span></span>';
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
  return div;
}

async function sendPaul(){
  const input = document.getElementById('paul-input');
  const sendBtn = document.getElementById('paul-send');
  const text = (input.value || '').trim();
  if(!text) return;
  input.value = '';
  _autoGrow(input); // collapse the box back to one line
  _closeEmoji('paul-emoji','paul-emoji-btn');
  sendBtn.disabled = true; sendBtn.style.opacity = '0.5';
  _renderPaulMessage('user', text);
  _paulHistory.push({ role:'user', content:text });
  const thinking = _renderPaulThinking();
  try {
    const r = await fetch(_SERVER_URL + '/paul/chat', {
      method:'POST',
      headers: await _authHeaders(),
      body: JSON.stringify({ userId: currentUser?.id || null, messages: _paulHistory, lang: _paulLang() })
    });
    const j = await r.json();
    if(!r.ok){ thinking.textContent = '⚠ ' + (j.error || 'Something went wrong.'); }
    else {
      thinking.textContent = j.answer || '(no answer)';
      _paulHistory.push({ role:'assistant', content: j.answer || '' });
    }
  } catch(e){
    thinking.textContent = '⚠ Could not reach Paul: ' + e.message;
  } finally {
    sendBtn.disabled = false; sendBtn.style.opacity = '1';
  }
}

// ═══════════════════════ PAUL — HANDS-FREE VOICE ═══════════════════════
// Bolts speech onto Paul's existing text pipeline: listen (mic + VAD) →
// transcribe (Whisper) → stream the reply (SSE, sentence-by-sentence) →
// speak each sentence (TTS) in order, then loop back to listening.
// The typing path above is untouched. Voice silently no-ops if the server
// has no TTS configured (sentences still appear as text).
let _paulConvOn = false;
let _paulAudioCtx = null;
let _paulMicStream = null;
let _paulRec = null;
let _paulSpeakQueue = [];
let _paulSpeaking = false;
let _paulCurSource = null;
let _paulAudioWaiters = [];

function _paulPickMime(){
  const cands = ['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg'];
  for(const c of cands){ if(window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c; }
  return '';
}

function _paulSetMicUI(on){
  const mic = document.getElementById('paul-mic');
  if(!mic) return;
  mic.innerHTML = on
    ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'
    : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/></svg>';
  mic.style.background = on ? 'var(--terra)' : 'var(--teal)';
  mic.title = on ? 'Stop' : 'Talk with Paul';
}

function _paulSetStatus(text, kind){
  const box = document.getElementById('paul-status');
  const t = document.getElementById('paul-status-text');
  const dot = document.getElementById('paul-status-dot');
  if(!box) return;
  if(!text){ box.style.display = 'none'; return; }
  box.style.display = 'flex';
  if(t) t.textContent = text;
  const colors = { listen:'#2e7d32', think:'#b26a00', speak:'var(--teal-deep)', err:'#b3261e', idle:'var(--walnut-mid)' };
  if(dot) dot.style.background = colors[kind] || 'var(--terra)';
}

async function togglePaulConversation(){
  if(_paulConvOn){ _paulStopConversation(); return; }
  await _paulStartConversation();
}

async function _paulStartConversation(){
  // Immediate feedback so the user knows the tap registered, even if mic setup stalls.
  _paulSetStatus('Starting…', 'idle');
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    _paulSetStatus('Voice needs Safari — open preparingyou.com in Safari to talk with Paul', 'err');
    return;
  }
  try {
    if(!_paulAudioCtx) _paulAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if(_paulAudioCtx.state === 'suspended') await _paulAudioCtx.resume();
    // Silent blip to unlock audio playback on iOS (must run inside the tap).
    try { const b=_paulAudioCtx.createBuffer(1,1,22050); const s=_paulAudioCtx.createBufferSource(); s.buffer=b; s.connect(_paulAudioCtx.destination); s.start(0); } catch(e){}
    // iOS home-screen PWAs can leave getUserMedia pending forever — race a timeout so we never hang silently.
    if(!_paulMicStream){
      const micP = navigator.mediaDevices.getUserMedia({ audio:true });
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000));
      _paulMicStream = await Promise.race([micP, timeout]);
    }
  } catch(e){
    // iPhone home-screen PWAs usually can't get the mic (no prompt, instant denial),
    // and there's no per-app mic toggle in Settings — Safari is the only path.
    const standalone = (window.navigator.standalone === true) ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    const blocked = e && (e.name === 'NotAllowedError' || e.message === 'timeout');
    const msg = (blocked && standalone)
      ? 'Voice needs Safari on iPhone — open preparingyou.com in the Safari browser to talk with Paul'
      : (e && e.name === 'NotAllowedError')
        ? 'Microphone blocked — allow mic access for this site, then try again'
        : (e && e.message === 'timeout')
          ? 'Mic didn’t respond — try opening preparingyou.com in Safari'
          : 'Microphone unavailable (' + ((e && (e.name || e.message)) || 'unknown') + ')';
    _paulSetStatus(msg, 'err');
    return;
  }
  _paulConvOn = true;
  _paulSetMicUI(true);
  _paulConverse();
}

function _paulStopConversation(){
  _paulConvOn = false;
  try { if(_paulRec && _paulRec.state !== 'inactive') _paulRec.stop(); } catch(e){}
  if(_paulCurSource){ try { _paulCurSource.stop(); } catch(e){} _paulCurSource = null; }
  _paulSpeakQueue = []; _paulSpeaking = false;
  _paulAudioWaiters.forEach(fn => fn()); _paulAudioWaiters = [];
  if(_paulMicStream){ try { _paulMicStream.getTracks().forEach(t => t.stop()); } catch(e){} _paulMicStream = null; }
  _paulSetMicUI(false);
  _paulSetStatus('', 'idle');
}

// One full turn loop: listen → transcribe → stream reply → speak → repeat.
async function _paulConverse(){
  while(_paulConvOn){
    _paulSetStatus('Listening…', 'listen');
    let res;
    try { res = await _paulListenOnce(); }
    catch(e){ _paulSetStatus('Mic error', 'err'); _paulStopConversation(); return; }
    if(!_paulConvOn) return;
    if(!res.hadSpeech){ _paulSetStatus('Tap 🎙 when you’re ready', 'idle'); _paulStopConversation(); return; }

    _paulSetStatus('Thinking…', 'think');
    let text = '';
    try { text = await _paulTranscribe(res.blob); }
    catch(e){ _paulSetStatus('Didn’t catch that — try again', 'err'); continue; }
    if(!_paulConvOn) return;
    if(!text){ continue; }

    _renderPaulMessage('user', text);
    _paulHistory.push({ role:'user', content:text });

    const bubble = _renderPaulMessage('assistant', '');
    let full = '';
    try {
      await _paulStreamChat((sentence) => {
        full += (full ? ' ' : '') + sentence;
        bubble.textContent = full;
        const wrap = document.getElementById('paul-messages');
        if(wrap) wrap.scrollTop = wrap.scrollHeight;
        _paulSetStatus('Speaking…', 'speak');
        _paulEnqueueSpeak(sentence);
      });
    } catch(e){
      bubble.textContent = full || ('⚠ ' + e.message);
      if(e.message === 'daily_cap'){ bubble.textContent = 'You’ve reached today’s limit with Paul. Please come back tomorrow.'; _paulStopConversation(); return; }
    }
    _paulHistory.push({ role:'assistant', content: full });
    await _paulWaitForAudio();
    if(!_paulConvOn) return;
  }
}

// Record one utterance, auto-stopping on trailing silence (or a 30s cap).
// Resolves { blob, hadSpeech }. hadSpeech=false when nothing was said.
function _paulListenOnce(){
  return new Promise((resolve, reject) => {
    let raf = 0, src = null;
    try {
      const stream = _paulMicStream;
      const mime = _paulPickMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      _paulRec = rec;
      const chunks = [];
      let speaking = false, silenceStart = 0;
      const started = Date.now();
      const SILENCE_MS = 1200, MAX_MS = 30000, NOSPEECH_MS = 8000, THRESH = 0.02;

      const ctx = _paulAudioCtx;
      src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);

      function cleanup(){ cancelAnimationFrame(raf); try { src.disconnect(); } catch(e){} }
      function stopRec(){ cleanup(); if(rec.state !== 'inactive') rec.stop(); }

      rec.ondataavailable = e => { if(e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        cleanup();
        const blob = new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' });
        resolve({ blob, hadSpeech: speaking });
      };

      function tick(){
        if(!_paulConvOn){ stopRec(); return; }
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for(let i=0;i<data.length;i++){ const v=(data[i]-128)/128; sum += v*v; }
        const rms = Math.sqrt(sum / data.length);
        const now = Date.now();
        if(rms > THRESH){ speaking = true; silenceStart = 0; }
        else if(speaking && !silenceStart){ silenceStart = now; }
        if(speaking && silenceStart && (now - silenceStart) > SILENCE_MS){ stopRec(); return; }
        if(now - started > MAX_MS){ stopRec(); return; }
        if(!speaking && (now - started) > NOSPEECH_MS){ stopRec(); return; }
        raf = requestAnimationFrame(tick);
      }

      rec.start();
      raf = requestAnimationFrame(tick);
    } catch(e){ cancelAnimationFrame(raf); if(src){ try{ src.disconnect(); }catch(_){ } } reject(e); }
  });
}

async function _paulTranscribe(blob){
  const r = await fetch(_SERVER_URL + '/paul/transcribe', {
    method:'POST',
    headers: await _authHeaders({ 'Content-Type': blob.type || 'application/octet-stream', 'X-Paul-Lang': _paulLang() }),
    body: blob
  });
  const j = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return (j.text || '').trim();
}

// Streams Paul's reply over SSE, invoking onSentence(text) per finished sentence.
async function _paulStreamChat(onSentence){
  const r = await fetch(_SERVER_URL + '/paul/chat/stream', {
    method:'POST',
    headers: await _authHeaders(),
    body: JSON.stringify({ userId: currentUser?.id || null, messages: _paulHistory, lang: _paulLang() })
  });
  if(!r.ok){ const j = await r.json().catch(() => ({})); throw new Error(j.error || ('HTTP ' + r.status)); }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while(true){
    const { value, done } = await reader.read();
    if(done) break;
    buf += dec.decode(value, { stream:true });
    let idx;
    while((idx = buf.indexOf('\n\n')) >= 0){
      const ev = _paulParseSSE(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
      if(ev.event === 'sentence' && ev.data && ev.data.text) onSentence(ev.data.text);
      else if(ev.event === 'error') throw new Error((ev.data && ev.data.error) || 'stream error');
    }
  }
}

function _paulParseSSE(raw){
  let event = 'message', dataStr = '';
  raw.split('\n').forEach(line => {
    if(line.startsWith('event:')) event = line.slice(6).trim();
    else if(line.startsWith('data:')) dataStr += line.slice(5).trim();
  });
  let data = null; try { data = dataStr ? JSON.parse(dataStr) : null; } catch(e){}
  return { event, data };
}

function _paulEnqueueSpeak(text){
  _paulSpeakQueue.push(text);
  if(!_paulSpeaking) _paulDrainSpeak();
}

// Fetch + play queued sentences strictly in order, prefetching the next
// sentence's audio while the current one plays so playback is gap-free.
// Playback goes through the Web Audio API (not an <audio> element) because
// iOS only allows programmatic playback through an AudioContext that was
// unlocked inside a user gesture — which we do on the Start tap.
async function _paulDrainSpeak(){
  _paulSpeaking = true;
  // Returns a promise of the sentence's audio bytes, or null on any failure
  // (503 tts_unconfigured / transient error) — the text is already on screen.
  const fetchOne = async (text) => fetch(_SERVER_URL + '/paul/speak', {
      method:'POST', headers: await _authHeaders(), body: JSON.stringify({ text, lang: _paulLang() })
    }).then(r => r.ok ? r.arrayBuffer() : null).catch(() => null);

  let pending = null; // in-flight fetch for the next sentence
  while(_paulConvOn){
    let cur = pending; pending = null;
    if(!cur){
      if(!_paulSpeakQueue.length) break;          // nothing ready → done draining
      cur = fetchOne(_paulSpeakQueue.shift());
    }
    if(_paulSpeakQueue.length) pending = fetchOne(_paulSpeakQueue.shift()); // prefetch next
    const buf = await cur;
    if(!_paulConvOn) break;
    if(buf) await _paulPlayBuffer(buf);
  }
  _paulSpeaking = false;
  if(!_paulSpeakQueue.length){ _paulAudioWaiters.forEach(fn => fn()); _paulAudioWaiters = []; }
}

function _paulPlayBuffer(arrayBuf){
  return new Promise(async (resolve) => {
    const ctx = _paulAudioCtx;
    if(!ctx){ resolve(); return; }
    try { if(ctx.state === 'suspended') await ctx.resume(); } catch(e){}
    let audioBuf;
    try { audioBuf = await ctx.decodeAudioData(arrayBuf.slice(0)); }
    catch(e){ resolve(); return; }   // undecodable chunk → skip, don't stall the loop
    if(!_paulConvOn){ resolve(); return; }
    const node = ctx.createBufferSource();
    node.buffer = audioBuf;
    node.connect(ctx.destination);
    _paulCurSource = node;
    node.onended = () => { if(_paulCurSource === node) _paulCurSource = null; resolve(); };
    try { node.start(0); } catch(e){ resolve(); }
  });
}

function _paulWaitForAudio(){
  if(!_paulSpeaking && !_paulSpeakQueue.length) return Promise.resolve();
  return new Promise(res => _paulAudioWaiters.push(res));
}

// ═══════════════════════ ONBOARDING JOURNEY ═══════════════════════
// The home screen shows one evolving "journey" tile whose content depends on
// how far the user has progressed. Stages:
//   1  watch the 3 introduction videos
//   2  choose a Personal Contact Minister
//   3  listen to the Five Books' audio overviews, in order
//   4  join The Living Network (awaiting PCM sign-off)
//   5  granted access — open TLN and optionally become a PCM
const TOTAL_BOOKS = 5;
let _bookAudioDone = new Set();   // book_ids whose audio overview is complete

async function loadBookAudioProgress(){
  if(!_sb || !currentUser){ _bookAudioDone = new Set(); return; }
  const { data } = await _sb.from('prep_book_audio_progress')
    .select('book_id').eq('user_id', currentUser.id);
  _bookAudioDone = new Set((data || []).map(r => r.book_id));
}

function _booksTotal(){
  return (_booksData && _booksData.length) ? _booksData.length : TOTAL_BOOKS;
}

function journeyStage(){
  if(!currentUser) return 1;
  // Anyone already granted TLN access (graduates and volunteer PCMs) is past
  // the linear journey. Volunteer PCMs in particular may have no pcm_id of
  // their own, so this must come before the pcm_id check to avoid wrongly
  // sending them back to "Choose a PCM".
  if(currentUser.tln_invited_at) return 5;
  if(gatewayProgress().done < GATEWAY_VIDEOS.length) return 1;
  if(!currentUser.pcm_id) return 2;
  if(_bookAudioDone.size < _booksTotal()) return 3;
  return 4;
}

// ── Journey gating ────────────────────────────────────────────────
// Each journey step is locked until the prior one is complete. journeyStage()
// is the single source of truth for "how far along is this user". A page that
// belongs to step N stays locked while journeyStage() < N; we then point the
// user back to whatever step they actually need to do next.
const JOURNEY_STEP = {
  1: { page:'video', cta:'Watch the videos',  what:'watch the three introduction videos' },
  2: { page:'pcm',   cta:'Choose your PCM',   what:'choose a Personal Contact Minister' },
  3: { page:'books', cta:'Start listening',   what:'listen to the audio overview of each of the Five Books' },
};

// Show the page's real content, or a locked card pointing to the next required
// step. The content wrapper (contentId) is hidden while locked. Returns true
// when locked so callers can `return` early and skip their heavy rendering.
function _journeyGate(pageId, contentId, locked, msg, ctaLabel, ctaOnclick){
  const page = document.getElementById(pageId);
  const content = document.getElementById(contentId);
  if(!page || !content) return locked;
  let lock = document.getElementById(pageId + '-lock');
  if(!lock){
    lock = document.createElement('div');
    lock.className = 'card';
    lock.id = pageId + '-lock';
    lock.style.cssText = 'text-align:center;padding:30px 22px;display:none';
    page.insertBefore(lock, page.firstChild);
  }
  if(locked){
    lock.innerHTML = '<div style="margin-bottom:12px"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>'
      + '<div class="card-text" style="margin-bottom:18px">' + msg + '</div>'
      + '<button class="btn-primary" style="margin:0;padding:10px 20px;width:auto" onclick="' + ctaOnclick + '">' + _esc(ctaLabel) + '</button>';
    lock.style.display = 'block';
    content.style.display = 'none';
  } else {
    lock.style.display = 'none';
    content.style.display = '';
  }
  return locked;
}

// Gate a journey page that requires the user to have reached at least minStage.
// Anyone already granted TLN access (graduates and volunteer PCMs) is never
// locked, since they've finished or moved beyond the linear journey.
function _gateJourneyPage(pageId, contentId, minStage){
  if(currentUser && currentUser.tln_invited_at){
    return _journeyGate(pageId, contentId, false);
  }
  const stage = journeyStage();
  if(stage >= minStage) return _journeyGate(pageId, contentId, false);
  const step = JOURNEY_STEP[stage] || JOURNEY_STEP[1];
  const msg = 'First, please ' + step.what + '. This step unlocks once you have.';
  return _journeyGate(pageId, contentId, true, msg, step.cta, "showPage('" + step.page + "')");
}

// Refresh the few user fields the gates depend on, in case they changed since
// sign-in (e.g. a video was finished, or a PCM accepted, on another view).
async function _refreshJourneyFields(){
  if(!_sb || !currentUser) return;
  const { data: u } = await _sb.from('prep_users')
    .select('pcm_id, tln_invited_at, gateway_v1_at, gateway_v2_at, gateway_v3_at')
    .eq('id', currentUser.id).maybeSingle();
  if(u) Object.assign(currentUser, u);
}

function _journeyCard(title, text, meta, ctaLabel, ctaOnclick, accent, extraHtml){
  const titleColor = accent ? 'color:var(--accent-ink)' : '';
  const footStyle = extraHtml
    ? 'display:flex;gap:10px;justify-content:space-between;align-items:center;flex-wrap:wrap'
    : 'text-align:right';
  return '<div class="card-title" style="' + titleColor + '">' + _esc(title) + '</div>'
    + '<div class="card-text">' + text + '</div>'
    + (meta ? '<div style="margin-top:5px;font-size:12px;color:var(--walnut-mid);font-style:italic">' + _esc(meta) + '</div>' : '')
    + '<div style="margin-top:9px;' + footStyle + '">'
    +   (extraHtml || '')
    +   '<button class="btn-primary" style="margin:0;padding:7px 16px;width:auto" onclick="' + ctaOnclick + '">' + _esc(ctaLabel) + '</button>'
    + '</div>';
}

let _kpiData = null; // org-wide KPI snapshot for admins (null = not an admin / not loaded)
async function _loadAdminKpis(){
  try {
    const r = await fetch(_SERVER_URL + '/admin/kpis', { headers: await _authHeaders() });
    if(!r.ok) return; // 403 for non-admins — leave the member tile untouched
    _kpiData = await r.json();
    renderJourneyTile();
  } catch(_){}
}
function _kpiStat(value, label, full){
  return '<div' + (full ? ' style="grid-column:1/-1"' : '') + '>'
    + '<div style="font-size:21px;font-weight:700;color:var(--accent-ink);line-height:1.05">' + value + '</div>'
    + '<div style="font-size:11px;color:var(--walnut-mid);margin-top:2px">' + label + '</div>'
    + '</div>';
}
function _renderKpiTile(k){
  const newBit = k.newMembers7d > 0 ? ' &middot; +' + k.newMembers7d + ' this week' : '';
  return '<div class="card-title" style="color:var(--accent-ink)">'
      + '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="vertical-align:-2px;margin-right:6px"><path d="M12 2l1.9 6.6L20 10l-6.1 1.4L12 18l-1.9-6.6L4 10l6.1-1.4L12 2z"/></svg>'
      + 'Network at a glance</div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:9px 14px;margin-top:9px">'
      + _kpiStat(k.members, 'Members' + newBit)
      + _kpiStat(k.gatewayPct + '%', 'Finished intro videos')
      + _kpiStat(k.booksPct + '%', 'Finished the Five Books')
      + _kpiStat(k.activePairings, 'Active PCM pairings')
    + '</div>'
    + '<div style="margin-top:9px;text-align:right">'
      + '<button class="btn-primary" style="margin:0;padding:6px 12px;width:auto;font-size:12px" onclick="openTlnHandoff()">Enter The Living Network &rarr;</button>'
    + '</div>';
}
function renderJourneyTile(){
  const tile = document.getElementById('journey-tile');
  if(!tile || !currentUser) return;
  if(_kpiData){ tile.innerHTML = _renderKpiTile(_kpiData); return; }
  const stage = journeyStage();
  let html = '';
  if(stage === 1){
    const done = gatewayProgress().done;
    html = _journeyCard('Welcome',
      'Begin by watching the introduction videos. Once all three are finished, you will be invited to choose a Personal Contact Minister to walk this preparation with you.',
      done + '/3 videos watched',
      done > 0 ? 'Continue watching' : 'Watch the videos', "showPage('video')");
  } else if(stage === 2){
    // Left: the small "Choosing a PCM" explainer button (where the old Video
    // button sat). Right: the primary CTA with a compact, no-underline
    // "Re-watch intro videos" link tucked beneath it. Kept tight so the tile
    // stays the same height as before the link was added.
    html = '<div class="card-title" style="color:var(--accent-ink)">Choose a Personal Contact Minister</div>'
      + '<div class="card-text">You have finished the introduction videos. Now choose a Personal Contact Minister &mdash; someone who will walk this preparation alongside you.</div>'
      + '<div style="margin-top:9px;display:flex;gap:8px;justify-content:space-between;align-items:flex-start;flex-wrap:nowrap">'
      +   '<button style="margin:0;padding:6px 9px;width:auto;background:transparent;border:1px solid var(--accent-ink);color:var(--accent-ink);border-radius:10px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:5px;white-space:nowrap" onclick="openPcmVideo()"><svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>Choosing a PCM</button>'
      +   '<div style="display:flex;flex-direction:column;align-items:center;gap:2px">'
      +     '<button class="btn-primary" style="margin:0;padding:7px 12px;width:auto;white-space:nowrap;letter-spacing:.05em" onclick="showPage(\'pcm\')">Choose your PCM</button>'
      +     '<a onclick="showPage(\'video\')" style="font-size:11px;color:var(--accent-ink);text-decoration:none;cursor:pointer">Re-watch intro videos</a>'
      +   '</div>'
      + '</div>';
  } else if(stage === 3){
    html = _journeyCard('Listen to the Five Books',
      'With your PCM alongside you, listen to the audio overview of each of the Five Books &mdash; in order. Each one unlocks the next.',
      _bookAudioDone.size + '/' + _booksTotal() + ' audios completed',
      _bookAudioDone.size > 0 ? 'Continue listening' : 'Start listening', "showPage('books')", true);
  } else if(stage === 4){
    html = _journeyCard('Join The Living Network',
      'You have listened to all five books — the door is open. Join The Living Network with your real name and a real email address: your church record forms are generated from them.',
      '', 'Join The Living Network', "showPage('join-tln')", true);
  } else {
    html = '<div class="card-title" style="color:var(--accent-ink)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><path d="M12 2l1.9 6.6L20 10l-6.1 1.4L12 18l-1.9-6.6L4 10l6.1-1.4L12 2z" fill="currentColor" stroke="none"/></svg>The Living Network</div>'
      + '<div class="card-text">You have been granted access to The Living Network. You may also choose to become a Personal Contact Minister yourself and walk this preparation alongside others.</div>'
      + '<div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">'
      +   '<button class="btn-secondary" style="margin:0;padding:9px 18px;width:auto" onclick="showPage(\'pcm\')">Become a PCM</button>'
      +   '<button class="btn-primary" style="margin:0;padding:9px 18px;width:auto" onclick="openTlnHandoff()">Enter The Living Network →</button>'
      + '</div>';
  }
  tile.innerHTML = html;
}

// ════════════════ LOCAL ALMANAC (home weather card) ═══════════════
// A self-contained weather / sunrise-sunset / moon-phase card on the home
// screen (it replaced the redundant Vault tile). Location is derived with NO
// prompt from the member's stored IANA timezone (the city after the last "/"),
// with the region country as a geocoding hint. Data comes from Open-Meteo
// (keyless, CORS-friendly); the moon phase is computed locally. Units: °F for
// US members, °C everywhere else. If anything fails to load, the card stays
// hidden rather than showing an error.
const _ALM_A = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
function _almSvg(p, px){ px = px||24; return '<svg width="'+px+'" height="'+px+'" '+_ALM_A+' style="color:var(--terra)">'+p+'</svg>'; }
const _ALM_ICONS = {
  sun:'<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.2" y1="4.2" x2="5.6" y2="5.6"/><line x1="18.4" y1="18.4" x2="19.8" y2="19.8"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.2" y1="19.8" x2="5.6" y2="18.4"/><line x1="18.4" y1="5.6" x2="19.8" y2="4.2"/>',
  partly:'<path d="M8 5a4 4 0 0 1 7.5 1.5"/><path d="M17 18a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.6 1.5A3.5 3.5 0 0 0 6.5 18z"/>',
  cloud:'<path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.6A4 4 0 0 0 6 19z"/>',
  fog:'<path d="M16 16a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.6 1.5A3.5 3.5 0 0 0 5.5 16z"/><line x1="3" y1="20" x2="15" y2="20"/><line x1="8" y1="23" x2="20" y2="23"/>',
  rain:'<path d="M17.5 15a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.6A4 4 0 0 0 6 15z"/><line x1="8" y1="18" x2="7" y2="21"/><line x1="12" y1="18" x2="11" y2="21"/><line x1="16" y1="18" x2="15" y2="21"/>',
  snow:'<path d="M17.5 14a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.6A4 4 0 0 0 6 14z"/><line x1="8" y1="18" x2="8" y2="18.01"/><line x1="12" y1="20" x2="12" y2="20.01"/><line x1="16" y1="18" x2="16" y2="18.01"/>',
  thunder:'<path d="M17.5 13a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.6A4 4 0 0 0 6 13z"/><polyline points="12 14 10 18 13 18 11 22"/>',
  sunrise:'<path d="M17 18a5 5 0 0 0-10 0"/><line x1="12" y1="2" x2="12" y2="9"/><line x1="5.2" y1="11.2" x2="4" y2="10"/><line x1="18.8" y1="11.2" x2="20" y2="10"/><line x1="1" y1="18" x2="23" y2="18"/><polyline points="8 6 12 2 16 6"/>',
  sunset:'<path d="M17 18a5 5 0 0 0-10 0"/><line x1="12" y1="9" x2="12" y2="2"/><line x1="5.2" y1="11.2" x2="4" y2="10"/><line x1="18.8" y1="11.2" x2="20" y2="10"/><line x1="1" y1="18" x2="23" y2="18"/><polyline points="16 5 12 9 8 5"/>'
};
function _almCodeInfo(c){
  if(c===0) return {l:'Clear',i:'sun'};
  if(c<=2) return {l:'Partly cloudy',i:'partly'};
  if(c===3) return {l:'Overcast',i:'cloud'};
  if(c===45||c===48) return {l:'Fog',i:'fog'};
  if(c>=51&&c<=57) return {l:'Drizzle',i:'rain'};
  if(c>=71&&c<=77) return {l:'Snow',i:'snow'};
  if(c>=80&&c<=82) return {l:'Rain showers',i:'rain'};
  if(c>=85&&c<=86) return {l:'Snow showers',i:'snow'};
  if(c>=95) return {l:'Thunderstorm',i:'thunder'};
  if(c>=61&&c<=67) return {l:'Rain',i:'rain'};
  return {l:'Cloudy',i:'cloud'};
}
// Map wttr.in's WWO weather codes onto the WMO codes _almCodeInfo expects, so
// the fallback renders through the exact same icon/label path as Open-Meteo.
function _wwoToWmo(w){
  w = +w || 0;
  if(w===113) return 0;                       // clear / sunny
  if(w===116) return 2;                       // partly cloudy
  if(w===119||w===122) return 3;              // cloudy / overcast
  if(w===143||w===248||w===260) return 45;    // mist / fog
  if(w===200||w===386||w===389||w===392||w===395) return 95; // thunder
  if([179,227,230,323,326,329,332,335,338,368,371,182,185,281,284,317,320,350,362,365,374,377].indexOf(w)>=0) return 73; // snow / sleet / ice
  if([176,263,266,293,296].indexOf(w)>=0) return 51;          // drizzle / light rain
  if([299,302,305,308,311,314,353,356,359].indexOf(w)>=0) return 63; // rain / showers
  return 3;                                   // default: cloudy
}
// Turn a wttr clock string like "06:42 AM" into a Date-parseable local stamp
// ("YYYY-MM-DDTHH:MM") so the existing fmtTime() can render sunrise/sunset.
function _almClock(date, t){
  if(!t) return null;
  const m = /(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(t);
  if(!m) return null;
  let h = +m[1]; const ap = (m[3]||'').toUpperCase();
  if(ap==='PM' && h<12) h += 12;
  if(ap==='AM' && h===12) h = 0;
  return date + 'T' + String(h).padStart(2,'0') + ':' + m[2];
}
// Map MET Norway's symbol_code strings onto the WMO codes _almCodeInfo expects.
function _metToWmo(code){
  code = String(code||'').replace(/_(day|night|polartwilight)$/,'');
  if(code.indexOf('thunder')>=0) return 95;
  if(code.indexOf('sleet')>=0 || code.indexOf('snow')>=0) return 73;
  if(code.indexOf('fog')>=0) return 45;
  if(code.indexOf('heavyrain')>=0) return 65;
  if(code.indexOf('rain')>=0) return 63;
  if(code.indexOf('drizzle')>=0) return 51;
  if(code==='cloudy') return 3;
  if(code==='partlycloudy') return 2;
  if(code==='fair') return 1;
  if(code==='clearsky') return 0;
  return 3;
}
// Current UTC offset ("+HH:MM") for an IANA zone, so MET's Sunrise API returns
// sunrise/sunset already expressed in the location's local clock.
function _almOffset(tz){
  const now = new Date();
  if(tz){ try{
    const s = new Intl.DateTimeFormat('en-US',{timeZone:tz,timeZoneName:'longOffset'}).formatToParts(now).find(p=>p.type==='timeZoneName').value;
    const m = /GMT([+-]\d{2}):?(\d{2})?/.exec(s);
    if(m) return m[1]+':'+(m[2]||'00');
  }catch(_){} }
  const off = -now.getTimezoneOffset();
  const sign = off>=0?'+':'-'; const a = Math.abs(off);
  return sign+String(Math.floor(a/60)).padStart(2,'0')+':'+String(a%60).padStart(2,'0');
}
// MET Norway fallback: aggregate the 10-day timeseries into today + 3 forecast
// days (daily min/max + a near-noon symbol) and reshape into the Open-Meteo
// response. Preferred over wttr.in because it yields the full 3-day outlook the
// card expects, where wttr's j1 feed only carries today + 2 days.
async function _almMet(r, useF){
  const tz = (r.timezone && r.timezone!=='auto') ? r.timezone : undefined;
  const conv = useF ? (c=>Math.round(c*9/5+32)) : (c=>Math.round(c));
  const dFmt = new Intl.DateTimeFormat('en-CA', Object.assign({year:'numeric',month:'2-digit',day:'2-digit'}, tz?{timeZone:tz}:{}));
  const hFmt = new Intl.DateTimeFormat('en-US', Object.assign({hour:'numeric',hour12:false}, tz?{timeZone:tz}:{}));
  const f = await _almFetchJSON('https://api.met.no/weatherapi/locationforecast/2.0/compact?lat='+r.latitude+'&lon='+r.longitude, 9000);
  const ts = f && f.properties && f.properties.timeseries;
  if(!ts || !ts.length) throw 0;
  const byDay = {};
  ts.forEach(e => {
    const date = dFmt.format(new Date(e.time));
    const o = byDay[date] || (byDay[date] = {temps:[], sym:null, nd:1e9});
    const tp = e.data.instant.details.air_temperature;
    if(typeof tp==='number') o.temps.push(tp);
    const sym = (e.data.next_6_hours&&e.data.next_6_hours.summary.symbol_code) || (e.data.next_1_hours&&e.data.next_1_hours.summary.symbol_code);
    if(sym){ const h=+hFmt.format(new Date(e.time)); const nd=Math.abs((h%24)-12); if(nd<o.nd){o.nd=nd;o.sym=sym;} }
  });
  const dates = Object.keys(byDay).sort().slice(0,4);
  if(!dates.length) throw 0;
  const cur0 = ts[0];
  const curSym = (cur0.data.next_1_hours&&cur0.data.next_1_hours.summary.symbol_code)||(cur0.data.next_6_hours&&cur0.data.next_6_hours.summary.symbol_code);
  let sunrise=null, sunset=null;
  try{
    const sr = await _almFetchJSON('https://api.met.no/weatherapi/sunrise/3.0/sun?lat='+r.latitude+'&lon='+r.longitude+'&date='+dates[0]+'&offset='+encodeURIComponent(_almOffset(tz)), 8000);
    const strip = t => t ? t.replace(/([+-]\d{2}:\d{2}|Z)$/,'') : null;
    sunrise = strip(sr && sr.properties && sr.properties.sunrise && sr.properties.sunrise.time);
    sunset  = strip(sr && sr.properties && sr.properties.sunset  && sr.properties.sunset.time);
  }catch(_){}
  return {
    current: { temperature_2m: conv(cur0.data.instant.details.air_temperature), weather_code: _metToWmo(curSym) },
    daily: {
      time: dates,
      weather_code: dates.map(d => _metToWmo(byDay[d].sym)),
      temperature_2m_max: dates.map(d => conv(Math.max.apply(null, byDay[d].temps))),
      temperature_2m_min: dates.map(d => conv(Math.min.apply(null, byDay[d].temps))),
      sunrise: [ sunrise ],
      sunset:  [ sunset ]
    },
    timezone: tz
  };
}
// Fetch the forecast with a fallback chain so the card survives a provider
// outage. Primary: Open-Meteo (clean WMO codes, 3-day outlook). If its host is
// unreachable: MET Norway, reshaped to the same 3-day outlook. Last resort:
// wttr.in (today + 2 days). Each tier is reshaped into the Open-Meteo response
// so the renderer below is unchanged regardless of which provider answered.
async function _almWeather(r, useF){ // ALMFALLBACK-MARKER
  try{
    const url = 'https://api.open-meteo.com/v1/forecast?latitude='+r.latitude+'&longitude='+r.longitude
      + '&current=temperature_2m,weather_code'
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset'
      + '&temperature_unit='+(useF?'fahrenheit':'celsius')
      + '&timezone='+encodeURIComponent(r.timezone||'auto')+'&forecast_days=4';
    // Short primary timeout: Open-Meteo answers in well under a second when
    // healthy, so 4s is ample headroom while still failing over quickly to the
    // backup providers when its host hangs during an outage.
    const w = await _almFetchJSON(url, 4000);
    if(w && w.current && w.daily) return w;
  }catch(e){ /* primary down — try the 3-day backup, then the last resort */ }
  try{ const m = await _almMet(r, useF); if(m && m.current && m.daily) return m; }
  catch(e){ /* MET Norway unreachable — fall through to wttr.in */ }
  const j = await _almFetchJSON('https://wttr.in/'+r.latitude+','+r.longitude+'?format=j1', 9000);
  const cc = j && j.current_condition && j.current_condition[0];
  const wx = (j && j.weather) || [];
  if(!cc || !wx.length) throw 0;
  const U = useF ? 'F' : 'C';
  const a0 = (wx[0].astronomy && wx[0].astronomy[0]) || {};
  return {
    current: { temperature_2m: +cc['temp_'+U], weather_code: _wwoToWmo(cc.weatherCode) },
    daily: {
      time: wx.map(d => d.date),
      weather_code: wx.map(d => { const hh = d.hourly && (d.hourly[4] || d.hourly[Math.floor(d.hourly.length/2)]); return _wwoToWmo(hh && hh.weatherCode); }),
      temperature_2m_max: wx.map(d => +d['maxtemp'+U]),
      temperature_2m_min: wx.map(d => +d['mintemp'+U]),
      sunrise: [ _almClock(wx[0].date, a0.sunrise) ],
      sunset:  [ _almClock(wx[0].date, a0.sunset) ]
    },
    timezone: (r.timezone && r.timezone !== 'auto') ? r.timezone : undefined
  };
}
function _almMoonInfo(date){
  const synodic = 29.530588853;
  const knownNew = Date.UTC(2000,0,6,18,14,0)/86400000;
  const days = date.getTime()/86400000;
  const age = ((((days - knownNew) % synodic) + synodic) % synodic);
  const phase = age / synodic; // 0..1
  const illum = Math.round((1 - Math.cos(phase*2*Math.PI))/2 * 100);
  const names = ['New Moon','Waxing Crescent','First Quarter','Waxing Gibbous','Full Moon','Waning Gibbous','Last Quarter','Waning Crescent'];
  return {phase, illum, name: names[Math.round(phase*8) % 8]};
}
function _almMoonSVG(phase, size){
  const r = size/2;
  const frac = (1 - Math.cos(phase*2*Math.PI))/2;
  const waxing = phase <= 0.5;
  const rx = r*Math.abs(2*frac - 1);
  const outerSweep = waxing ? 1 : 0;
  const innerSweep = (frac >= 0.5) ? (waxing ? 1 : 0) : (waxing ? 0 : 1);
  const d = 'M '+r+' 0 A '+r+' '+r+' 0 0 '+outerSweep+' '+r+' '+(2*r)+' A '+rx+' '+r+' 0 0 '+innerSweep+' '+r+' 0 Z';
  return '<svg width="'+size+'" height="'+size+'" viewBox="0 0 '+size+' '+size+'">'
    + '<circle cx="'+r+'" cy="'+r+'" r="'+r+'" fill="#2c2238"/>'
    + '<path d="'+d+'" fill="#f3e3c0"/>'
    + '<circle cx="'+r+'" cy="'+r+'" r="'+(r-0.5)+'" fill="none" stroke="#cbb88e" stroke-width="1"/></svg>';
}
let _almLoaded = false, _almFetching = false, _almTries = 0, _almRetryTimer = null; // ALMRESILIENT-MARKER
async function _almFetchJSON(url, ms){
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 9000);
  try { const r = await fetch(url, { signal: ctrl.signal }); return await r.json(); }
  finally { clearTimeout(t); }
}
function _almCity(){
  const tz = (currentUser && currentUser.timezone) || '';
  if(tz.indexOf('/') >= 0) return tz.slice(tz.lastIndexOf('/')+1).replace(/_/g,' ');
  return _regionState((currentUser && currentUser.region) || '');
}
// Resolve the member's location for the weather card. We try the device's real
// GPS position first (one-time browser permission) so the forecast is for the
// exact spot they're standing — not just their timezone's representative city.
// If GPS is denied or unavailable we fall back to geocoding the timezone city.
function _almGPS(){
  return new Promise(function(resolve){
    if(!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      function(p){ resolve({lat:p.coords.latitude, lon:p.coords.longitude}); },
      function(){ resolve(null); },
      { enableHighAccuracy:false, timeout:8000, maximumAge:1800000 }
    );
  });
}
async function _almReverse(lat, lon){
  try{
    const j = await _almFetchJSON('https://api.bigdatacloud.net/data/reverse-geocode-client?latitude='+lat+'&longitude='+lon+'&localityLanguage=en', 7000);
    return { name: j.locality || j.city || j.principalSubdivision || '', country: j.countryName || '' };
  }catch(e){ return { name:'', country:'' }; }
}
async function _almPlace(){
  const gps = await _almGPS();
  if(gps){
    const rc = await _almReverse(gps.lat, gps.lon);
    return { latitude: gps.lat, longitude: gps.lon, name: rc.name || _almCity() || '', country: rc.country, timezone: 'auto' };
  }
  const city = _almCity();
  if(!city) return null;
  const g = await _almFetchJSON('https://geocoding-api.open-meteo.com/v1/search?name='+encodeURIComponent(city)+'&count=1', 8000);
  if(!g.results || !g.results.length) return null;
  const r = g.results[0];
  return { latitude: r.latitude, longitude: r.longitude, name: r.name, country: r.country||'', timezone: r.timezone||'auto' };
}
async function renderAlmanac(){
  const card = document.getElementById('almanac-card');
  if(!card || !currentUser || _almLoaded || _almFetching) return;
  const country = _regionCountry(currentUser.region || '');
  const useF = /united states|u\.?s\.?a?\.?$|^us$|america/i.test(country.trim());
  _almFetching = true;
  try {
    const r = await _almPlace();
    if(!r) throw 0;
    const w = await _almWeather(r, useF);
    const cur = w.current, d = w.daily;
    if(!cur || !d) throw 0;
    const ci = _almCodeInfo(cur.weather_code);
    const moon = _almMoonInfo(new Date());
    const tz = w.timezone || (r.timezone && r.timezone !== 'auto' ? r.timezone : null) || currentUser.timezone || undefined;
    const localDate = new Date().toLocaleDateString(undefined, {weekday:'long', day:'numeric', month:'long', timeZone: tz});
    const deg = useF ? '°F' : '°C';
    const fmtTime = iso => new Date(iso).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
    const fmtDay = iso => new Date(iso+'T00:00').toLocaleDateString(undefined,{weekday:'short'});
    let fc = '';
    for(let i=1;i<=3 && i<d.time.length;i++){
      const fi = _almCodeInfo(d.weather_code[i]);
      fc += '<div class="alm-col"><div class="alm-d">'+fmtDay(d.time[i])+'</div>'+_almSvg(_ALM_ICONS[fi.i],22)
          + '<div class="alm-hl"><b>'+Math.round(d.temperature_2m_max[i])+'°</b> <span>'+Math.round(d.temperature_2m_min[i])+'°</span></div></div>';
    }
    card.innerHTML =
        '<div class="alm-date">'+_esc(localDate)+'</div>'
      + '<div class="alm-head">'
      +   '<div class="alm-temp">'+_almSvg(_ALM_ICONS[ci.i],36)
      +     '<div><div class="alm-t">'+Math.round(cur.temperature_2m)+deg+'</div><div class="alm-cond">'+_esc(ci.l)+'</div></div></div>'
      +   '<div class="alm-loc"><div class="alm-city">'+_esc(r.name)+'</div><div class="alm-lbl">'+_esc(r.country||country||'')+'</div></div>'
      + '</div>'
      + '<div class="alm-div"></div>'
      + '<div class="alm-sky">'
      +   '<div class="alm-col"><div class="alm-k">Sunrise</div>'+_almSvg(_ALM_ICONS.sunrise,22)+'<div class="alm-v">'+fmtTime(d.sunrise[0])+'</div></div>'
      +   '<div class="alm-col"><div class="alm-k">Sunset</div>'+_almSvg(_ALM_ICONS.sunset,22)+'<div class="alm-v">'+fmtTime(d.sunset[0])+'</div></div>'
      +   '<div class="alm-col"><div class="alm-k">Moon</div>'+_almMoonSVG(moon.phase,22)+'<div class="alm-v" style="font-size:12px">'+_esc(moon.name)+'</div><div class="alm-sub">'+moon.illum+'% lit</div></div>'
      + '</div>'
      + '<div class="alm-div"></div>'
      + '<div class="alm-fc">'+fc+'</div>';
    card.style.display = 'block';
    _almLoaded = true;
  } catch(e){
    // Transient weather/geocode outage: don't leave the card silently blank —
    // retry a few times with backoff so it self-heals without an app reload.
    if(_almTries < 4 && !_almRetryTimer){
      _almTries++;
      _almRetryTimer = setTimeout(() => { _almRetryTimer = null; renderAlmanac(); }, 15000);
    }
  } finally {
    _almFetching = false;
  }
}

async function refreshHomeTiles(){
  if(!currentUser) return;
  // Cache-first: paint the journey tile immediately from in-memory state so
  // returning Home is instant, then refresh from the network in the background
  // (the two queries run in parallel, not as a waterfall) and re-paint.
  renderJourneyTile();
  _loadAdminKpis();
  if(!_sb) return;
  const [uRes] = await Promise.all([
    _sb.from('prep_users')
      .select('pcm_id, tln_invited_at, joined_tln_at, gateway_v1_at, gateway_v2_at, gateway_v3_at')
      .eq('id', currentUser.id).maybeSingle(),
    loadBookAudioProgress(),
  ]);
  if(uRes && uRes.data) Object.assign(currentUser, uRes.data);
  renderJourneyTile();
}

// ═════════════════════════ GATEWAY VIDEOS ═════════════════════════
const GATEWAY_VIDEOS = [
  { idx:1, key:'gateway_v1_at', src:'/videos/1-contracts.mp4', title:'Contracts',  subtitle:'Step 1 of 3' },
  { idx:2, key:'gateway_v2_at', src:'/videos/2-snare.mp4',     title:'The Snare',  subtitle:'Step 2 of 3' },
  { idx:3, key:'gateway_v3_at', src:'/videos/3-true.mp4',      title:'The Way',    subtitle:'Step 3 of 3' },
];
let _gatewayMaxTime = 0; // seconds — anti-skip ceiling for current video
let _gatewayCurrent = null;

function gatewayProgress(){
  if(!currentUser) return { done:0, next:GATEWAY_VIDEOS[0] };
  let done = 0;
  for(const v of GATEWAY_VIDEOS){ if(currentUser[v.key]) done++; else break; }
  return { done, next: GATEWAY_VIDEOS[done] || null };
}

function buildGatewayPage(){
  const list = document.getElementById('gateway-list');
  const { done, next } = gatewayProgress();
  let html = '';
  GATEWAY_VIDEOS.forEach(v => {
    const isDone = !!(currentUser && currentUser[v.key]);
    const isNext = !isDone && next && next.idx === v.idx;
    const locked = !isDone && !isNext;
    const icon = isDone ? '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block; color:var(--success);"><polyline points="20 6 9 17 4 12"/></svg>' : (locked ? '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' : '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;"><polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none"/></svg>');
    const meta = isDone ? 'Watched' : (isNext ? 'Tap to watch' : 'Locked — finish previous video');
    const style = locked ? 'opacity:.45;pointer-events:none' : '';
    const onclick = (isDone || isNext) ? `onclick="playGateway(${v.idx})"` : '';
    html += `<div class="card" style="display:flex;align-items:center;gap:14px;cursor:${locked?'default':'pointer'};${style}" ${onclick}>
      <div style="font-size:24px;width:36px;text-align:center">${icon}</div>
      <div style="flex:1">
        <div class="card-title" style="margin:0">${v.title}</div>
        <div style="font-size:12px;color:var(--walnut-mid);font-style:italic">${v.subtitle} · ${meta}</div>
      </div>
    </div>`;
  });
  if(done === GATEWAY_VIDEOS.length){
    html += `<div class="card" style="border-color:var(--terra);background:var(--terra-soft)">
      <div class="card-title" style="color:var(--accent-ink)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><polyline points="20 6 9 17 4 12"/></svg>Introduction Complete</div>
      <div class="card-text">All three videos watched. You may continue to the next step on the home page.</div>
    </div>`;
  }
  list.innerHTML = html;
}

function playGateway(idx){
  const v = GATEWAY_VIDEOS.find(x => x.idx === idx); if(!v) return;
  const { next } = gatewayProgress();
  const isDone = !!(currentUser && currentUser[v.key]);
  // Only allow already-completed or the immediate next
  if(!isDone && (!next || next.idx !== idx)) return;
  _gatewayCurrent = v;
  const resume = _loadAudioPos('gateway', v.idx);
  // Re-watching a done video: free seek. First watch: the anti-skip ceiling
  // starts where they last left off, so they resume instead of starting over.
  _gatewayMaxTime = isDone ? Infinity : resume;
  const wrap = document.getElementById('gateway-player-wrap');
  const player = document.getElementById('gateway-player');
  document.getElementById('gateway-player-title').textContent = v.title;
  player.src = v.src;
  wrap.style.display = 'block';
  player.load();
  player.play().catch(()=>{});
  _resumeAudioAt(player, resume);   // jump to last spot once metadata is ready
  wrap.scrollIntoView({behavior:'smooth', block:'start'});
}

// In-app popup player for the "Choosing a PCM" explainer video.
const PCM_VIDEO_SRC = '/videos/choose-pcm.mp4';
let _pcmMaxTime = 0;   // seconds — anti-skip ceiling for the PCM video
const PCM_DONE_KEY = 'pp_pcmvid_done_choose-pcm';
function _pcmDone(){ try{ return localStorage.getItem(PCM_DONE_KEY) === '1'; }catch(e){ return false; } }
function openPcmVideo(){
  const modal = document.getElementById('pcm-video-modal');
  const player = document.getElementById('pcm-video-player');
  if(!modal || !player) return;
  if(!player.getAttribute('src')) player.src = PCM_VIDEO_SRC;
  modal.style.display = 'flex';
  player.load();
  const resume = _loadAudioPos('pcmvid', 'choose-pcm');
  // First watch: ceiling starts at the last spot they reached (no skipping
  // ahead). Once finished, free seeking is allowed on re-watch.
  _pcmMaxTime = _pcmDone() ? Infinity : resume;
  player.play().catch(()=>{});
  _resumeAudioAt(player, resume);   // jump to last spot once metadata is ready
}
function closePcmVideo(){
  const player = document.getElementById('pcm-video-player');
  if(player){
    if(!player.ended) _saveAudioPos('pcmvid', 'choose-pcm', player.currentTime);
    try{ player.pause(); }catch(_){}
  }
  const modal = document.getElementById('pcm-video-modal');
  if(modal) modal.style.display = 'none';
}
document.addEventListener('DOMContentLoaded', () => {
  const player = document.getElementById('pcm-video-player');
  if(!player) return;
  player.addEventListener('timeupdate', () => {
    if(_pcmMaxTime !== Infinity){
      if(player.currentTime > _pcmMaxTime + 0.5){
        player.currentTime = _pcmMaxTime;   // tried to seek past unwatched portion — snap back
      } else if(player.currentTime > _pcmMaxTime){
        _pcmMaxTime = player.currentTime;    // advance the ceiling as they watch
      }
    }
    const now = Date.now();
    if(now - _lastAudioPosSave > 3000){
      _lastAudioPosSave = now;
      _saveAudioPos('pcmvid', 'choose-pcm', player.currentTime);
    }
  });
  player.addEventListener('pause', () => { if(!player.ended) _saveAudioPos('pcmvid', 'choose-pcm', player.currentTime); });
  player.addEventListener('ended', () => {
    try{ localStorage.setItem(PCM_DONE_KEY, '1'); }catch(e){}
    _clearAudioPos('pcmvid', 'choose-pcm');
  });
});

// Re-watchable introduction videos, surfaced permanently in the Vault → Video
// tab. Same three gateway clips; by the time they appear here the member has
// already completed them, so free seeking is fine (no anti-skip ceiling).
function openIntroVideo(idx){
  const v = GATEWAY_VIDEOS.find(x => x.idx === idx); if(!v) return;
  const modal = document.getElementById('intro-video-modal');
  const player = document.getElementById('intro-video-player');
  if(!modal || !player) return;
  const t = document.getElementById('intro-video-title');
  if(t) t.textContent = v.title;
  player.src = v.src;
  modal.style.display = 'flex';
  player.load();
  player.play().catch(()=>{});
}
function closeIntroVideo(){
  const player = document.getElementById('intro-video-player');
  if(player){ try{ player.pause(); }catch(_){} player.removeAttribute('src'); try{ player.load(); }catch(_){} }
  const modal = document.getElementById('intro-video-modal');
  if(modal) modal.style.display = 'none';
}

function stopGatewayPlayer(){
  const player = document.getElementById('gateway-player');
  if(player){
    if(_gatewayCurrent && _gatewayMaxTime !== Infinity) _saveAudioPos('gateway', _gatewayCurrent.idx, player.currentTime);
    try{ player.pause(); }catch(_){} player.removeAttribute('src'); player.load();
  }
  const wrap = document.getElementById('gateway-player-wrap');
  if(wrap) wrap.style.display = 'none';
  _gatewayCurrent = null;
  _gatewayMaxTime = 0;
}

document.addEventListener('DOMContentLoaded', () => {
  const player = document.getElementById('gateway-player');
  if(!player) return;
  player.addEventListener('timeupdate', () => {
    if(_gatewayMaxTime === Infinity) return;
    if(player.currentTime > _gatewayMaxTime + 0.5){
      // user tried to seek past unwatched portion — snap back
      player.currentTime = _gatewayMaxTime;
    } else if(player.currentTime > _gatewayMaxTime){
      _gatewayMaxTime = player.currentTime;
    }
    // Remember where they are so an interruption resumes here next time.
    const now = Date.now();
    if(_gatewayCurrent && now - _lastAudioPosSave > 3000){
      _lastAudioPosSave = now;
      _saveAudioPos('gateway', _gatewayCurrent.idx, player.currentTime);
    }
  });
  player.addEventListener('pause', () => {
    if(_gatewayCurrent && _gatewayMaxTime !== Infinity) _saveAudioPos('gateway', _gatewayCurrent.idx, player.currentTime);
  });
  player.addEventListener('seeking', () => {
    if(_gatewayMaxTime === Infinity) return;
    if(player.currentTime > _gatewayMaxTime + 0.5){
      player.currentTime = _gatewayMaxTime;
    }
  });
  player.addEventListener('ended', async () => {
    if(!_gatewayCurrent || !_sb || !currentUser) return;
    const v = _gatewayCurrent;
    _clearAudioPos('gateway', v.idx); // finished — no resume needed next time
    if(currentUser[v.key]) return; // already recorded
    const now = new Date().toISOString();
    const patch = { [v.key]: now };
    // If this was the last one, also stamp the legacy aggregate
    if(v.idx === GATEWAY_VIDEOS.length) patch.gateway_watched_at = now;
    const { error } = await _sb.from('prep_users').update(patch).eq('id', currentUser.id);
    if(!error){
      Object.assign(currentUser, patch);
      buildGatewayPage();
    }
  });
});

// Book audio-overview player: anti-skip + record completion so the "in order"
// gate and the journey advance. Mirrors the gateway video behaviour.
document.addEventListener('DOMContentLoaded', () => {
  const player = document.getElementById('book-listen-player');
  if(player){
    // During normal playback only advance the "furthest heard" ceiling and save
    // position — never snap the time back (the old per-tick snap caused the
    // stutter / cut-outs on mobile, where ticks can jump more than 0.5s).
    player.addEventListener('timeupdate', () => {
      if(_bookListenMaxTime !== Infinity && player.currentTime > _bookListenMaxTime){
        _bookListenMaxTime = player.currentTime;
      }
      const now = Date.now();
      if(now - _lastAudioPosSave > 3000){ _lastAudioPosSave = now; _saveAudioPos('overview', _bookListenId, player.currentTime); }
    });
    // Anti-skip is enforced only on user seeks: can't jump past the furthest heard.
    player.addEventListener('seeking', () => {
      if(_bookListenMaxTime === Infinity) return;
      if(player.currentTime > _bookListenMaxTime + 0.5){
        player.currentTime = _bookListenMaxTime;
      }
    });
    player.addEventListener('pause', () => _saveAudioPos('overview', _bookListenId, player.currentTime));
    player.addEventListener('ended', async () => {
      _clearAudioPos('overview', _bookListenId);   // finished — next open starts fresh
      if(_bookListenId == null || !_sb || !currentUser) return;
      if(_bookAudioDone.has(_bookListenId)) return; // already recorded
      const bookId = _bookListenId;
      const { error } = await _sb.from('prep_book_audio_progress')
        .upsert({ user_id: currentUser.id, book_id: bookId, completed_at: new Date().toISOString() },
                { onConflict: 'user_id,book_id' });
      if(!error){
        _bookAudioDone.add(bookId);
        buildBooksPage();   // unlock the next book
      }
    });
  }

  // Full audiobook player: free seek, just remember the spot.
  const ab = document.getElementById('book-audiobook-player');
  if(ab){
    ab.addEventListener('timeupdate', () => {
      const now = Date.now();
      if(now - _lastAudioPosSave > 3000){ _lastAudioPosSave = now; _saveAudioPos('audiobook', _bookAudiobookId, ab.currentTime); }
    });
    ab.addEventListener('pause', () => _saveAudioPos('audiobook', _bookAudiobookId, ab.currentTime));
    ab.addEventListener('ended', () => _clearAudioPos('audiobook', _bookAudiobookId));
  }

  // iOS swipe-away / backgrounding: persist the live position before we lose it.
  const saveActive = () => {
    if(player && !player.paused) _saveAudioPos('overview', _bookListenId, player.currentTime);
    if(ab && !ab.paused) _saveAudioPos('audiobook', _bookAudiobookId, ab.currentTime);
  };
  window.addEventListener('pagehide', saveActive);
  document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'hidden') saveActive(); });
});

// ═════════════════════════ LIBRARY ═════════════════════════
let _libData = null;
let _libTab = 'literature';   // active Vault section: 'literature' | 'video' | 'audio'
let _libMediaByTitle = {};   // lowercased curated title -> media[], merged into live results
let _libSearchTimer = null;
let _libSearchSeq = 0;       // guards against out-of-order async responses
let _libAllTitles = null;    // full wiki title list (loaded live, cached for the session)
let _libTitlesLoading = false;
const _WIKI_API = 'https://preparingyou.com/wiki/api.php';

// Pull every article title from the wiki (paginated, live). Gives true
// title-substring search across all ~7,800 articles. Cached in localStorage
// for 12h so repeat visits search instantly; refreshed live once stale.
// Until a load finishes, search falls back to the wiki's prefix endpoint.
const _LIB_CACHE_KEY = 'pp_lib_titles_v1';
const _LIB_CACHE_TTL = 12 * 60 * 60 * 1000;   // 12 hours

async function _loadAllWikiTitles(){
  if(_libAllTitles || _libTitlesLoading) return;
  // 1) Serve from a fresh localStorage cache if we have one.
  try {
    const raw = localStorage.getItem(_LIB_CACHE_KEY);
    if(raw){
      const c = JSON.parse(raw);
      if(c && Array.isArray(c.titles) && (Date.now() - c.t) < _LIB_CACHE_TTL){
        _libAllTitles = c.titles;
        return;
      }
    }
  } catch(e){}
  // 2) Otherwise fetch the full list live and cache it.
  _libTitlesLoading = true;
  const all = [];
  let cont = '';
  try {
    for(let i = 0; i < 50; i++){   // safety cap; ~16 pages expected
      const u = _WIKI_API + '?action=query&list=allpages&apnamespace=0'
              + '&apfilterredir=nonredirects&aplimit=500&format=json&origin=*'
              + (cont ? '&apcontinue=' + encodeURIComponent(cont) : '');
      const r = await fetch(u);
      const j = await r.json();
      (j.query && j.query.allpages || []).forEach(p => all.push(p.title));
      if(j.continue && j.continue.apcontinue) cont = j.continue.apcontinue;
      else break;
    }
    _libAllTitles = all;
    try { localStorage.setItem(_LIB_CACHE_KEY, JSON.stringify({ t: Date.now(), titles: all })); } catch(e){}
  } catch(e){
    _libAllTitles = null;   // stay null so search keeps using the live fallback
  } finally {
    _libTitlesLoading = false;
  }
}

async function buildLibraryPage(){
  // Locked until the user is paired with a PCM (same gate as the Five Books).
  if(_gateJourneyPage('page-library', 'library-content', 3)) return;
  if(!_libData){
    try {
      const r = await fetch('/library.json');
      _libData = await r.json();
    } catch(e){
      document.getElementById('lib-content').innerHTML =
        '<div class="empty">Could not load the library. Try again later.</div>';
      return;
    }
  }
  // Map curated titles -> their video links, so live search results can show
  // the same media when a wiki article matches a curated topic.
  _libMediaByTitle = {};
  _libData.forEach(s => s.topics.forEach(t => {
    if(t.media && t.media.length) _libMediaByTitle[t.title.trim().toLowerCase()] = t.media;
  }));
  setLibTab(_libTab);     // renders the active section + its letter bar
  _loadAllWikiTitles();   // warm the full-article index in the background
}

// Classify a media link into the Vault's three sections by its label/URL.
// Audio = X-SPACE recordings / .mp3 files; Video = labelled VIDEO* or YouTube.
function _classifyMedia(m){
  const label = (m.label || '').toUpperCase();
  const href = (m.href || '').toLowerCase();
  if(label.indexOf('X-SPACE') >= 0 || href.endsWith('.mp3') || href.indexOf('/audio/') >= 0) return 'audio';
  if(label.indexOf('VIDEO') === 0 || href.indexOf('youtube.com') >= 0 || href.indexOf('youtu.be') >= 0) return 'video';
  return 'other';
}

// A–Z sections for one media type: each topic keeps only that type's media,
// and topics/sections with none are dropped.
function _libSectionsByType(type){
  return (_libData || []).map(s => ({
    letter: s.letter,
    topics: (s.topics || []).map(t => {
      const media = (t.media || []).filter(m => _classifyMedia(m) === type);
      return media.length ? { title: t.title, href: t.href, media } : null;
    }).filter(Boolean)
  })).filter(s => s.topics.length);
}

// Sections backing the active tab. Literature = every article (no media chips);
// Video/Audio = only topics carrying that media type.
function _libCurrentSections(){
  if(_libTab === 'video') return _libSectionsByType('video');
  if(_libTab === 'audio') return _libSectionsByType('audio');
  return _libData || [];
}

function _renderLibSections(data, showMedia){
  let html = '';
  data.forEach(section => {
    if(!section.topics.length) return;
    html += '<div class="lib-section" id="lib-letter-' + section.letter + '">'
         +    '<div class="lib-section-hdr">' + _esc(section.letter) + '</div>';
    section.topics.forEach(t => {
      html += '<div class="lib-topic">'
           +    '<a class="lib-topic-title" href="' + _esc(t.href) + '" target="_blank" rel="noopener">' + _esc(t.title) + '</a>';
      if(showMedia && t.media && t.media.length){
        html += '<div class="lib-media">'
             +    t.media.map(m =>
                    '<a href="' + _esc(m.href) + '" target="_blank" rel="noopener">' + _esc(m.label) + '</a>'
                  ).join('')
             + '</div>';
      }
      html += '</div>';
    });
    html += '</div>';
  });
  return html;
}

function _renderLetterBar(sections){
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const has = {};
  sections.forEach(s => has[(s.letter || '').toUpperCase()] = true);
  const bar = document.getElementById('lib-letter-bar');
  if(!bar) return;
  bar.innerHTML = letters.map(L =>
    has[L]
      ? '<button class="lib-letter" onclick="scrollToLetter(\'' + L + '\')">' + L + '</button>'
      : '<button class="lib-letter disabled" disabled>' + L + '</button>'
  ).join('');
}

function _libEmptyMsg(){
  if(_libTab === 'video') return '<div class="empty"><span class="ico"><svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block"><rect x="2" y="2" width="20" height="20" rx="2"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg></span>No videos yet.</div>';
  if(_libTab === 'audio') return '<div class="empty"><span class="ico"><svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg></span>No audio yet.</div>';
  return '<div class="empty">No topics match.</div>';
}

// Featured channel at the top of the Video tab: His Holy Church's full YouTube
// uploads as an embedded playlist (channel UC… -> uploads playlist UU…). Plays
// through every video and auto-includes new uploads; no API key needed.
const _LIB_YT_UPLOADS = 'UU4sm3fMaH46-oNQm0cLTfWw';  // His Holy Church uploads
// Permanent home for the three introduction videos in the Vault's Video tab,
// so they remain re-watchable long after the onboarding tile has moved on.
function _introVideosCard(){
  const rows = GATEWAY_VIDEOS.map(v =>
    '<div onclick="openIntroVideo(' + v.idx + ')" style="display:flex;align-items:center;gap:12px;padding:10px 2px;cursor:pointer;border-top:1px solid var(--line)">'
    + '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent-ink);flex:none"><polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none"/></svg>'
    + '<div style="flex:1"><div style="font-weight:600">' + _esc(v.title) + '</div>'
    +   '<div style="font-size:12px;color:var(--walnut-mid);font-style:italic">' + _esc(v.subtitle) + '</div></div>'
    + '</div>'
  ).join('');
  return '<div class="card">'
    + '<div class="card-title">Introduction Videos</div>'
    + '<div class="card-text" style="margin-bottom:4px">The three videos that begin your preparation — re-watch any of them here, anytime.</div>'
    + rows
    + '</div>';
}
function _libVideoFeature(){
  return _introVideosCard() + '<div class="card">'
    + '<div class="card-title">His Holy Church — video channel</div>'
    + '<div class="card-text" style="margin-bottom:12px">The full teaching channel. Press play to watch through every video; new uploads appear automatically.</div>'
    + '<div class="lib-yt-wrap">'
    +   '<iframe title="His Holy Church videos" loading="lazy" '
    +     'src="https://www.youtube-nocookie.com/embed/videoseries?list=' + _LIB_YT_UPLOADS + '&rel=0" '
    +     'allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" '
    +     'allowfullscreen></iframe>'
    + '</div>'
    + '</div>';
}

// Featured podcast at the top of the Audio tab: Spotify's official show embed.
// Lists every episode with inline playback and auto-includes new episodes.
const _LIB_PODCAST_SHOW = '0OyQtDzeMmzlIu48dGWsVE';  // Keys of the Kingdom — His Holy Church
function _libAudioFeature(){
  return '<div class="card">'
    + '<div class="card-title">Keys of the Kingdom</div>'
    + '<div class="card-text" style="margin-bottom:12px">Brother Gregory’s radio program from His Holy Church. Every episode plays here, and new ones appear automatically.</div>'
    + '<iframe class="lib-spotify" title="Keys of the Kingdom podcast" loading="lazy" height="420" '
    +   'src="https://open.spotify.com/embed/show/' + _LIB_PODCAST_SHOW + '?theme=0" '
    +   'allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" '
    +   'allowfullscreen></iframe>'
    + '</div>';
}

// Switch sections. Updates the active pill + search placeholder, then re-renders
// (honouring whatever is currently typed in the search box).
function setLibTab(tab){
  _libTab = tab;
  ['literature', 'video', 'audio'].forEach(t => {
    const b = document.getElementById('lib-tab-' + t);
    if(b) b.classList.toggle('active', t === tab);
  });
  const box = document.getElementById('lib-search');
  if(box) box.placeholder = 'Search…';
  // Featured players: populate once each, then just toggle visibility — so the
  // YouTube/Spotify iframes are never torn down or reloaded between tabs.
  const feat = document.getElementById('lib-feature');
  const fv = document.getElementById('lib-feat-video');
  const fa = document.getElementById('lib-feat-audio');
  if(feat){
    if(tab === 'video'){
      if(fv && !fv.dataset.loaded){ fv.innerHTML = _libVideoFeature(); fv.dataset.loaded = '1'; }
      if(fv) fv.style.display = '';
      if(fa) fa.style.display = 'none';
      feat.style.display = '';
    } else if(tab === 'audio'){
      if(fa && !fa.dataset.loaded){ fa.innerHTML = _libAudioFeature(); fa.dataset.loaded = '1'; }
      if(fa) fa.style.display = '';
      if(fv) fv.style.display = 'none';
      feat.style.display = '';
    } else {
      feat.style.display = 'none';
    }
  }
  renderLibTab();
}

// Central render: reads the active tab + the search box and paints lib-content.
function renderLibTab(){
  if(!_libData) return;
  const box = document.getElementById('lib-search');
  const q = ((box && box.value) || '').trim();
  const sections = _libCurrentSections();
  const showMedia = (_libTab !== 'literature');
  const bar = document.getElementById('lib-letter-bar');
  const content = document.getElementById('lib-content');
  _renderLetterBar(sections);
  // On Audio the podcast embed is the focus and the curated list is short, so
  // the A–Z jumper just adds clutter — keep it for Literature/Video only.
  const useBar = (_libTab !== 'audio');
  // Video/Audio tabs label their curated topical lists below the featured player.
  const subhead = (_libTab === 'audio') ? '<div class="lib-subhead">Topical recordings</div>'
                : (_libTab === 'video') ? '<div class="lib-subhead">Topical videos</div>' : '';

  if(!q){
    if(bar) bar.style.display = useBar ? '' : 'none';
    const body = _renderLibSections(sections, showMedia);
    content.innerHTML = body ? (subhead + body) : (_libTab === 'audio' ? '' : _libEmptyMsg());
    return;
  }
  if(bar) bar.style.display = 'none';   // letter bar is irrelevant during search
  if(_libTab === 'literature'){
    // Literature searches the whole wiki (~7,800 articles).
    const seq = ++_libSearchSeq;
    if(_libSearchTimer){ clearTimeout(_libSearchTimer); }
    content.innerHTML = '<div class="empty"><span class="ico"><svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></span>Searching all of preparingyou.com…</div>';
    _libSearchTimer = setTimeout(() => runLibrarySearch(q, seq), 250);
    return;
  }
  // Video/Audio: local title filter within the curated set.
  const ql = q.toLowerCase();
  const filtered = sections.map(s => ({
    letter: s.letter,
    topics: s.topics.filter(t => (t.title || '').toLowerCase().indexOf(ql) >= 0)
  })).filter(s => s.topics.length);
  const filteredBody = _renderLibSections(filtered, showMedia);
  content.innerHTML = filteredBody
    ? (subhead + filteredBody)
    : ('<div class="empty"><span class="ico"><svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg></span>No ' + _libTab + ' found for “' + _esc(q) + '”.</div>');
}

// Back-compat alias: a few callers still say renderLibrary().
function renderLibrary(){ renderLibTab(); }

function scrollToLetter(L){
  const el = document.getElementById('lib-letter-' + L);
  if(el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Search now spans the FULL preparingyou.com wiki (~7,000+ articles), not just
// the curated list. Typing queries the wiki's title search (opensearch) live;
// clearing the box restores the curated A–Z view.
// Search box input: the active tab decides what to do (whole-wiki search on
// Literature; local title filter on Video/Audio). renderLibTab() reads the box.
function filterLibrary(_q){
  if(_libSearchTimer){ clearTimeout(_libSearchTimer); _libSearchTimer = null; }
  renderLibTab();
}

const _LIB_CAP = 60;   // max rows rendered at once

async function runLibrarySearch(q, seq){
  if(_libAllTitles){
    // Full index ready: instant title-substring match across every article.
    const ql = q.toLowerCase();
    const matches = _libAllTitles.filter(t => t.toLowerCase().includes(ql));
    // Prefix matches first, then the rest, each alphabetical.
    matches.sort((a, b) => {
      const ap = a.toLowerCase().startsWith(ql), bp = b.toLowerCase().startsWith(ql);
      if(ap !== bp) return ap ? -1 : 1;
      return a.localeCompare(b);
    });
    if(seq !== _libSearchSeq) return;
    renderSearchResults(q, matches.slice(0, _LIB_CAP).map(_wikiTitleToEntry), matches.length);
    return;
  }
  // Index still warming: use the wiki's live prefix search for now.
  _loadAllWikiTitles();
  const url = _WIKI_API + '?action=opensearch&format=json&namespace=0&limit=' + _LIB_CAP
            + '&search=' + encodeURIComponent(q) + '&origin=*';
  let titles = [], urls = [];
  try {
    const r = await fetch(url);
    const j = await r.json();      // [query, [titles], [descs], [urls]]
    titles = j[1] || []; urls = j[3] || [];
  } catch(e){
    if(seq === _libSearchSeq){
      document.getElementById('lib-content').innerHTML =
        '<div class="empty"><span class="ico"><svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>Couldn’t reach the library right now. Check your connection and try again.</div>';
    }
    return;
  }
  if(seq !== _libSearchSeq) return;  // a newer keystroke superseded this one
  renderSearchResults(q, titles.map((t, i) => ({ title: t, href: urls[i] })), titles.length);
}

function _wikiTitleToEntry(title){
  return { title, href: 'https://preparingyou.com/wiki/' + encodeURIComponent(title.replace(/ /g, '_')) };
}

function renderSearchResults(q, entries, total){
  const el = document.getElementById('lib-content');
  if(!entries.length){
    el.innerHTML = '<div class="empty"><span class="ico"><svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg></span>No articles found for “' + _esc(q) + '”.</div>';
    return;
  }
  let html = '<div class="lib-section">'
           + '<div class="lib-section-hdr" style="text-transform:none">'
           +   total + ' article' + (total === 1 ? '' : 's') + ' matching “' + _esc(q) + '”'
           + '</div>';
  entries.forEach(e => {
    const href = e.href || ('https://preparingyou.com/wiki/' + encodeURIComponent(e.title.replace(/ /g, '_')));
    const media = _libMediaByTitle[e.title.trim().toLowerCase()];
    html += '<div class="lib-topic">'
         +    '<a class="lib-topic-title" href="' + _esc(href) + '" target="_blank" rel="noopener">' + _esc(e.title) + '</a>';
    if(media && media.length){
      html += '<div class="lib-media">'
           +    media.map(m => '<a href="' + _esc(m.href) + '" target="_blank" rel="noopener">' + _esc(m.label) + '</a>').join('')
           + '</div>';
    }
    html += '</div>';
  });
  if(total > entries.length){
    html += '<div class="empty" style="padding:14px">Showing the first ' + entries.length
         +  ' — keep typing to narrow your search.</div>';
  }
  html += '</div>';
  el.innerHTML = html;
}

// ═════════════════════════ PCM FLOW ═════════════════════════
let _pcmAmIPcm = false;
let _pcmList = [];

async function buildPcmPage(){
  if(!_sb || !currentUser) return;

  // 1. Refresh my own profile (so we have latest pcm_id)
  const { data: me } = await _sb.from('prep_users').select('*').eq('id', currentUser.id).maybeSingle();
  if(me) currentUser = Object.assign(currentUser, me);

  // Gate: can't choose a PCM until the three introduction videos are done.
  if(_gateJourneyPage('page-pcm', 'pcm-content', 2)) return;

  // 2. Am I myself a PCM? — fetch this and the active-PCM roster together,
  //    since the two queries are independent (parallel, not a waterfall).
  const [myPcmRes, rowsRes] = await Promise.all([
    _sb.from('prep_pcms').select('*').eq('id', currentUser.id).maybeSingle(),
    _sb.from('prep_pcms').select('id, name, email, phone, telegram, messenger, region, active').eq('active', true),
  ]);
  const myPcm = myPcmRes.data;
  _pcmAmIPcm = !!(myPcm && myPcm.active);
  const mineCard = document.getElementById('pcm-mine');
  const volBtn   = document.getElementById('pcm-volunteer-btn');
  if(_pcmAmIPcm){
    mineCard.style.display = 'block';
    volBtn.textContent = 'Edit my PCM details';
    document.getElementById('pcm-mine-body').innerHTML =
      '<div style="font-size:13px;color:var(--walnut);line-height:1.7">'
      + (myPcm.region ? '<div><strong>Region:</strong> ' + _esc(myPcm.region) + '</div>' : '')
      + (myPcm.email ? '<div><strong>Email:</strong> ' + _esc(myPcm.email) + '</div>' : '')
      + (myPcm.phone ? '<div><strong>Phone:</strong> ' + _esc(myPcm.phone) + '</div>' : '')
      + (myPcm.telegram ? '<div><strong>Telegram:</strong> ' + _esc(myPcm.telegram) + '</div>' : '')
      + (myPcm.messenger ? '<div><strong>Messenger:</strong> ' + _esc(myPcm.messenger) + '</div>' : '')
      + '</div>';
  } else {
    mineCard.style.display = 'none';
    volBtn.textContent = '+ Volunteer as PCM';
  }
  // Only actual congregants of The Living Network — an Overseer-sealed
  // Declaration of Sacred Purpose — may volunteer as a PCM (existing PCMs
  // keep their edit button). Verified against TLN itself via tlnIsSealedMember.
  volBtn.style.display = _pcmAmIPcm ? '' : 'none';
  if(!_pcmAmIPcm){
    tlnIsSealedMember().then(function(sealed){
      if(sealed) volBtn.style.display = '';
    });
  }

  // 3. Active-PCM roster (already fetched above in parallel) — partition by region
  const rows = rowsRes.data;
  _pcmList = (rows || []).filter(p => p.id !== currentUser.id);  // exclude self
  // Profile photos live on prep_users — backfill avatar_url onto each PCM.
  if(_pcmList.length){
    const { data: avs } = await _sb.from('prep_users')
      .select('id, avatar_url').in('id', _pcmList.map(p => p.id));
    const avMap = new Map((avs || []).map(r => [r.id, r.avatar_url]));
    _pcmList.forEach(p => { p.avatar_url = avMap.get(p.id) || null; });
  }
  // Tag matched-vs-available status (only needed when a PCM browses peers).
  if(_pcmAmIPcm && _pcmList.length){
    const { data: matchedRows } = await _sb.from('prep_users').select('pcm_id').not('pcm_id', 'is', null);
    const matched = new Set((matchedRows || []).map(r => r.pcm_id));
    _pcmList.forEach(p => { p._matched = matched.has(p.id); });
  }
  const myCountry = _regionCountry(currentUser.region || '').toLowerCase();
  const inRegion = _pcmList.filter(p => myCountry && _regionCountry(p.region || '').toLowerCase() === myCountry);
  const outOfRegion = _pcmList.filter(p => !(myCountry && _regionCountry(p.region || '').toLowerCase() === myCountry));

  // 4. Render the list
  const listEl = document.getElementById('pcm-list');
  if(!_pcmList.length){
    listEl.innerHTML = '<div class="empty"><span class="ico"><svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></span>No Personal Contact Ministers are available yet. Please check back soon.</div>';
  } else {
    let html = '';
    if(myCountry && inRegion.length){
      html += '<div style="font-size:11px;color:var(--walnut-mid);font-style:italic;margin:6px 4px 4px">In your country (' + _esc(_regionCountry(currentUser.region)) + ')</div>';
      html += inRegion.map(p => _pcmRow(p)).join('');
    }
    if(outOfRegion.length){
      html += '<div style="font-size:11px;color:var(--walnut-mid);font-style:italic;margin:14px 4px 4px">' + (myCountry ? 'Other countries' : 'All available') + '</div>';
      html += outOfRegion.map(p => _pcmRow(p)).join('');
    }
    listEl.innerHTML = html;
  }

  // 5. If a PCM is already chosen, show the "Your PCM" card
  if(currentUser.pcm_id){
    const chosen = _pcmList.find(p => p.id === currentUser.pcm_id);
    if(chosen){
      const card = document.getElementById('pcm-current');
      card.style.display = 'block';
      document.getElementById('pcm-current-body').innerHTML =
        '<div style="display:flex;align-items:center;gap:12px;margin-top:6px">'
        + '<div class="pcm-av">' + _avInner(chosen) + '</div>'
        + '<div style="flex:1">'
        +   '<div class="pcm-name">' + _esc(chosen.name) + '</div>'
        +   (chosen.region ? '<div class="pcm-meta">' + _esc(chosen.region) + '</div>' : '')
        +   _pcmChannelLines(chosen)
        + '</div>'
        + '</div>'
        + '<div style="text-align:right;margin-top:10px;display:flex;gap:8px;justify-content:flex-end">'
        + '<button class="link-btn" onclick="messagePcm(\'' + chosen.id + '\')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>Message</button>'
        + '<button class="link-btn" onclick="startPcmCall()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>Call</button>'
        + '<button class="link-btn" onclick="changePcm()">Change</button>'
        + '</div>';
    }
  } else {
    document.getElementById('pcm-current').style.display = 'none';
  }

  // 6. Pending outbound election (elector waiting for PCM response)
  const pendingCard = document.getElementById('pcm-pending');
  if(pendingCard){
    const { data: out } = await _sb.from('prep_pcm_elections')
      .select('*, pcm:pcm_id(name, region)').eq('elector_id', currentUser.id)
      .eq('status', 'pending').maybeSingle();
    if(out){
      pendingCard.style.display = 'block';
      // The embedded pcm:pcm_id join reads prep_users, which RLS hides for other
      // members, so out.pcm?.name comes back null. Resolve the name from the
      // already-loaded active-PCM directory (_pcmList) instead.
      const _pend = _pcmList.find(p => p.id === out.pcm_id);
      pendingCard.querySelector('[data-pending-name]').textContent =
        (_pend && _pend.name) || out.pcm?.name || '—';
    } else {
      pendingCard.style.display = 'none';
    }
  }

  // 7. Inbound elections (where I am the PCM and someone has elected me)
  const inboundCard = document.getElementById('pcm-inbound');
  if(inboundCard && _pcmAmIPcm){
    const { data: inbound } = await _sb.from('prep_pcm_elections')
      .select('id, elector_id, elected_at, elector:elector_id(name, email, region, avatar_url)')
      .eq('pcm_id', currentUser.id).eq('status', 'pending').order('elected_at');
    _inboundElections = inbound || [];
    if((inbound || []).length){
      inboundCard.style.display = 'block';
      inboundCard.querySelector('[data-inbound-list]').innerHTML = inbound.map(e =>
        '<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)">'
        + '<div class="pcm-av">' + _avInner(e.elector) + '</div>'
        + '<div style="flex:1">'
        +   '<div class="pcm-name">' + _esc(e.elector?.name || 'Unknown') + '</div>'
        +   (e.elector?.region ? '<div class="pcm-meta">' + _esc(e.elector.region) + '</div>' : '')
        + '</div>'
        + '<button class="pcm-pick" style="background:#2d7a4f;color:#fff" onclick="pcmRespondElection(' + e.id + ', true)">Accept</button>'
        + '<button class="link-btn" style="margin-left:6px" onclick="pcmRespondElection(' + e.id + ', false)">Decline</button>'
        + '</div>'
      ).join('');
    } else {
      inboundCard.style.display = 'none';
    }
  } else if(inboundCard){
    inboundCard.style.display = 'none';
  }

  // 8. Accepted electors (PCM can sign them off into TLN)
  const electorsCard = document.getElementById('pcm-electors');
  if(electorsCard && _pcmAmIPcm){
    const { data: accepted } = await _sb.from('prep_pcm_elections')
      .select('id, elector_id, responded_at, elector:elector_id(name, email, region, tln_invited_at, avatar_url)')
      .eq('pcm_id', currentUser.id).eq('status', 'accepted').order('responded_at', { ascending:false });
    _acceptedElectors = accepted || [];
    if((accepted || []).length){
      // A PCM can't read electors' book progress directly (RLS), so the server
      // tells us which electors have finished all Books — the sign-off button
      // only appears for those who have.
      let _ready = {};
      try {
        const _rr = await fetch(_SERVER_URL + '/pcm/electors/readiness', {
          method:'POST', headers: await _authHeaders(), body: '{}'
        });
        if(_rr.ok){ const _jj = await _rr.json(); _ready = _jj.readiness || {}; }
      } catch(_){}
      electorsCard.style.display = 'block';
      electorsCard.querySelector('[data-electors-list]').innerHTML = accepted.map(e => {
        const invited = !!e.elector?.tln_invited_at;
        const ready = !!_ready[e.elector_id];
        return '<div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;padding:10px 0;border-bottom:1px solid var(--line)">'
          + '<div class="pcm-av">' + _avInner(e.elector) + '</div>'
          + '<div style="flex:1;min-width:0">'
          +   '<div class="pcm-name">' + _esc(e.elector?.name || 'Unknown') + '</div>'
          +   (e.elector?.region ? '<div class="pcm-meta">' + _esc(e.elector.region) + '</div>' : '')
          +   (invited ? '<div style="font-size:11px;color:var(--success);font-style:italic;margin-top:3px"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><polyline points="20 6 9 17 4 12"/></svg>TLN invited</div>' : '')
          + '</div>'
          + (invited
              ? '<span style="font-size:11px;color:var(--walnut-mid);font-style:italic">Already invited</span>'
              : ready
                ? '<button class="pcm-pick" style="background:var(--teal);color:#fff;flex:1 1 100%;white-space:normal" onclick="signoffToTln(\'' + e.elector_id + '\', \'' + _esc(e.elector?.name || '') + '\')">Sign off &amp; invite to TLN</button>'
                : '<span style="flex:1 1 100%;font-size:12px;color:var(--walnut-mid);font-style:italic">Still listening to the Five Books \u2014 you can sign them off once they\u2019ve finished.</span>')
          + (invited ? '' : '<button onclick="revokeElector(\'' + e.elector_id + '\')" style="flex:0 0 auto;margin-left:auto;font-size:12px;padding:6px 12px;background:transparent;border:1px solid var(--line);color:var(--walnut-mid);border-radius:8px;cursor:pointer;font-family:inherit">Revoke</button>')
          + '</div>';
      }).join('');
    } else {
      electorsCard.style.display = 'none';
    }
  } else if(electorsCard){
    electorsCard.style.display = 'none';
  }
}

let _acceptedElectors = [];

async function signoffToTln(electorId, electorName){
  if(!confirm('Sign off on '+(electorName||'this elector')+' and invite them into The Living Network? They will be emailed a signup link.')) return;
  const el = _acceptedElectors.find(x => x.elector_id === electorId);
  const electorEmail = el?.elector?.email;
  try {
    const r = await fetch(_SERVER_URL + '/tln/invite', {
      method:'POST', headers: await _authHeaders(),
      body: JSON.stringify({ userId: electorId, fromName: currentUser?.name || null, skipEmail: true })
    });
    const j = await r.json();
    if(!r.ok) throw new Error(j.error || 'invite failed');
    if(!j.ok){
      alert(j.reason === 'books_incomplete'
        ? (electorName || 'This member') + ' hasn\u2019t finished the Five Books yet. You can sign them off once they have.'
        : 'Could not send: ' + (j.reason || 'unknown'));
      buildPcmPage();
      return;
    }
    if(electorEmail){
      const handoff = 'https://livingnetwork.netlify.app/?'
        + 'from=preparingyou'
        + '&name=' + encodeURIComponent(electorName || '')
        + '&email=' + encodeURIComponent(electorEmail)
        + '&inviter=' + encodeURIComponent(currentUser?.name || '');
      sendEmail(electorName, electorEmail, 'You have been invited to The Living Network',
        (currentUser?.name || 'Your PCM')+' has signed off on your readiness and invites you to enter The Living Network.\n\nThe link below will take you straight to the Join screen with your details prefilled:\n\n'+handoff);
    }
    alert('Invitation sent. They will receive an email with a TLN signup link.');
    buildPcmPage();
  } catch(e){
    alert('Could not invite: ' + e.message);
  }
}

// PCM ends a pairing they previously accepted. Confirms, calls /pcm/revoke
// (which notifies the elector + frees them to choose again), then rebuilds the
// PCM page so the elector drops off the Your Electors list.
async function revokeElector(electorId){
  const el = _acceptedElectors.find(x => x.elector_id === electorId);
  const name = el?.elector?.name || 'this elector';
  if(!confirm('Revoke your acceptance of ' + name + ' as their Personal Contact Minister?\n\nThey will be notified and can choose another minister. (This does not remove anyone already signed off into The Living Network.)')) return;
  try {
    const r = await fetch(_SERVER_URL + '/pcm/revoke', {
      method:'POST', headers: await _authHeaders(),
      body: JSON.stringify({ electorId })
    });
    const j = await r.json();
    if(!r.ok) throw new Error(j.error || 'revoke failed');
    alert('Done — ' + name + ' has been notified and can now choose another minister.');
    buildPcmPage();
  } catch(e){
    alert('Could not revoke: ' + e.message);
  }
}

async function startPcmCall(){
  // Determine the peer: prefer the currently-selected message peer if any,
  // otherwise fall back to my PCM (if I'm an elector) or my first elector (if I'm a PCM).
  let peerId = _msgPeerId || currentUser?.pcm_id;
  if(!peerId){
    const { data: mine } = await _sb.from('prep_users').select('id').eq('pcm_id', currentUser.id).limit(1);
    if(mine && mine[0]) peerId = mine[0].id;
  }
  if(!peerId){ alert('No paired contact to call.'); return; }
  const roomName = await _pairRoomName(currentUser.id, peerId);
  try {
    const r = await fetch(_SERVER_URL + '/call/start', {
      method:'POST', headers: await _authHeaders(),
      body: JSON.stringify({ roomName, userName: currentUser.name || 'User', isOwner: false })
    });
    const j = await r.json();
    if(!r.ok) throw new Error(j.error || 'call failed');

    // Drop a system-style message so the other side sees the incoming call link.
    // The room URL is shared (j.roomUrl) — both sides hit /call/start independently
    // to mint their own per-user token, so we send the bare room URL, not j.url.
    const inviteUrl = j.roomUrl || j.url;
    // Route through the server so the invite body is encrypted at rest like
    // every other message (rather than a direct plaintext insert).
    await fetch(_SERVER_URL + '/messages/send', {
      method: 'POST',
      headers: await _authHeaders(),
      body: JSON.stringify({
        senderId: currentUser.id,
        recipientId: peerId,
        body: '📞 ' + (currentUser.name || 'Your contact') + ' is calling. Tap to join: ' + inviteUrl
      })
    });

    window.open(j.url, '_blank');
  } catch(e){
    alert('Could not start call: ' + e.message);
  }
}

function _pcmRow(p){
  const isChosen = currentUser.pcm_id === p.id;
  // An ESTABLISHED PCM (one who already has their own PCM) browses the directory
  // to connect with peers (message/call). Anyone still needing a PCM gets a
  // Choose button — including a PCM electing up the multiplication chain (e.g.
  // after they withdrew from their previous PCM). Conflating "is a PCM" with
  // "doesn't need to choose one" hid the button from such users.
  const isEstablishedPcm = _pcmAmIPcm && !!currentUser.pcm_id;
  const badge = _pcmAmIPcm
    ? '<span class="pcm-status ' + (p._matched ? 'matched' : 'available') + '">'
        + (p._matched ? 'Matched' : 'Available') + '</span>'
    : '';
  const actions = isEstablishedPcm
    ? '<div class="pcm-peer-actions">'
        + '<button class="link-btn" onclick="messagePcm(\'' + p.id + '\')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>Message</button>'
        + '<button class="link-btn" onclick="callPcm(\'' + p.id + '\')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>Call</button>'
      + '</div>'
    : '<button class="pcm-pick' + (isChosen ? ' chosen' : '') + '" onclick="choosePcm(\'' + p.id + '\')">'
        + (isChosen ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><polyline points="20 6 9 17 4 12"/></svg>Chosen' : 'Choose')
      + '</button>';
  return '<div class="pcm-row' + (isChosen ? ' chosen' : '') + '">'
    + '<div class="pcm-av">' + _avInner(p) + '</div>'
    + '<div class="pcm-info">'
    +   '<div class="pcm-name">' + _esc(p.name) + (badge ? ' ' + badge : '') + '</div>'
    +   (p.region ? '<div class="pcm-meta">' + _esc(p.region) + '</div>' : '')
    +   _pcmChannelLines(p)
    + '</div>'
    + actions
    + '</div>';
}

// PCM-to-PCM connect helpers: set the active message peer, then reuse the
// existing thread UI / Daily.co call rail.
function messagePcm(id){ _msgOpenPeer = id; showPage('messages'); }
function callPcm(id){ _msgPeerId = id; startPcmCall(); }

function _pcmChannelLines(p){
  const parts = [];
  if(p.email)    parts.push('<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:5px"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22 6 12 13 2 6"/></svg>' + _esc(p.email));
  if(p.phone)    parts.push('<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:5px"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>' + _esc(p.phone));
  if(p.telegram) parts.push('Tg ' + _esc(p.telegram));
  if(p.messenger)parts.push('M ' + _esc(p.messenger));
  return parts.length ? '<div class="pcm-channels">' + parts.join('   ·   ') + '</div>' : '';
}

function _initials(s){
  return (s||'?').split(' ').map(w=>w[0]||'').join('').slice(0,2).toUpperCase();
}
// Inner HTML for a round .pcm-av bubble: a cover-fit profile photo when the
// member has an avatar_url, otherwise their initials on the brand fill.
function _avInner(u){
  const url = u && u.avatar_url;
  if(url) return '<img src="' + _esc(url) + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block">';
  return _initials(u ? u.name : '');
}
function _esc(s){
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/`/g,'&#96;');
}

// Elect (replaces direct pick): creates pending election, emails the PCM.
async function choosePcm(pcmId){
  if(!_sb || !currentUser) return;
  // Block if elector already has pending or accepted election
  const { data: existing } = await _sb.from('prep_pcm_elections')
    .select('id, status').eq('elector_id', currentUser.id).in('status', ['pending','accepted']).maybeSingle();
  if(existing){
    alert(existing.status === 'pending'
      ? 'You already have a choice awaiting response. Please wait or withdraw it.'
      : 'You already have an accepted PCM. Withdraw the current pairing first.');
    return;
  }
  try {
    const r = await fetch(_SERVER_URL + '/elect', {
      method:'POST', headers: await _authHeaders(),
      body: JSON.stringify({ electorId: currentUser.id, pcmId, skipEmail: true })
    });
    const j = await r.json();
    if(!r.ok){
      if(j.error === 'gateway_incomplete'){
        alert('Please finish the three introduction videos before choosing a Personal Contact Minister.');
        showPage('video');
        return;
      }
      throw new Error(j.error || 'request failed');
    }
    // Client-side emails via EmailJS
    const pcm = _pcmList.find(p => p.id === pcmId);
    if(pcm?.email){
      sendEmail(pcm.name, pcm.email, 'You have been chosen as a Personal Contact Minister',
        (currentUser.name||'A user')+' has chosen you as their Personal Contact Minister. Open the app to accept or decline:\n\nhttps://preparingyou.app');
    }
    if(currentUser.email){
      sendEmail(currentUser.name, currentUser.email, 'Your choice has been sent',
        'You have chosen '+(pcm?.name||'a PCM')+'. They have been emailed and will respond shortly. We will email you again once they accept or decline.\n\nhttps://preparingyou.app');
    }
    alert('Your choice has been sent. Your PCM has been emailed and will accept or decline shortly.');
    buildPcmPage();
  } catch(e){
    alert('Could not send your choice: ' + e.message);
  }
}

// Send a gentle reminder email to the elected PCM who hasn't responded yet.
// A short client-side cooldown prevents accidental repeat taps.
let _nudgeCooldownUntil = 0;
async function nudgePcm(){
  if(!_sb || !currentUser) return;
  const btn = document.getElementById('pcm-nudge-btn');
  if(Date.now() < _nudgeCooldownUntil){
    if(btn){ const o=btn.textContent; btn.textContent='Already sent'; setTimeout(()=>{ btn.textContent=o; }, 1800); }
    return;
  }
  if(btn){ btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    const r = await fetch(_SERVER_URL + '/pcm/nudge', {
      method:'POST', headers: await _authHeaders(),
      body: JSON.stringify({ electorId: currentUser.id })
    });
    const j = await r.json().catch(()=>({}));
    if(!r.ok || j.ok === false) throw new Error(j.error || 'nudge failed');
    _nudgeCooldownUntil = Date.now() + 60000; // 1-minute cooldown
    if(btn){ btn.textContent = 'Reminder sent ✓'; setTimeout(()=>{ btn.textContent='Nudge'; btn.disabled=false; }, 4000); }
  } catch(e){
    if(btn){ btn.textContent='Nudge'; btn.disabled=false; }
    alert('Could not send the reminder: ' + e.message);
  }
}

async function changePcm(){
  if(!_sb || !currentUser) return;
  if(!confirm('Withdraw current PCM pairing and choose a different one?')) return;
  // Withdraw server-side so the PCM is notified by email + in-app. The server
  // marks the election withdrawn and clears pcm_id; we fall back to direct
  // Supabase writes if the server is unreachable so the withdrawal still works.
  let done = false;
  try{
    const r = await fetch(_SERVER_URL + '/pcm/withdraw', {
      method: 'POST',
      headers: await _authHeaders(),
      body: JSON.stringify({ electorId: currentUser.id })
    });
    done = r.ok;
  }catch(e){ done = false; }
  if(!done){
    await _sb.from('prep_pcm_elections')
      .update({ status: 'withdrawn', responded_at: new Date().toISOString() })
      .eq('elector_id', currentUser.id).in('status', ['pending','accepted']);
    await _sb.from('prep_users').update({ pcm_id: null }).eq('id', currentUser.id);
  }
  currentUser.pcm_id = null;
  buildPcmPage();
}

let _inboundElections = [];

async function pcmRespondElection(electionId, accept){
  if(!_sb || !currentUser) return;
  if(!accept && !confirm('Decline this request? The user will be told you are currently unavailable.')) return;
  // Capture elector details before the row goes away
  const el = _inboundElections.find(x => x.id === electionId);
  const electorEmail = el?.elector?.email;
  const electorName = el?.elector?.name;
  try {
    const r = await fetch(_SERVER_URL + '/election/respond', {
      method:'POST', headers: await _authHeaders(),
      body: JSON.stringify({ electionId, pcmId: currentUser.id, accept, skipEmail: true })
    });
    const j = await r.json();
    if(!r.ok) throw new Error(j.error || 'response failed');
    // Client-side email to elector
    if(electorEmail){
      if(accept){
        sendEmail(electorName, electorEmail, 'Your PCM accepted your choice',
          (currentUser.name||'Your PCM')+' has accepted your choice. They will walk this preparation alongside you. You can now message them or schedule a call from inside the app.\n\nhttps://preparingyou.app');
      } else {
        sendEmail(electorName, electorEmail, 'Your PCM is currently unavailable',
          (currentUser.name||'Your PCM')+' is unavailable at this time. Please choose another Personal Contact Minister from the list.\n\nhttps://preparingyou.app');
      }
    }
    // PCM auto-invited to TLN on their first accepted election
    if(j.pcmAutoInvited && j.pcmEmail){
      const handoff = 'https://livingnetwork.netlify.app/?'
        + 'from=preparingyou'
        + '&name=' + encodeURIComponent(j.pcmName || '')
        + '&email=' + encodeURIComponent(j.pcmEmail)
        + '&inviter=' + encodeURIComponent(j.electorName || '');
      sendEmail(j.pcmName, j.pcmEmail, 'You have been invited to The Living Network',
        'You have been chosen by '+(j.electorName||'someone')+' as their Personal Contact Minister. The act of being chosen is itself the qualifying event — you are now invited to enter The Living Network.\n\nThe link below will take you straight to the Join screen with your details prefilled:\n\n'+handoff);
    }
    buildPcmPage();
  } catch(e){
    alert('Could not respond: ' + e.message);
  }
}

function openPcmVolunteer(){
  // PCM covenant gate: a first-time volunteer must accept the covenant of
  // service before the contact form opens. Existing PCMs (editing their
  // details) and anyone who already accepted pass straight through.
  if(!_pcmAmIPcm && currentUser && !currentUser.pcm_guidelines_accepted_at){
    const g = document.getElementById('pcm-agree-err'); if(g) g.style.display='none';
    document.getElementById('pcm-agree-gate').style.display = 'flex';
    return;
  }
  // Pre-fill from existing record (if any) or from currentUser defaults
  const m = document.getElementById('pcm-modal');
  _fillCountrySelect(document.getElementById('pcm-country'), _regionCountry(currentUser.region || ''));
  document.getElementById('pcm-state').value = _regionState(currentUser.region || '');
  document.getElementById('pcm-email').value  = currentUser.email || '';
  document.getElementById('pcm-phone').value = '';
  document.getElementById('pcm-telegram').value = '';
  document.getElementById('pcm-messenger').value = '';
  // If already a PCM, hydrate with current values
  if(_sb && _pcmAmIPcm){
    _sb.from('prep_pcms').select('*').eq('id', currentUser.id).maybeSingle().then(({data})=>{
      if(data){
        _fillCountrySelect(document.getElementById('pcm-country'), _regionCountry(data.region || ''));
        document.getElementById('pcm-state').value = _regionState(data.region || '');
        document.getElementById('pcm-email').value = data.email || '';
        document.getElementById('pcm-phone').value = data.phone || '';
        document.getElementById('pcm-telegram').value = data.telegram || '';
        document.getElementById('pcm-messenger').value = data.messenger || '';
      }
    });
    document.getElementById('pcm-stop-btn').style.display = 'block';
  } else {
    document.getElementById('pcm-stop-btn').style.display = 'none';
  }
  m.style.display = 'flex';
}

function closePcmVolunteer(){
  document.getElementById('pcm-modal').style.display = 'none';
}

// Stamp the one-time PCM covenant acceptance, then open the volunteer form.
// If the write fails we still proceed (the local flag lets them continue this
// session); the gate simply reappears next time so the record can be re-tried.
async function acceptPcmGuidelines(){
  const btn = document.getElementById('pcm-agree-btn');
  const err = document.getElementById('pcm-agree-err');
  if(err) err.style.display = 'none';
  if(btn){ btn.disabled = true; }
  const now = new Date().toISOString();
  let saved = false;
  try {
    if(_sb && currentUser){
      const { error } = await _sb.from('prep_users')
        .update({ pcm_guidelines_accepted_at: now }).eq('id', currentUser.id);
      if(!error) saved = true;
    }
  } catch(e){ saved = false; }
  if(btn){ btn.disabled = false; }
  if(!saved && _sb){ if(err) err.style.display = 'block'; return; }
  currentUser.pcm_guidelines_accepted_at = now;
  document.getElementById('pcm-agree-gate').style.display = 'none';
  openPcmVolunteer();
}

function closePcmAgree(){
  document.getElementById('pcm-agree-gate').style.display = 'none';
}

async function savePcmVolunteer(){
  if(!_sb || !currentUser) return;
  // Becoming a PCM is reserved for those granted access to The Living Network.
  if(!currentUser.tln_invited_at && !_pcmAmIPcm){
    alert('Becoming a Personal Contact Minister is available once you have been granted access to The Living Network.');
    return;
  }
  const region    = _composeRegion(document.getElementById('pcm-country').value.trim(), document.getElementById('pcm-state').value.trim());
  const email     = document.getElementById('pcm-email').value.trim().toLowerCase();
  const phone     = document.getElementById('pcm-phone').value.trim();
  const telegram  = document.getElementById('pcm-telegram').value.trim();
  const messenger = document.getElementById('pcm-messenger').value.trim();
  if(!email){ alert('Email is required.'); return; }
  const payload = {
    id: currentUser.id,
    name: currentUser.name,
    email, phone: phone || null, telegram: telegram || null, messenger: messenger || null,
    region: region || null, active: true
  };
  const { error } = await _sb.from('prep_pcms').upsert(payload, { onConflict: 'id' });
  if(error){ alert('Could not save: ' + error.message); return; }
  closePcmVolunteer();
  buildPcmPage();
}

async function stopBeingPcm(){
  if(!_sb || !currentUser) return;
  if(!confirm('Stop being available as a PCM? Existing applicants will no longer see you in the list.')) return;
  const { error } = await _sb.from('prep_pcms').update({ active: false }).eq('id', currentUser.id);
  if(error){ alert('Could not save: ' + error.message); return; }
  closePcmVolunteer();
  buildPcmPage();
}

// Set while the member is intentionally signing out, so the global SIGNED_OUT
// recovery handler below doesn't mistake a deliberate logout for a dropped session
// and kick off a competing reload.
let _signingOut = false;

async function signOut(){
  _signingOut = true;
  // Drop the push subscription so a logged-out phone stops getting alerts.
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch(_SERVER_URL + '/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint })
        }).catch(()=>{});
        await sub.unsubscribe().catch(()=>{});
      }
    }
  } catch(_) {}
  _setHomeScreenBadge(0);
  if(_sb) await _sb.auth.signOut().catch(()=>{});
  currentUser = null;
  // Reload the document so logging back in always lands on the latest deployed
  // version rather than the cached page this session launched with.
  window.location.reload();
}

// ═════════════════════════ INIT ═════════════════════════
window.addEventListener('load', async ()=>{
  if(!_sb) return;

  // Robust query-based recovery link: verify the one-time token to establish the
  // recovery session, then show the set-new-password form. The email template
  // uses this (?token_hash=…&type=recovery) so the token survives the mobile
  // email→browser handoff that drops URL fragments.
  if(_resetQuery.token_hash && _resetQuery.type === 'recovery'){
    try { await _sb.auth.verifyOtp({ token_hash: _resetQuery.token_hash, type: 'recovery' }); }
    catch(e){ console.warn('[recovery] verifyOtp failed', e); }
    _recoveryMode = true;
    history.replaceState({}, '', window.location.pathname);
    showAuthTab('reset');
    return;
  }

  // Recovery flow — captured synchronously at startup (before supabase-js parsed
  // and stripped the URL hash). If present, surface the set-new-password panel and
  // NEVER auto-enter the app.
  if(_recoveryMode){
    showAuthTab('reset');
    return;
  }

  let { data } = await _sb.auth.getSession();
  if(data?.session?.user){
    // getSession() returns whatever is in storage — including a DEAD session
    // whose refresh token has expired or been rotated away. Trusting it strands
    // the member in a "logged-in but every request 401s" state (the cause of the
    // blank-messages bug, only escapable by deleting and reinstalling the app).
    // So confirm the session is actually alive by refreshing it. We force a
    // re-login ONLY on a genuine auth failure; a network blip must not sign the
    // user out, so we keep the cached session and proceed (offline-friendly).
    try {
      const { data: _rd, error: _re } = await _sb.auth.refreshSession();
      if(_re){
        const _m = (_re.message || '').toLowerCase();
        const _authDead = _re.status === 400 || _re.status === 401 ||
          /refresh token|invalid|expired|not found|already used/.test(_m);
        if(_authDead){
          try { await _sb.auth.signOut().catch(()=>{}); } catch(__){}
          currentUser = null;
          return; // fall through to the login screen for a clean re-auth
        }
        // otherwise transient (e.g. offline) — keep the cached session
      } else if(_rd?.session?.user){
        data = _rd;
      }
    } catch(__){ /* network/exception — proceed with the cached session */ }
    // Defensive: if a PASSWORD_RECOVERY event flipped this flag while we were
    // awaiting above, show the reset form rather than entering the app.
    if(_recoveryMode){ showAuthTab('reset'); return; }
    await _loadProfile(data.session.user);
    // Restore the cached private key (no password on a session resume). If the
    // device was evicted this returns false and Messenger prompts to unlock.
    try { if(E2EE && !E2EE.unavailable) await E2EE.loadCached(data.session.user.id); } catch(_){}
    enterApp();
  }
});

// React to the recovery state arriving asynchronously after supabase parses the hash.
if(window._sb){ /* placeholder — sb already created above */ }
document.addEventListener('DOMContentLoaded', () => {
  if(!_sb) return;
  _sb.auth.onAuthStateChange((event) => {
    if(event === 'PASSWORD_RECOVERY'){ _recoveryMode = true; showAuthTab('reset'); return; }
    // Supabase fires SIGNED_OUT when it gives up on a session it can no longer
    // refresh (dead/rotated refresh token) — exactly the silent-stranding case
    // behind the blank-messages bug. If the member is sitting inside the app when
    // that happens, reload to the login screen so they can cleanly re-auth instead
    // of being stuck in a logged-in-but-every-request-401s limbo. Skip when WE
    // initiated the sign-out (signOut() handles its own reload).
    if(event === 'SIGNED_OUT'){
      if(_signingOut) return;
      const appScreen = document.getElementById('screen-app');
      const inApp = appScreen && appScreen.classList.contains('active');
      if(inApp){
        currentUser = null;
        window.location.reload();
      }
    }
  });
});

// ═════════════════════════ PULL-TO-REFRESH ═════════════════════════
// Session now persists, so a reload keeps the user signed in. Pulling down
// from the top of the app reloads (fresh data + latest deployed build).
(function(){
  const TH = 70;            // px of pull (after damping) needed to trigger
  let startY = 0, pulling = false, dist = 0, refreshing = false;
  const ind = () => document.getElementById('ptr-indicator');
  function anyOverlayOpen(){
    return ['paul-drawer','pcm-modal','profile-overlay'].some(id => {
      const e = document.getElementById(id);
      return e && getComputedStyle(e).display !== 'none';
    });
  }
  function canStart(){
    const app = document.getElementById('screen-app');
    // On the Messages page the shell is locked (overflow:hidden), so window.scrollY
    // is always 0 — pull-to-refresh would hijack every upward swipe in the thread
    // and the list could never scroll. Messages auto-polls, so just disable PTR there.
    if(document.documentElement.classList.contains('chat-lock')) return false;
    return app && app.classList.contains('active') && window.scrollY <= 0 && !anyOverlayOpen();
  }
  function setInd(px){
    const el = ind(); if(!el) return;
    el.style.transition = px ? 'none' : 'transform .2s ease';
    el.style.transform = 'translateY(' + (Math.min(px, 90) - 60) + 'px)';
    const spin = document.getElementById('ptr-spin');
    if(spin && !refreshing) spin.style.transform = 'rotate(' + (px * 4) + 'deg)';
  }
  function doRefresh(){
    refreshing = true;
    const el = ind(); if(el){ el.style.transition = 'transform .2s ease'; el.style.transform = 'translateY(10px)'; }
    const spin = document.getElementById('ptr-spin');
    if(spin){ spin.style.transform = ''; spin.classList.add('ptr-spinning'); }
    setTimeout(() => window.location.reload(), 350);
  }
  window.addEventListener('touchstart', e => {
    if(refreshing || !canStart()){ pulling = false; return; }
    startY = e.touches[0].clientY; pulling = true; dist = 0;
  }, { passive: true });
  window.addEventListener('touchmove', e => {
    if(!pulling) return;
    dist = e.touches[0].clientY - startY;
    if(dist > 0 && window.scrollY <= 0){
      e.preventDefault();           // claim the gesture from native overscroll
      setInd(dist * 0.5);
    } else if(dist <= 0){
      setInd(0);
    }
  }, { passive: false });
  window.addEventListener('touchend', () => {
    if(!pulling) return; pulling = false;
    if(dist * 0.5 >= TH) doRefresh(); else setInd(0);
  });
})();
