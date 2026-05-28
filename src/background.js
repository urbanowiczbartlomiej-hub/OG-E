// @ts-check

// Background service worker — privileged network proxy for ntfy.sh.
//
// # Why this exists
//
// Firefox content scripts are subject to CORS even when the extension
// has declared `host_permissions` for the target host. ntfy.sh returns
// `Access-Control-Allow-Headers: *` in its CORS preflight response;
// the Fetch spec — and Firefox's strict implementation of it — does NOT
// treat the wildcard as covering the `Authorization` header. That means
// any content-script `fetch` to ntfy.sh with an `Authorization: Bearer`
// header fails the preflight and is never sent.
//
// Chrome bypasses CORS for content scripts that have host_permissions;
// Firefox does not. Since OG-E targets Firefox exclusively (Manifest V3,
// gecko id), we need a different mechanism.
//
// Background service workers run at extension origin. Extension-origin
// requests are not subject to web-page CORS restrictions, so the ntfy
// Authorization header goes through without a preflight fight.
//
// # Protocol
//
// Content scripts (and extension pages, for consistency) send:
//   { type: 'ntfy-fetch', url, method, headers, body }
//
// This listener responds with:
//   { ok, status, statusText, text }
//
// `text` is the raw response body string. Callers in ntfyScheduler.js
// wrap this back into a Response-shaped object so the upstream parsing
// code is unchanged.

// Access `browser` via globalThis — not declared in lib.dom; same
// pattern as lib/storage.js to satisfy strict TypeScript checks.
const g = /** @type {Record<string, any>} */ (/** @type {unknown} */ (globalThis));

g.browser.runtime.onMessage.addListener(
  /** @param {{ type?: string, url?: string, method?: string, headers?: Record<string,string>, body?: string | null }} msg */
  (msg) => {
    if (msg?.type !== 'ntfy-fetch') return; // let other listeners handle other messages

    return (async () => {
      /** @type {RequestInit} */
      const init = {
        method: msg.method ?? 'GET',
        headers: msg.headers ?? {},
      };
      if (msg.body != null) init.body = msg.body;

      const res = await fetch(msg.url ?? '', init);
      const text = await res.text();
      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        text,
      };
    })();
  },
);
