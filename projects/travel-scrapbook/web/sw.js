// sw.js — minimal service worker. No caching: the app is a thin shell over the
// API and stale HTML/JS causes more trouble than offline support is worth at
// this stage. A registered SW (plus the manifest) is what makes Chrome treat
// the site as installable, which puts it in the Android share sheet.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* network passthrough */ });
