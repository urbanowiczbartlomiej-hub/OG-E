// Release orchestrator for AMO (addons.mozilla.org) listed submissions.
//
// One command runs the whole non-negotiable checklist from CLAUDE.md:
//
//   npm run release 1.10.0
//
// Phases (each guarded so a re-run after a failure resumes cleanly):
//   0. parse version, require a clean tree EXCEPT CHANGELOG/package/manifest
//      (those are the release's own edits — they ride in the release commit)
//   1. validate CHANGELOG section exists (+ date); extract it as the
//      public release notes; require AMO credentials in the env
//   2. npm run test + npm run typecheck            (skip with --skip-tests)
//   3. write the version into package.json AND manifest.json
//   4. npm run package  → dist.zip + source.zip    (hard-assert both)
//   5. git commit (CHANGELOG + package + manifest) + tag vX.Y.Z, LOCAL
//   6. upload to AMO: dist.zip + release notes + reviewer notes + source.zip
//   7. git push --tags                             (only AFTER AMO accepts)
//
// Why git stays local until AMO accepts (step 5 before 6, push in 7):
// if AMO rejects the archive we must not have a pushed tag pointing at a
// release that does not exist. Everything is reversible locally until the
// network step in 6 succeeds.
//
// Idempotent re-run: if tag vX.Y.Z already exists, steps 3–5 are skipped;
// if the version already exists on AMO, step 6 is skipped. So re-running
// after a half-finished release simply finishes it.
//
// Zero runtime dependencies — JWT via node:crypto, multipart via the
// global FormData/Blob/fetch (Node ≥ 20), same spirit as package.mjs.
//
// Secrets (never in the repo — see .gitignore):
//   AMO_JWT_ISSUER  — "JWT issuer" from the AMO API-key page
//   AMO_JWT_SECRET  — "JWT secret" from the same page
// Load them however you like; `node --env-file=.env scripts/release.mjs`
// works if you keep a local .env (already gitignored).
//
// Flags / env:
//   --preview / --dry-run     validate + preview, mutate nothing
//   RELEASE_PREVIEW=1 (env)   same as --preview
//   --skip-tests              skip the test + typecheck phase
//
// IMPORTANT — how to PREVIEW safely. This npm eats EVERY `--flag` as its own
// config even after the `--` separator (you'll see "Unknown env config …"),
// so `npm run release -- X.Y.Z --preview` reaches this script with NO flag
// and performs a REAL release. Only the positional version forwards. So:
//
//   • Real release (no flags):   npm run release -- X.Y.Z
//   • Preview, the robust way:   node --env-file-if-exists=.env \
//                                  scripts/release.mjs X.Y.Z --preview
//   • Preview via npm (env):     RELEASE_PREVIEW=1 npm run release -- X.Y.Z
//     (PowerShell: $env:RELEASE_PREVIEW=1; npm run release -- X.Y.Z)
//
// This bit us once: a `--dry-run` meant as a preview published 1.9.1.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';

const ROOT = resolve(import.meta.dirname, '..');
const AMO_BASE = 'https://addons.mozilla.org/api/v5';
const ADDON_GUID = 'og-e@ogame-extensions'; // manifest browser_specific_settings.gecko.id
const POLL_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 5_000;

// The files the release itself writes + commits (phase 3 + 5). A pending
// edit to any of these is EXPECTED — the CHANGELOG section is the one manual
// step and the two version files are bumped here — so they're excluded from
// the clean-tree gate. The result: code + tests live in their own commit(s),
// and the CHANGELOG entry lands together with the version bump in the single
// `chore(release)` commit the tag points at (the standard-version shape), with
// no transient commit where the CHANGELOG and the version disagree.
const RELEASE_FILES = new Set(['CHANGELOG.md', 'package.json', 'manifest.json']);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));
// npm swallows --flags even after `--` (see header), so a flag alone can't be
// trusted for preview when invoked via npm. RELEASE_PREVIEW=1 is the
// npm-passable escape hatch; the flags work when run directly with node.
const DRY = flags.has('--preview') || flags.has('--dry-run') || process.env.RELEASE_PREVIEW === '1';
const SKIP_TESTS = flags.has('--skip-tests');
// --unlisted: upload to the unlisted AMO channel (signed but not publicly
// visible and not offered as an update to existing users).
const UNLISTED = flags.has('--unlisted');
const CHANNEL = UNLISTED ? 'unlisted' : 'listed';

