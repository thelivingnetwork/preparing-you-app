// Preparing You — service worker.
// Responsibilities:
//   1. Receive Web Push events from the server and surface them as system
//      notifications so the user sees them when the PWA is closed.
//   2. Update the home-screen app icon badge (Badging API).
//   3. Focus or open the right page when the user taps the notification.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// ── helpers ──────────────────────────────────────────────────────────────────
function _setBadge(n) {
  // iOS quirk: 'setAppBadge' in navigator returns false even when the API
  // exists — skip the feature-detect and just try/catch directly.
  try {
    if (n > 0) navigator.setAppBadge(n);
    else        navigator.clearAppBadge();
  } catch (_) {}
}

function _notifyClients(count) {
  // Forward the badge count to any open windows so they can call
  // navigator.setAppBadge from the page context (belt-and-suspenders for iOS).
  self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(clients => clients.forEach(c => c.postMessage({ kind: 'set-badge', count })))
    .catch(() => {});
}

// ── push ─────────────────────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}
  const title  = data.title  || 'Preparing You';
  const body   = data.body   || 'You have a new notification.';
  const unread = typeof data.unread === 'number' ? data.unread : 1;
  const action = data.action || null;

  const showPromise = self.registration.showNotification(title, {
    body,
    icon:      '/icon-192.png',
    badge:     '/favicon.png',
    tag:       'preparing-you-notif',
    renotify:  true,
    data:      { action, unread }
  });

  // Set the homescreen icon badge count.
  _setBadge(unread);
  _notifyClients(unread);

  event.waitUntil(showPromise);
});

// ── notification tap ─────────────────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data       = event.notification.data || {};
  const targetPage = data.action && data.action.type === 'page' ? data.action.page : null;
  const url        = new URL('/app/', self.location.origin);
  if (targetPage) url.hash = '#page=' + encodeURIComponent(targetPage);

  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.startsWith(self.location.origin)) {
        c.focus();
        c.postMessage({ kind: 'notif-click', action: data.action });
        return;
      }
    }
    await self.clients.openWindow(url.toString());
  })());
});

// ── page messages ─────────────────────────────────────────────────────────────
// Allow the page to push badge updates to the SW (e.g. when the user marks
// notifications read and the foreground count drops to zero).
self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.kind === 'set-badge') {
    _setBadge(typeof msg.count === 'number' ? msg.count : 0);
  }
});
