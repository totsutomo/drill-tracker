// Minimal service worker: required only for "add to home screen" installability.
// 目的はオフライン完全対応ではない(実装プラン10章)。push通知はPhase2以降。

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
