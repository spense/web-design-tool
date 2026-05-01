// Minimal service worker. Chrome requires a fetch handler for PWA install.
// We don't actually cache anything (this is a local dev tool), just pass through.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* network-only */ });
