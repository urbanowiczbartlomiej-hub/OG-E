// @ts-check

// Thin fetch layer for the OGame public *statistics* API (`/api/*.xml`).
//
// The content script runs ON the universe host (e.g.
// `s163-pl.ogame.gameforge.com`), and the API is served from that same host,
// so an in-game request is SAME-ORIGIN by default: no CORS, no base-URL guessing.
// Omit the `origin` argument and every call resolves against `location.origin` —
// exactly the current-universe data the per-device rule wants, for free.
//
// The dashboard is the exception: it runs on the EXTENSION origin
// (`moz-extension://…`), so it must pass an explicit `origin` (the selected
// universe's `https://s<num>-<lang>.ogame.gameforge.com`). That cross-origin
// fetch is allowed by the manifest's existing `host_permissions`
// (`*://*.ogame.gameforge.com/*`); the data is still the same public XML,
// fetched with `credentials: 'omit'` (never the game cookie). This is the only
// sanctioned cross-origin caller — see PRIVACY.md.
//
// This module returns RAW TEXT only. All parsing is pure and lives in
// `domain/apiOccupancy.js`; the side-effectful orchestration (cadence, cache,
// own-id) lives in `features/shared/apiRefresh.js`. lib/ stays the zero-app-dep
// foundation — it imports nothing from domain/state/features/sync.

/* global location, fetch */

const API_PATH = '/api';

/**
 * Build the URL for a statistics endpoint. Defaults to same-origin
 * (`location.origin`); pass `origin` to target a specific universe host (the
 * dashboard, which is not on a game origin).
 * @param {string} file              Endpoint base name, e.g. `'universe'`, `'players'`.
 * @param {Record<string,string>} [params]   Query params (e.g. highscore `{category,type}`).
 * @param {string} [origin]          Absolute origin, e.g. `https://s163-pl.ogame.gameforge.com`.
 * @returns {string}
 */
export function apiUrl(file, params, origin) {
  const root = origin || (typeof location !== 'undefined' ? location.origin : '');
  const base = `${root}${API_PATH}/${file}.xml`;
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
 * @param {string} [origin]   Absolute origin to fetch from (default: same-origin).
 * @returns {Promise<string>}
 */
export async function fetchApiText(file, params, origin) {
  const res = await fetch(apiUrl(file, params, origin), { credentials: 'omit' });
  if (!res.ok) throw new Error(`ogame api ${file}: HTTP ${res.status}`);
  return res.text();
}
