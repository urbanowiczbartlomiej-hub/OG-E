# Contributing

Welcome. OG-E is a deliberately small codebase — six rules, a clean
workflow, and the rest falls out of the code itself. Read this once
and you're set.

## 1. Compliance comes first

**One user click → at most one HTTP request to the game server.**
This is not a guideline, it is the whole product's reason for
existing. We observe XHRs the game already fires (see `src/bridges/`)
and republish them as DOM events; we never call `fetch('/game/…')`,
we never inject synthetic XMLHttpRequests against the game.

No background cycles. No batch actions. No "one click, five fleets
out". No CAPTCHA / rate-limit circumvention.

Requests to user-controlled third-party services are fine: `api.github.com`
for cloud sync, `ntfy.sh` for fleet-landing reminders — both opt-in and
keyed by a token the user supplies. The rule above is specifically about
the **game server**: never originate traffic to it. `location.href = url`
in response to a single visible user click is fine.

When unsure, open an issue before the PR.

## 2. Purity where you can

`src/lib/` and `src/domain/` are **pure**: no DOM access, no storage,
no `Date.now()` without an explicit parameter. If your helper needs
any of those, it belongs in `src/state/` (for storage) or
`src/features/` (for DOM) instead.

Keeping that contract lets about 60 % of the codebase run in Node's
vitest with zero mocking. Breaking it is the fastest way to make
tests brittle, so the contract is enforced by taste, not by lint.

## 3. JSDoc + `@ts-check`

We ship vanilla JS, but every source file opens with `// @ts-check`
and every public function has `@param` / `@returns`. `npm run
typecheck` must exit 0 before each commit.

TypeScript is not required. Types are.

## 4. Tests where they earn their keep

- `src/domain/` and `src/lib/` — every helper has a test file in
  `test/domain/` or `test/lib/` (often ten-plus edge cases each).
- `src/features/` — happy-dom integration smoke tests, focused on
  wiring and regression catches.
- `src/bridges/` — happy-dom XHR shim; verify the dispatched DOM
  event payload is well-shaped.

We don't chase 100 % coverage. We chase **regression killers** and
**contract locks**.

## 5. Commit format

`fix:` / `feat:` / `chore:` / `docs:` / `refactor:` / `test:`
followed by a short imperative. Commit body explains **why**, not
**what** — the diff shows the what.

```
feat: lock Send Exp button on Sent!

Previously the button remained clickable after firing the dispatch,
letting a fast double-tap trigger two navigations. Lock + 3 s
safety-unlock (by which time the page has reloaded or the game
returned an error).
```

## 6. No new runtime dependencies

Vanilla JS and browser APIs, period. If you really need a library,
open an issue with the trade-off laid out (bundle cost, tree-shake
story, maintenance burden).

Dev dependencies (rollup, vitest, typescript) are fine and normal.

---

## Dev workflow

```bash
npm install
npm run dev           # rollup watch; rebuilds dist/ on save
npm run test          # vitest
npm run typecheck     # must exit 0
npm run build:prod    # production bundle — check the size
```

A change is ready when all three commands pass cleanly and you've
load-tested `dist/manifest.json` as a temporary add-on (Firefox) or
unpacked extension (Chrome) against a running OGame account.

## Test-in-game checklist

Before merging anything that touches DOM behaviour:

- Send Exp floating button visible, draggable, click dispatches.
- Send Col floating button visible, Scan subtext shows remaining count.
- Galaxy scan persists across reloads; histogram page shows pixels.
- Fresh-planet banner appears on a `usedFields === 0` colony.
- Abandon overlay appears on a colony under `colMinFields`.
- AGR settings menu contains the OG-E tab and it expands.
- Readability boost toggle flips the event-box styling on/off.

## Release workflow

The whole release is one command — `scripts/release.mjs`. It bumps the
version, runs tests + typecheck, builds and packages (**both** `dist.zip`
and the `source.zip` AMO requires for a minified bundle), commits, tags,
uploads to AMO (both reviewer-note fields + `source.zip`), and pushes the
tag. It is idempotent: re-running after a failure resumes from where it
stopped.

Do these by hand first:

1. Commit the release's code + tests under their own `fix:`/`feat:`
   commit, so the tree is clean except the files the script edits.
2. Write a dated `## [X.Y.Z] — YYYY-MM-DD` section in `CHANGELOG.md`
   (move `[Unreleased]` items into it) and **leave it uncommitted**.
   The script refuses to run without it and sends it verbatim as the
   public AMO release notes. **Never bump the version without it.**
3. Have `AMO_JWT_ISSUER` / `AMO_JWT_SECRET` in a gitignored `.env`
   (see `.env.example`).

Then:

```bash
npm run release -- X.Y.Z
```

To **preview** without publishing, run the script directly so the flag
actually arrives (npm swallows `--flags`, which has caused an accidental
real release): `node --env-file-if-exists=.env scripts/release.mjs X.Y.Z --preview`.

Before releasing anything that touches DOM behaviour, load
`dist/manifest.json` locally and spot-check the in-game checklist above
on both Firefox and Chrome. Chrome Web Store, if you publish there, still
takes a manual `dist.zip` upload.

## Contact

Open an issue. Please don't email.