function die(msg) {
  console.error(`release: ${msg}`);
  process.exit(1);
}

function run(cmd) {
  console.log(`release: $ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: ROOT });
}

function capture(cmd) {
  return execSync(cmd, { cwd: ROOT }).toString().trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// phase 0 — version + clean tree (clean EXCEPT the release files)
// ---------------------------------------------------------------------------

const VERSION = positional[0];
if (!VERSION) die('usage: npm run release -- <X.Y.Z> [--preview] [--skip-tests]');
if (!/^\d+\.\d+\.\d+$/.test(VERSION)) die(`not a semver version: "${VERSION}"`);
const TAG = `v${VERSION}`;

const tagExists = capture(`git tag -l ${TAG}`) === TAG;

if (!DRY && !tagExists) {
  // `git status --porcelain` lines are "XY <path>"; the path starts at col 3.
  // A pending edit to a RELEASE_FILES entry is expected (we commit it below);
  // anything ELSE dirty means the code/tests aren't committed yet — refuse,
  // so the release commit stays a clean CHANGELOG + version bump.
  //
  // NOTE: read the status RAW, not via capture() — capture() trims the whole
  // output, which eats the leading space of the first porcelain line (an
  // unstaged " M CHANGELOG.md"), shifting slice(3) to "HANGELOG.md" and
  // flagging the one expected file as stray. This bites every normal release
  // (CHANGELOG is the sole dirty file). Only strip the trailing newline.
  const stray = execSync('git status --porcelain', { cwd: ROOT })
    .toString()
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => !RELEASE_FILES.has(line.slice(3).trim()));
  if (stray.length) {
    die(
      'working tree has uncommitted changes outside the release files ' +
        '(CHANGELOG.md / package.json / manifest.json):\n       ' +
        stray.join('\n       ') +
        '\n       Commit or stash them first — only the CHANGELOG entry + the ' +
        'version bump belong in the release commit.',
    );
  }
}

// ---------------------------------------------------------------------------
// phase 1 — CHANGELOG + credentials
// ---------------------------------------------------------------------------

function extractChangelogSection(version) {
  const text = readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf8');
  // Header: "## [1.10.0] — 2026-05-31" (em-dash). Body runs to the next "## ".
  const escaped = version.replace(/\./g, '\\.');
  const re = new RegExp(
    `^## \\[${escaped}\\]\\s+—\\s+(\\d{4}-\\d{2}-\\d{2})\\s*$([\\s\\S]*?)(?=^## )`,
    'm',
  );
  const m = text.match(re);
  if (!m) {
    die(
      `no dated "## [${version}] — YYYY-MM-DD" section in CHANGELOG.md.\n` +
        '       Write the release notes there first (this is the one manual step).',
    );
  }
  const date = m[1];
  const body = m[2].trim();
  if (!body) die(`CHANGELOG section for ${version} is empty.`);
  return { date, body };
}

const { date: changelogDate, body: releaseNotes } = extractChangelogSection(VERSION);

const reviewerNotesPath = resolve(ROOT, 'amo-reviewer-notes.txt');
if (!existsSync(reviewerNotesPath)) {
  die('amo-reviewer-notes.txt is missing — it holds the AMO "Notes to Reviewer".');
}
const reviewerNotes = readFileSync(reviewerNotesPath, 'utf8').trim();
if (!reviewerNotes) die('amo-reviewer-notes.txt is empty.');

