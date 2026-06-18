import { defineConfig } from 'vitest/config';

// Minimal config: the only thing it wires is the shared test setup. The
// environment is still chosen per file via `// @vitest-environment happy-dom`
// comments (default is node), so this doesn't change how any suite runs.
export default defineConfig({
  test: {
    setupFiles: ['./test/setup.js'],
  },
});
