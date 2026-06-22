import { defineConfig } from 'vitest/config';

// Minimal config: wires the shared test setup and a coverage provider. The
// environment is still chosen per file via `// @vitest-environment happy-dom`
// comments (default is node), so this doesn't change how any suite runs.
//
// Coverage is opt-in (`npm run coverage`) — the default `npm run test` stays
// fast and uninstrumented. It exists so the release-time test reconciliation
// (see CLAUDE.md "Tests are reconciled once, at release time") can be checked
// against a number instead of memory: run it before bumping the version to see
// which changed modules went untested. No threshold is enforced (the deferred-
// tests policy makes a hard gate counterproductive); the summary is the signal.
export default defineConfig({
  test: {
    setupFiles: ['./test/setup.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html'],
      include: ['src/**/*.js'],
      // Entry/wiring bundles are install-order glue with no branching logic —
      // excluding them keeps the summary focused on behavioral coverage.
      exclude: ['src/content.js', 'src/page.js', 'src/dashboard.js'],
    },
  },
});
