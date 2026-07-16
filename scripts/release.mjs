// Release orchestrator for AMO (addons.mozilla.org) — ONE flagless command,
// TWO ways to invoke it. There is nothing to remember beyond the version:
//
//   npm run release 1.25.1
//
// The same script serves both release paths because it auto-detects its
// situation instead of taking flags:
//
//   • MANUAL (local, with .env creds): run on the `main` branch. Bumps the
//     version, commits + tags vX.Y.Z, uploads to AMO via the API, and pushes
//     the branch + tag. The whole release, from your machine.
//
//   • CI (GitHub Action, on push to main): release.yml mints + pushes the
//     vX.Y.Z tag, checks it out, and runs this same script. HEAD is detached
//     and the tag already exists, so it SKIPS the commit/tag and the push, and
//     just uploads. This is the path we actually use — we never push tags by
//     hand; the local path above is a break-glass fallback.
//
// The two paths never collide: an upload is skipped if the version is already
// on AMO, the commit/tag is skipped if the tag exists, and the push is skipped
// when HEAD is detached (CI) — all detected, no flags. So if a break-glass
// local release publishes first, the push-to-main that lands the same commit
// makes CI's run a clean no-op (the tag already exists → release.yml skips).
//
// Phases (each guarded so a re-run after a failure resumes cleanly):
//   0. parse version; require a clean tree EXCEPT CHANGELOG/package/manifest
//      (those are the release's own edits) — only when creating the tag
//   1. validate the dated CHANGELOG section; extract it as the public release
//      notes; read the reviewer notes
//   2. npm run test + npm run typecheck
//   3. write the version into package.json AND manifest.json
//   4. npm run package → dist.zip + source.zip (hard-assert both)
//   5. git commit (CHANGELOG + package + manifest) + tag vX.Y.Z, LOCAL
//      (skipped if the tag already exists)
//   6. upload to AMO (skipped if no creds, or the version is already there)
//   6b. upload to the Chrome Web Store (skipped if no creds, or already up) —
//      the SAME dist/, Firefox-only manifest keys stripped; runs AFTER AMO so a
//      CWS-side failure never blocks the primary store
//   7. git push branch + tag (skipped when HEAD is detached / tag on remote)
//
// Why git stays local until AMO accepts (5 before 6, push in 7): if AMO
// rejects the archive we must not leave a pushed tag pointing at a release
// that does not exist. Everything is reversible locally until the upload in 6.
//
// Secrets (never in the repo — see .gitignore / .env.example):
//   AMO_JWT_ISSUER      — "JWT issuer" from the AMO API-key page
//   AMO_JWT_SECRET      — "JWT secret" from the same page
//   CWS_CLIENT_ID       — Google OAuth client id (Chrome Web Store API enabled)
//   CWS_CLIENT_SECRET   — that client's secret
//   CWS_REFRESH_TOKEN   — a refresh token minted once against that client
//   CWS_EXTENSION_ID    — the existing Chrome Web Store item id
// `npm run release` loads a local .env automatically (--env-file-if-exists);
// the GitHub Action injects them from repo secrets. Each store's upload is
// skipped independently when its creds are absent (the bump/commit/tag/push
// still run) — so a credential-less machine can still cut the tag and let CI
// publish it.

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { uploadToAmo } from './amo.mjs';
import { uploadToCws } from './cws.mjs';
import { buildChromeZip } from './chromeZip.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const ADDON_GUID = 'og-e@ogame-extensions'; // manifest browser_specific_settings.gecko.id

// The files the release itself writes + commits (phases 3 + 5). A pending edit
// to any of these is EXPECTED — the CHANGELOG section is the one manual step
// and the two version files are bumped here — so they're excluded from the
// clean-tree gate. Code + tests live in their own commit(s); the CHANGELOG
// entry lands together with the version bump in the single `chore(release)`
// commit the tag points at (no transient commit where the two disagree).
const RELEASE_FILES = new Set(['CHANGELOG.md', 'package.json', 'manifest.json']);
const AMO_RELEASE_NOTES_MAX = 3000; // AMO 400s a version POST with a longer body

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

// ---------------------------------------------------------------------------
// phase 0 — version + clean tree (clean EXCEPT the release files)
// ---------------------------------------------------------------------------

const VERSION = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!VERSION) die('usage: npm run release -- <X.Y.Z>');
if (!/^\d+\.\d+\.\d+$/.test(VERSION)) die(`not a semver version: "${VERSION}"`);
const TAG = `v${VERSION}`;

const tagExists = capture(`git tag -l ${TAG}`) === TAG;