const JWT_ISSUER = process.env.AMO_JWT_ISSUER;
const JWT_SECRET = process.env.AMO_JWT_SECRET;
if (!JWT_ISSUER || !JWT_SECRET) {
  die('set AMO_JWT_ISSUER and AMO_JWT_SECRET (see .env.example).');
}

console.log(`release: ${TAG}  (CHANGELOG dated ${changelogDate})`);
if (UNLISTED) console.log('release: channel = unlisted (not offered as update to existing users)');

// Warn if any CHANGELOG version lacks a git tag — symptom of a manual AMO
// upload that bypassed this script. A missing tag means the release is
// unreproducible and the channel/version checks above can't be trusted.
{
  const clText = readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf8');
  const untagged = [...clText.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)]
    .map((m) => m[1])
    .filter((v) => capture(`git tag -l v${v}`).trim() !== `v${v}`);
  if (untagged.length) {
    console.warn(
      `release: WARNING — CHANGELOG versions without a git tag: ${untagged.join(', ')}.\n` +
        '         These were likely uploaded to AMO manually (bypassing this script).\n' +
        '         If any of those are in the wrong channel, the channel-mismatch guard\n' +
        '         above will catch it when you try to re-release them.',
    );
  }
}

// ---------------------------------------------------------------------------
// dry run stops here — preview only, nothing mutated
// ---------------------------------------------------------------------------

