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

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}
  const title = data.title || 'Preparing You';
  const body  = data.body  || 'You have a new notification.';
  const unread = typeof data.unread === 'number' ? data.unread : null;
  const action = data.action || null;

  const showPromise = self.registration.showNotification(title, {
    body,
    icon: '/ark-purple.png',
    badge: '/favicon.png',
    tag: 'preparing-you-notif',
    renotify: true,
    data: { action }
  });

  const badgePromise = (unread !== null && self.navigator && 'setAppBadge' in self.navigator)
    ? (unread > 0 ? self.navigator.setAppBadge(unread) : self.navigator.clearAppBadge())
    : Promise.resolve();

  event.waitUntil(Promise.all([showPromise, badgePromise]));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const targetPage = data.action && data.action.type === 'page' ? data.action.page : null;
  const url = new URL('/', self.location.origin);
  if (targetPage) url.hash = '#page=' + encodeURIComponent(targetPage);

  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // If an app window is already open, focus it and route inside.
    for (const c of all) {
      if (c.url.startsWith(self.location.origin)) {
        c.focus();
        c.postMessage({ kind: 'notif-click', action: data.action });
        return;
      }
    }
    // Otherwise open a fresh one.
    await self.clients.openWindow(url.toString());
  })());
});

// Allow the page to clear the icon badge when the user marks notifications
// read (sent from index.html via postMessage).
self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.kind === 'set-badge' && self.navigator && 'setAppBadge' in self.navigator) {
    const n = typeof msg.count === 'number' ? msg.count : 0;
    if (n > 0) self.navigator.setAppBadge(n); else self.navigator.clearAppBadge();
  }
});
