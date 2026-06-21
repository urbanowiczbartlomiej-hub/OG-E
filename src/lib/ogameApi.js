// @ts-check

// Thin fetch layer for the OGame public *statistics* API (`/api/*.xml`).
//
// The content script runs ON the universe host (e.g.
// `s163-pl.ogame.gameforge.com`), and the API is served from that same host,
// so every request here is SAME-ORIGIN: no CORS, no `host_permissions`, no
// base-URL guessing. We only ever fetch the current universe's data (the
// per-device, current-universe-only rule), which is exactly what same-origin
// gives us for free. Cross-universe fetching would need `host_permissions` for
// `*.ogame.gameforge.com` and an AMO permissions note — deliberately out of
// scope.
//
// This module returns RAW TEXT only. All parsing is pure and lives in
// `domain/apiOccupancy.js`; the side-effectful orchestration (cadence, cache,
// own-id) lives in `features/apiContext`. lib/ stays the zero-app-dep
// foundation — it imports nothing from domain/state/features/sync.

/* global location, fetch */

const API_PATH = '/api';

/**
 * Build the same-origin URL for a statistics endpoint.
 * @param {string} file              Endpoint base name, e.g. `'universe'`, `'players'`.
 * @param {Record<string,string>} [params]   Query params (e.g. highscore `{category,type}`).
 * @returns {string}
 */
export function apiUrl(file, params) {
  const base = `${location.origin}${API_PATH}/${file}.xml`;
  if (!params) return base;
  return `${base}?${new URLSearchParams(params).toString()}`;
}

/**
 * Fetch one statistics endpoint as text. Throws on a non-2xx response so the
 * caller can decide how to degrade (the picker falls back to live-hook-only).
 * `credentials: 'omit'` — these are public files; never attach the game cookie.
 *
 * @param {string} file
 * @param {Record<string,string>} [params]
 * @returns {Promise<string>}
 */
export async function fetchApiText(file, params) {
  const res = await fetch(apiUrl(file, params), { credentials: 'omit' });
  if (!res.ok) throw new Error(`ogame api ${file}: HTTP ${res.status}`);
  return res.text();
}
