// Chrome Web Store API (v1.1) client — OAuth refresh-token auth + the
// upload → publish flow. The Chrome twin of amo.mjs, and it follows the same
// contract: throws on ANY failure so release.mjs turns it into a clean abort,
// and a re-run of an already-published version is a no-op (not an error).
// Release-only tooling; never bundled into the extension.
//
// The item must already exist on the Chrome Web Store (the API updates an
// existing listing; it cannot create a brand-new one) — its id is
// CWS_EXTENSION_ID. Auth is a long-lived OAuth refresh token exchanged for a
// short-lived access token per run (CWS_CLIENT_ID / CWS_CLIENT_SECRET /
// CWS_REFRESH_TOKEN), minted once against a Google Cloud OAuth client with the
// Chrome Web Store API enabled.

import { readFileSync } from 'node:fs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const uploadUrl = (id) =>
  `https://www.googleapis.com/upload/chromewebstore/v1.1/items/${id}?uploadType=media`;
const publishUrl = (id) =>
  `https://www.googleapis.com/chromewebstore/v1.1/items/${id}/publish`;

// Exchange the long-lived refresh token for a short-lived access token.
async function accessToken(clientId, clientSecret, refreshToken) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_URL, { method: 'POST', body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`CWS token refresh → ${res.status}\n${JSON.stringify(data, null, 2)}`);
  }
  return data.access_token;
}

// CWS reports "this version is already up" as an upload FAILURE whose error text
// mentions the version already existing / being the same. Re-running a release
// (CI re-trigger, resume after a later-phase failure) must treat that as a
// no-op, exactly like amo.mjs skips a version already on AMO.
function isAlreadyUp(data) {
  const blob = JSON.stringify(data).toLowerCase();
  return blob.includes('already exists') || blob.includes('same as the version');
}

// CWS refuses an upload while the item already has a submission in flight
// (error_code ITEM_NOT_UPDATABLE — "pending review, ready to publish, or
// deleted status"). That is a TRANSIENT collision, not a release failure: two
// versions can't queue at once, so this version's Chrome upload is simply
// skipped and a later release carries it once review clears. Treat it like
// "already up" — warn and move on rather than failing the whole release (which
// would red a run that already published to AMO).
function isNotUpdatable(data) {
  const blob = JSON.stringify(data).toLowerCase();
  return blob.includes('item_not_updatable') || blob.includes('pending review') || blob.includes('ready to publish');
}

/**
 * Upload a built Chrome zip to an existing Chrome Web Store item and (by
 * default) submit it for publication. No-op when the version is already up.
 *
 * @param {object} opts
 * @param {string} opts.itemId        Chrome Web Store extension id (CWS_EXTENSION_ID).
 * @param {string} opts.clientId      OAuth client id.
 * @param {string} opts.clientSecret  OAuth client secret.
 * @param {string} opts.refreshToken  OAuth refresh token.
 * @param {string} opts.version       Version being released (X.Y.Z) — logging only.
 * @param {string} opts.zip           Absolute path to the Chrome zip.
 * @param {boolean} [opts.publish]    Submit for publication after upload (default true).
 * @param {(msg: string) => void} [opts.log]  Progress sink (default console.log).
 * @returns {Promise<'published' | 'draft' | 'skipped'>} What actually happened,
 *   so callers report the truth (a busy/already-up item resolves to 'skipped').
 */
export async function uploadToCws({
  itemId,
  clientId,
  clientSecret,
  refreshToken,
  version,
  zip,
  publish = true,
  log = console.log,
}) {
  const token = await accessToken(clientId, clientSecret, refreshToken);
  const auth = { Authorization: `Bearer ${token}`, 'x-goog-api-version': '2' };

  // Upload the package as the item's new draft.
  const up = await fetch(uploadUrl(itemId), { method: 'PUT', headers: auth, body: readFileSync(zip) });
  const upData = await up.json().catch(() => ({}));
  if (!up.ok) throw new Error(`CWS upload → ${up.status}\n${JSON.stringify(upData, null, 2)}`);
  if (upData.uploadState === 'FAILURE') {
    if (isAlreadyUp(upData)) {
      log(`version ${version} already on the Chrome Web Store — skipping.`);
      return 'skipped';
    }
    if (isNotUpdatable(upData)) {
      log(
        `Chrome Web Store item is busy (a prior version is pending review / ready to ` +
          `publish) — skipping ${version}'s Chrome upload; a later release carries it.`,
      );
      return 'skipped';
    }
    throw new Error(`CWS upload failed:\n${JSON.stringify(upData, null, 2)}`);
  }
  log(`CWS upload state: ${upData.uploadState}.`);

  if (!publish) {
    log('CWS: uploaded as a draft (publish skipped).');
    return 'draft';
  }

  // Submit the draft for publication (Google's review queue; it goes live on
  // approval — the same "hands-off after submit" shape as the AMO upload).
  const pub = await fetch(publishUrl(itemId), {
    method: 'POST',
    headers: { ...auth, 'Content-Length': '0' },
  });
  const pubData = await pub.json().catch(() => ({}));
  if (!pub.ok) throw new Error(`CWS publish → ${pub.status}\n${JSON.stringify(pubData, null, 2)}`);
  const status = Array.isArray(pubData.status) ? pubData.status : [];
  // OK = live/queued; ITEM_PENDING_REVIEW = accepted into review. Both are
  // success; anything else (e.g. a policy/quota block) must fail the release.
  const ok = status.length > 0 && status.every((s) => s === 'OK' || s === 'ITEM_PENDING_REVIEW');
  if (!ok) throw new Error(`CWS publish returned a non-success status:\n${JSON.stringify(pubData, null, 2)}`);
  log(`CWS publish status: ${status.join(', ')}.`);
  return 'published';
}