if (!tagExists) {
  // `git status --porcelain` lines are "XY <path>"; the path starts at col 3.
  // A pending edit to a RELEASE_FILES entry is expected (we commit it below);
  // anything else dirty means the code/tests aren't committed yet — refuse, so
  // the release commit stays a clean CHANGELOG + version bump. Read RAW (not
  // capture(), which trims the leading space of " M CHANGELOG.md" and shifts
  // the path), splitting only on newlines.
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
// phase 1 — CHANGELOG + reviewer notes + credentials
// ---------------------------------------------------------------------------

function extractChangelogSection(version) {
  const text = readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf8');
  // Header: "## [1.25.0] — 2026-06-18". Body runs to the next "## ". The
  // separator accepts an em-dash (—), en-dash (–) or hyphen (-) so a dash-typo
  // in the header can't silently abort the release (the CI guard in
  // .github/workflows/release.yml mirrors this).
  const escaped = version.replace(/\./g, '\\.');
  const re = new RegExp(
    `^## \\[${escaped}\\]\\s+[—–-]\\s+(\\d{4}-\\d{2}-\\d{2})\\s*$([\\s\\S]*?)(?=^## )`,
    'm',
  );
  const m = text.match(re);
  if (!m) {
    die(
      `no dated "## [${version}] — YYYY-MM-DD" section in CHANGELOG.md.\n` +
        '       Write the release notes there first (this is the one manual step).',
    );
  }
  const body = m[2].trim();
  if (!body) die(`CHANGELOG section for ${version} is empty.`);
  return { date: m[1], body };
}

// The CHANGELOG section is the full permanent record (a big release can run
// past AMO's 3000-char release_notes cap). Keep it intact on disk; cap only the
// copy SENT to AMO, cut at a line boundary (never mid-bullet) with a pointer.
function capReleaseNotes(notes) {
  if (notes.length <= AMO_RELEASE_NOTES_MAX) return notes;
  const footer = '\n\n…(truncated — see the full CHANGELOG on GitHub.)';
  let cut = notes.slice(0, AMO_RELEASE_NOTES_MAX - footer.length);
  const lastBreak = cut.lastIndexOf('\n');
  if (lastBreak > 0) cut = cut.slice(0, lastBreak);
  return cut.trimEnd() + footer;
}

const { date: changelogDate, body: rawReleaseNotes } = extractChangelogSection(VERSION);
const releaseNotes = capReleaseNotes(rawReleaseNotes);
if (releaseNotes !== rawReleaseNotes) {
  console.warn(
    `release: CHANGELOG section is ${rawReleaseNotes.length} chars — over AMO's ` +
      `${AMO_RELEASE_NOTES_MAX}-char limit; sending a truncated copy.`,
  );
}

const reviewerNotesPath = resolve(ROOT, 'docs', 'amo-reviewer-notes.txt');
if (!existsSync(reviewerNotesPath)) {
  die('amo-reviewer-notes.txt is missing — it holds the AMO "Notes to Reviewer".');
}
const reviewerNotes = readFileSync(reviewerNotesPath, 'utf8').trim();
if (!reviewerNotes) die('amo-reviewer-notes.txt is empty.');

const JWT_ISSUER = process.env.AMO_JWT_ISSUER;
const JWT_SECRET = process.env.AMO_JWT_SECRET;
const haveCreds = !!(JWT_ISSUER && JWT_SECRET);

const CWS_CLIENT_ID = process.env.CWS_CLIENT_ID;
const CWS_CLIENT_SECRET = process.env.CWS_CLIENT_SECRET;
const CWS_REFRESH_TOKEN = process.env.CWS_REFRESH_TOKEN;
const CWS_EXTENSION_ID = process.env.CWS_EXTENSION_ID;
const haveCwsCreds = !!(CWS_CLIENT_ID && CWS_CLIENT_SECRET && CWS_REFRESH_TOKEN && CWS_EXTENSION_ID);

console.log(`release: ${TAG}  (CHANGELOG dated ${changelogDate})`);

// ---------------------------------------------------------------------------
// phase 2 — tests
// ---------------------------------------------------------------------------

run('npm run test');
run('npm run typecheck');

// ---------------------------------------------------------------------------
// phases 3–5 — bump, package, local git (commit/tag skipped if tag exists)
// ---------------------------------------------------------------------------

function bumpVersionFile(file) {
  const path = resolve(ROOT, file);
  const text = readFileSync(path, 'utf8');
  if (!/"version":\s*"/.test(text)) die(`could not find a "version" field to bump in ${file}`);
  writeFileSync(path, text.replace(/("version":\s*")[^"]+(")/, `$1${VERSION}$2`));
  console.log(`release: bumped ${file} → ${VERSION}`);
}

// phase 3 — bump (idempotent: writes the same version on a resume / in CI)
bumpVersionFile('package.json');
bumpVersionFile('manifest.json');

// phase 4 — ALWAYS package. The AMO upload needs dist.zip/source.zip, and a CI
// checkout doesn't persist them between runs — so rebuild even when resuming.
run('npm run package');
for (const f of ['dist.zip', 'source.zip']) {
  if (!existsSync(resolve(ROOT, 'release', f))) die(`${f} was not produced by npm run package.`);
}

// phase 5 — local commit + tag, skipped on resume / in CI (tag already exists).
if (tagExists) {
  console.log(`release: ${TAG} already exists — re-packaged, skipping commit/tag.`);
} else {
  run('git add CHANGELOG.md package.json manifest.json');
  run(`git commit --allow-empty -m "chore(release): ${VERSION}"`);
  run(`git tag ${TAG}`);
}

// ---------------------------------------------------------------------------
// phase 6 — AMO upload (skipped without creds, or if the version is on AMO).
// The API client lives in ./amo.mjs; here we just wire the creds + artifacts
// in and turn a thrown failure into a clean abort BEFORE the push in phase 7.
// ---------------------------------------------------------------------------

if (haveCreds) {
  try {
    await uploadToAmo({
      guid: ADDON_GUID,
      version: VERSION,
      issuer: JWT_ISSUER,
      secret: JWT_SECRET,
      distZip: resolve(ROOT, 'release', 'dist.zip'),
      sourceZip: resolve(ROOT, 'release', 'source.zip'),
      releaseNotes,
      reviewerNotes,
      log: (m) => console.log(`release: ${m}`),
    });
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }
} else {
  console.log('release: no AMO creds in the env — skipping upload (push the tag and CI will publish).');
}

// ---------------------------------------------------------------------------
// phase 6b — Chrome Web Store upload (skipped without creds, or if already up).
// Built from the SAME dist/ as AMO — buildChromeZip strips the Firefox-only
// manifest keys — so both stores ship the identical extension. Runs AFTER the
// AMO upload so a CWS-side failure never blocks the primary store, and (like
// AMO) turns a thrown failure into a clean abort BEFORE the push in phase 7.
// The chrome zip is rebuilt here because a CI checkout doesn't persist it.
// ---------------------------------------------------------------------------

let cwsResult = null;
if (haveCwsCreds) {
  const chromeZip = resolve(ROOT, 'release', `og-e-chrome-${VERSION}.zip`);
  if (existsSync(chromeZip)) rmSync(chromeZip);
  try {
    buildChromeZip(resolve(ROOT, 'dist'), chromeZip);
    cwsResult = await uploadToCws({
      itemId: CWS_EXTENSION_ID,
      clientId: CWS_CLIENT_ID,
      clientSecret: CWS_CLIENT_SECRET,
      refreshToken: CWS_REFRESH_TOKEN,
      version: VERSION,
      zip: chromeZip,
      log: (m) => console.log(`release: ${m}`),
    });
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }
} else {
  console.log('release: no Chrome Web Store creds in the env — skipping CWS upload.');
}

// A human-readable summary of which stores this run actually shipped to. CWS
// only counts when it truly uploaded — a 'skipped' (item busy / already up) is
// not a shipment, so the summary doesn't over-claim.
const cwsShipped = cwsResult === 'published' || cwsResult === 'draft';
const stores = [haveCreds && 'AMO', cwsShipped && 'Chrome Web Store'].filter(Boolean);
const uploadedTail = stores.length ? ` — uploaded to ${stores.join(' + ')}.` : '.';

// ---------------------------------------------------------------------------
// phase 7 — publish branch + tag (skipped when HEAD is detached, e.g. in CI)
// ---------------------------------------------------------------------------

// In CI the tag is checked out with a detached HEAD, so there is no branch to
// push and the tag is already on the remote — nothing to publish. Locally we
// are on `main`, so push it.
const branch = capture('git rev-parse --abbrev-ref HEAD');
if (branch === 'HEAD') {
  console.log(`release: detached HEAD — skipping push (${TAG} is already on the remote).`);
  console.log(`\nrelease: ${TAG} done${uploadedTail}`);
  process.exit(0);
}

// Resolve the remote from the branch's upstream (not always "origin"); fall
// back to the first configured remote.
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
// Push the lightweight tag explicitly (--follow-tags only pushes annotated
// ones). Skip if already on the remote (resume).
if (capture(`git ls-remote --tags ${remote} ${TAG}`).trim() !== '') {
  console.log(`release: ${TAG} already on ${remote} — skipping tag push.`);
} else {
  run(`git push ${remote} ${TAG}`);
}

console.log(`\nrelease: ${TAG} done${uploadedTail.replace(/\.$/, '')}${stores.length ? ' and ' : ''}pushed (CI publishes the tag).`);