if (DRY) {
  console.log('\n--- DRY RUN — no files written, nothing uploaded or pushed ---\n');
  console.log('Public release notes (release_notes) would be:\n');
  console.log(releaseNotes);
  console.log('\nReviewer notes (approval_notes) would be:\n');
  console.log(reviewerNotes);
  console.log(`\nWould bump package.json + manifest.json to ${VERSION},`);
  console.log(`package, commit, tag ${TAG}, upload to AMO, then push --tags.`);
  if (tagExists) console.log(`\nNote: ${TAG} already exists — a real run would resume at AMO upload.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// phase 2 — tests
// ---------------------------------------------------------------------------

if (SKIP_TESTS) {
  console.log('release: skipping tests (--skip-tests)');
} else {
  run('npm run test');
  run('npm run typecheck');
}

// ---------------------------------------------------------------------------
// phases 3–5 — bump, package, local git (skipped if the tag already exists)
// ---------------------------------------------------------------------------

function bumpVersionFile(file) {
  const path = resolve(ROOT, file);
  const text = readFileSync(path, 'utf8');
  if (!/"version":\s*"/.test(text)) die(`could not find a "version" field to bump in ${file}`);
  const next = text.replace(/("version":\s*")[^"]+(")/, `$1${VERSION}$2`);
  writeFileSync(path, next);
  console.log(`release: bumped ${file} → ${VERSION}`);
}

if (tagExists) {
  console.log(`release: ${TAG} already exists — resuming at AMO upload (skipping bump/package/commit/tag).`);
} else {
  // phase 3
  bumpVersionFile('package.json');
  bumpVersionFile('manifest.json');

  // phase 4
  run('npm run package');
  for (const f of ['dist.zip', 'source.zip']) {
    if (!existsSync(resolve(ROOT, f))) die(`${f} was not produced by npm run package.`);
  }

  // phase 5 (local commit + tag)
  run('git add CHANGELOG.md package.json manifest.json');
  // --allow-empty handles the CI case where CHANGELOG + version files are
  // already committed (the script still creates the release marker commit).
  run(`git commit --allow-empty -m "chore(release): ${VERSION}"`);
  run(`git tag ${TAG}`);
}

// ---------------------------------------------------------------------------
// phase 6 — AMO upload
// ---------------------------------------------------------------------------

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeJwt() {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const iat = Math.floor(Date.now() / 1000);
  const payload = b64url(
    JSON.stringify({ iss: JWT_ISSUER, jti: randomUUID(), iat, exp: iat + 60 }),
  );
  const sig = b64url(createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

async function amo(path, { method = 'GET', body, json } = {}) {
  const headers = { Authorization: `JWT ${makeJwt()}` };
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
}

function fileBlob(name) {
  return new Blob([readFileSync(resolve(ROOT, name))]);
}

async function versionAlreadyOnAmo() {
  try {
    const data = await amo(`/addons/addon/${ADDON_GUID}/versions/?filter=all_with_unlisted`);
    const existing = (data.results || []).find((v) => v.version === VERSION);
    if (!existing) return false;
    // Guard against silently skipping when the same version number was already
    // uploaded to the WRONG channel (e.g. released as "listed" manually, then
    // re-run with --unlisted). Same channel → idempotent skip is safe; wrong
    // channel → hard stop so the caller picks a different version number.
    if (existing.channel !== CHANNEL) {
      // Same version in a DIFFERENT channel is allowed — listed and unlisted
      // are separate AMO pipelines. Warn and continue with the upload.
      console.warn(
        `release: WARNING — version ${VERSION} already exists on AMO as "${existing.channel}". ` +
          `Uploading to "${CHANNEL}" channel too (both channels will have this version).`,
      );
      return false;
    }
    return true;
  } catch (e) {
    if (e.message?.startsWith('release:')) throw e; // re-throw die() calls
    return false; // network error / 404 → version not on AMO yet
  }
}

async function uploadToAmo() {
  if (await versionAlreadyOnAmo()) {
    console.log(`release: version ${VERSION} already on AMO — skipping upload.`);
    return;
  }

  // 6a — upload the built bundle
  const fd = new FormData();
  fd.append('upload', fileBlob('dist.zip'), 'dist.zip');
  fd.append('channel', CHANNEL);
  const { uuid } = await amo('/addons/upload/', { method: 'POST', body: fd });
  console.log(`release: AMO upload uuid ${uuid} — waiting for validation…`);

  // 6b — poll until validated
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let status;
  do {
    await sleep(POLL_INTERVAL_MS);
    status = await amo(`/addons/upload/${uuid}/`);
    if (Date.now() > deadline) die('AMO validation timed out.');
  } while (!status.processed);
  if (!status.valid) {
    die(`AMO validation failed:\n${JSON.stringify(status.validation?.messages ?? status, null, 2)}`);
  }
  console.log('release: AMO validation passed.');

  // 6c — create the version with both note fields
  const version = await amo(`/addons/addon/${ADDON_GUID}/versions/`, {
    method: 'POST',
    json: {
      upload: uuid,
      release_notes: { 'en-US': releaseNotes },
      approval_notes: reviewerNotes,
    },
  });
  console.log(`release: created AMO version ${version.version} (id ${version.id}).`);

  // 6d — attach the source archive (separate multipart PATCH)
  const sfd = new FormData();
  sfd.append('source', fileBlob('source.zip'), 'source.zip');
  await amo(`/addons/addon/${ADDON_GUID}/versions/${version.id}/`, { method: 'PATCH', body: sfd });
  console.log('release: attached source.zip.');
}

await uploadToAmo();

// ---------------------------------------------------------------------------
// phase 7 — publish the branch + tag
// ---------------------------------------------------------------------------

// Resolve the remote from the branch's upstream (the remote is not always
// "origin" here). Fall back to the first configured remote.
function resolveRemote() {
  try {
    return capture('git rev-parse --abbrev-ref --symbolic-full-name @{u}').split('/')[0];
  } catch {
    const remotes = capture('git remote').split(/\r?\n/).filter(Boolean);
    if (!remotes.length) die('no git remote configured to push to.');
    return remotes[0];
  }
}

const remote = resolveRemote();
run(`git push ${remote} HEAD`);
// Push the lightweight tag explicitly — --follow-tags only pushes annotated tags.
run(`git push ${remote} ${TAG}`);

console.log(`\nrelease: ${TAG} done — uploaded to AMO and pushed.`);
