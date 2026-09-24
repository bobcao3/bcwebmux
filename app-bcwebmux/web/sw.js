// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

// Keep a fetch handler for browsers that require one for PWA installation.
// This application needs a live server; never cache credentials, assets, or sessions.
self.addEventListener("fetch", event => {
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request));
  }
});
