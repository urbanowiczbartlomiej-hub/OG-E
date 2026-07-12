// @ts-check

// Alliance-share gist IO — the network side of the opt-in alliance Spyglass
// share (IDEAS.md entry 2). Runs at the DASHBOARD (extension origin), strictly
// click-driven: the one caller is the Spyglass "Alliance" button, so there is
// no scheduler, no debounce backstop, and no persisted rate-limit backoff —
// nothing here ever fires in the background (the consent model).
//
// # Why not gist.js's `gh`
//
// `sync/gist.js` binds its client to the PERSONAL token in the game origin's
// localStorage. This module talks to a DIFFERENT gist under a DIFFERENT trust
// boundary — an alliance-owned gist via a token shared across the alliance
// (see state/allianceShare.js) — and runs at the extension origin, which
// can't read that localStorage anyway (the same reason the alarmClock
// dashboard preview fetches with an explicitly passed token). So the token is
// a parameter, never ambient state.
//
// # The file
//
// One plain pretty-printed JSON file per universe in the alliance gist,
// `oge-spyglass-alliance-<universeId>.json` — the alarmClock per-universe
// files are the precedent for extra plain-JSON files coexisting with the
// compressed personal bundle. Plain JSON on purpose: alliance-mates should be
// able to eyeball exactly what everyone shares. GitHub's gist PATCH operates
// per file, so writing it never touches the gist's other files.

/* global fetch */

import { API_BASE, conciseErrorBody } from './gist.js';

/**
 * Filename prefix of the per-universe alliance-share files. Full name:
 * `${ALLIANCE_FILENAME_PREFIX}${universeId}.json`.
 */
export const ALLIANCE_FILENAME_PREFIX = 'oge-spyglass-alliance-';

/**
 * Build the gist filename for a universe.
 * @param {string} universeId  e.g. `'s163-pl'`.
 * @returns {string}
 */
export const allianceFilenameFor = (universeId) =>
  `${ALLIANCE_FILENAME_PREFIX}${universeId}.json`;

/**
 * One-call GitHub API client with an EXPLICIT token (see file header). Throws
 * `HTTP <status>: <concise body>` on any non-ok response; no backoff arming —
 * a click-driven caller surfaces the error and stops.
 *
 * @param {string} token
 * @param {string} path  API path starting with `/`.
 * @param {RequestInit} [options]
 * @returns {Promise<any>} Parsed JSON body.
 */
const ghAlliance = async (token, path, options = {}) => {
  const res = await fetch(API_BASE + path, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${conciseErrorBody(text) || res.statusText}`);
  }
  return res.json();
};

/**
 * Fetch and parse one universe's alliance file from the gist.
 *
 * Returns `null` when the file doesn't exist yet (first share seeds it).
 * THROWS on HTTP errors and on unparseable JSON — a malformed file means
 * someone hand-edited it, and silently treating it as empty would make the
 * next write clobber every member's blocks. The user fixes or deletes the
 * file in the gist instead.
 *
 * @param {string} token
 * @param {string} gistId
 * @param {string} universeId
 * @returns {Promise<unknown | null>} Raw parsed JSON (caller normalises via
 *   `domain/allianceIntel.normalizeAllianceDoc`).
 */
export const fetchAllianceFile = async (token, gistId, universeId) => {
  const gist = await ghAlliance(token, `/gists/${gistId}`);
  const file = gist?.files?.[allianceFilenameFor(universeId)];
  if (!file) return null;
  let text = file.content;
  // >1 MB gist files come back truncated with the full bytes behind raw_url —
  // same guard as gist.js readGistFile (far-fetched for this small file, but
  // a truncated parse would throw as "malformed" and dead-end the feature).
  if (file.truncated && file.raw_url) {
    const res = await fetch(file.raw_url);
    if (!res.ok) throw new Error(`alliance file fetch failed: HTTP ${res.status}`);
    text = await res.text();
  }
  if (typeof text !== 'string' || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('alliance file is not valid JSON — fix or delete it in the gist');
  }
};

/**
 * PATCH one universe's alliance file into the gist (pretty-printed — see
 * file header). The caller supplies the already-merged doc.
 *
 * @param {string} token
 * @param {string} gistId
 * @param {string} universeId
 * @param {unknown} doc
 * @returns {Promise<void>}
 */
export const writeAllianceFile = async (token, gistId, universeId, doc) => {
  await ghAlliance(token, `/gists/${gistId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      files: {
        [allianceFilenameFor(universeId)]: { content: JSON.stringify(doc, null, 2) },
      },
    }),
  });
};
