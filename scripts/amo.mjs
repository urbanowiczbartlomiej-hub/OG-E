// AMO (addons.mozilla.org) API v5 client — JWT auth + the listed-version
// upload flow: upload the bundle → poll validation → create the version (with
// the public release notes + the private reviewer notes) → attach the source
// archive. Extracted from release.mjs so the orchestrator stays about
// orchestration. Release-only tooling; never bundled into the extension.
//
// Throws on ANY failure (validation timeout/error, non-2xx). release.mjs turns
// that into a clean abort BEFORE pushing the tag, so a rejected upload never
// leaves a pushed tag pointing at a release that does not exist.

import { readFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';

const AMO_BASE = 'https://addons.mozilla.org/api/v5';
const POLL_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 5_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// A short-lived (60 s) HS256 JWT, signed fresh per request — AMO's API-key scheme.
function makeJwt(issuer, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const iat = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ iss: issuer, jti: randomUUID(), iat, exp: iat + 60 }));
  const sig = b64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

// Build an `amo(path, opts)` caller bound to one set of credentials.
function makeAmo(issuer, secret) {
  return async function amo(path, { method = 'GET', body, json } = {}) {
    const headers = { Authorization: `JWT ${makeJwt(issuer, secret)}` };
    let payload = body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(json);
    }
    const res = await fetch(`${AMO_BASE}${path}`, { method, headers, body: payload });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      throw new Error(`AMO ${method} ${path} → ${res.status}\n${JSON.stringify(data, null, 2)}`);
    }
    return data;
  };
}

/**
 * Upload a built bundle to AMO as a new listed version, then attach the source
 * archive. No-op (logs + returns) when the version is already on AMO — so a
 * re-run, or a CI run triggered by a tag a local release already published,
 * is safe.
 *
 * @param {object} opts
 * @param {string} opts.guid           Add-on GUID (manifest gecko.id).
 * @param {string} opts.version        Version being released (X.Y.Z).
 * @param {string} opts.issuer         AMO_JWT_ISSUER.
 * @param {string} opts.secret         AMO_JWT_SECRET.
 * @param {string} opts.distZip        Absolute path to dist.zip.
 * @param {string} opts.sourceZip      Absolute path to source.zip.
 * @param {string} opts.releaseNotes   Public release notes (en-US).
 * @param {string} opts.reviewerNotes  Private "Notes to Reviewer".
 * @param {(msg: string) => void} [opts.log]  Progress sink (default console.log).
 * @returns {Promise<void>}
 */
export async function uploadToAmo({
  guid,
  version,
  issuer,
  secret,
  distZip,
  sourceZip,
  releaseNotes,
  reviewerNotes,
  log = console.log,
}) {
  const amo = makeAmo(issuer, secret);
  const fileBlob = (path) => new Blob([readFileSync(path)]);

  // Already published? (network error / 404 → treat as "not there yet".)
  let alreadyThere = false;
  try {
    const data = await amo(`/addons/addon/${guid}/versions/?filter=all_with_unlisted`);
    alreadyThere = (data.results || []).some((v) => v.version === version);
  } catch {
    alreadyThere = false;
  }
  if (alreadyThere) {
    log(`version ${version} already on AMO — skipping upload.`);
    return;
  }

  // upload the built bundle
  const fd = new FormData();
  fd.append('upload', fileBlob(distZip), 'dist.zip');
  fd.append('channel', 'listed');
  const { uuid } = await amo('/addons/upload/', { method: 'POST', body: fd });
  log(`AMO upload uuid ${uuid} — waiting for validation…`);

  // poll until validated
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let status;
  do {
    await sleep(POLL_INTERVAL_MS);
    status = await amo(`/addons/upload/${uuid}/`);
    if (Date.now() > deadline) throw new Error('AMO validation timed out.');
  } while (!status.processed);
  if (!status.valid) {
    throw new Error(`AMO validation failed:\n${JSON.stringify(status.validation?.messages ?? status, null, 2)}`);
  }
  log('AMO validation passed.');

  // create the version with both note fields
  const created = await amo(`/addons/addon/${guid}/versions/`, {
    method: 'POST',
    json: {
      upload: uuid,
      release_notes: { 'en-US': releaseNotes },
      approval_notes: reviewerNotes,
    },
  });
  log(`created AMO version ${created.version} (id ${created.id}).`);

  // attach the source archive (separate multipart PATCH)
  const sfd = new FormData();
  sfd.append('source', fileBlob(sourceZip), 'source.zip');
  await amo(`/addons/addon/${guid}/versions/${created.id}/`, { method: 'PATCH', body: sfd });
  log('attached source.zip.');
}
