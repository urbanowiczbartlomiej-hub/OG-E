// Flat ESLint config (ESM, matches the repo's module style).
//
// Purpose: turn the prose layering invariants in CLAUDE.md into mechanical,
// un-violable checks. The dependency direction is:
//
//   domain  ←  state  ←  features / sync
//     ↑          ↑            ↑
//     └──────── lib (foundation, zero app deps) ───────┘
//   bridges → lib + domain only (MAIN-world; must NOT import state/)
//
// We enforce the arrows with `import/no-restricted-paths` zones, plus a
// `no-restricted-globals` rule that keeps `domain/` free of DOM/timer/chrome
// access. bridges/ may import lib/ + pure domain/ only (domain is
// side-effect-free, safe across the MAIN/isolated world boundary); the zone
// forbids state/features/sync. (Landed across tasks I1 + I3.)

import fs from 'node:fs';
import js from '@eslint/js';
import globals from 'globals';
import importPlugin from 'eslint-plugin-import';

// Build the cross-feature restriction zones programmatically. Every feature
// — a subdirectory OR a top-level file under src/features — may import from
// domain/state/lib/sync and from features/shared, but NOT from a sibling
// feature. `shared` is the common helper and is exempt (it may be imported by
// anyone; it is not itself targeted).
const featuresDir = 'src/features';
const featureNames = fs
  .readdirSync(featuresDir, { withFileTypes: true })
  .filter((e) => e.name !== 'shared')
  .map((e) => e.name);

// `except` paths in import/no-restricted-paths are resolved relative to the
// zone's `from` directory — so a feature is allowed to import its own siblings
// (`./<name>`) and anything in `./shared`, but nothing else under features/.
const crossFeatureZones = featureNames.map((name) => ({
  target: `./src/features/${name}`,
  from: './src/features',
  except: [`./${name}`, './shared'],
  message:
    'A feature must not import another feature (CLAUDE.md invariant). ' +
    'Put shared logic in features/shared or lib/.',
}));

export default [
  {
    // Generated/vendored output and tooling caches are never linted. `.claude/`
    // is gitignored per-project state (Claude Code's worktrees + their own built
    // `dist/`); a nested worktree's `dist/**` isn't caught by the root `dist/**`
    // glob, so ignore the whole dir or `eslint .` lints thousands of bundled lines.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '**/*.min.js', '.claude/**'],
  },

  js.configs.recommended,

  // ---- Application source (isolated- and MAIN-world browser code) ----
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
    },
    plugins: { import: importPlugin },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // The codebase annotates per-file browser/webextension globals with
      // `/* global ... */` directives; those names are also in our configured
      // globals, so don't treat the annotation as a redeclaration.
      'no-redeclare': ['error', { builtinGlobals: false }],
      // App code routes logging through lib/logger (which holds the single
      // sanctioned console sink). Raw console.* elsewhere must opt out with an
      // explicit eslint-disable — this keeps those opt-outs meaningful rather
      // than stale. (Not applied to tests/scripts, which use console freely.)
      'no-console': 'error',
      'import/no-unresolved': 'error',
      'import/no-cycle': 'error',
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            // domain/ is pure logic — it may not depend on any app layer.
            {
              target: './src/domain',
              from: ['./src/state', './src/features', './src/sync', './src/bridges'],
              message:
                'domain/ is pure logic and must not import state/features/sync/bridges (CLAUDE.md invariant).',
            },
            // lib/ is the dependency-free foundation.
            {
              target: './src/lib',
              from: [
                './src/domain',
                './src/state',
                './src/features',
                './src/sync',
                './src/bridges',
              ],
              message:
                'lib/ is the zero-app-dep foundation and must not import from any app layer (CLAUDE.md invariant).',
            },
            // bridges/ are MAIN-world observers — no chrome.*, no isolated-
            // world layers. They may import lib/ and pure domain/ only (domain
            // is side-effect-free, so it is safe across the world boundary);
            // state/features/sync are forbidden. Shared key strings live in
            // lib/storageKeys.js (task I1).
            {
              target: './src/bridges',
              from: ['./src/state', './src/features', './src/sync'],
              message:
                'bridges/ run in the MAIN world (no chrome.*) and may import only lib/ + pure ' +
                'domain/ — not state/features/sync. Put shared constants in lib/ (CLAUDE.md invariant).',
            },
            // No feature imports another feature.
            ...crossFeatureZones,
          ],
        },
      ],
    },
  },

  // ---- domain/ purity: no DOM, no timers, no storage, no chrome.* ----
  {
    files: ['src/domain/**/*.js'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'document',
          message: 'domain/ must be pure — no DOM access (CLAUDE.md invariant).',
        },
        {
          name: 'window',
          message: 'domain/ must be pure — no DOM/window access (CLAUDE.md invariant).',
        },
        {
          name: 'localStorage',
          message: 'domain/ must be pure — no storage access (CLAUDE.md invariant).',
        },
        {
          name: 'chrome',
          message: 'domain/ must be pure — no chrome.* access (CLAUDE.md invariant).',
        },
        {
          name: 'setTimeout',
          message: 'domain/ must be pure — no timers (CLAUDE.md invariant).',
        },
        {
          name: 'setInterval',
          message: 'domain/ must be pure — no timers (CLAUDE.md invariant).',
        },
      ],
    },
  },

  // ---- Tests (vitest + happy-dom) ----
  {
    files: ['test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },

  // ---- Żywe demo na stronie docs (kod PRZEGLĄDARKOWY, nie Node) ----
  //
  // `site/live/*.js` to wejścia, które uruchamiają prawdziwe moduły z `src/`
  // na opublikowanej stronie (patrz site/live/fab-playground.js). Nie są
  // częścią rozszerzenia, więc nie obowiązują ich strefy importów z `src/**`
  // — wolno im ciągnąć features + state + lib, dokładnie jak `content.js`.
  {
    files: ['site/live/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },

  // ---- Build/release tooling (Node, ESM) ----
  {
    files: ['scripts/**/*.{js,mjs}', 'site/**/*.mjs', '*.config.{js,mjs}', 'eslint.config.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];
