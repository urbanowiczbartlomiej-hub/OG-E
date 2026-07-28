// Manifest invariants for the MAIN-world entry.
//
// Not a unit test of any module — a guard on one line of configuration that
// has already cost a release. `page.js` shipped as `document_idle` through
// 1.53.1, which made every bridge in this directory blind to the game's page
// INITIALISATION traffic: measured on a 13.0 universe, the game's own
// checkTarget fires at page+244 ms and the fleet1 submit that triggered the
// spent-token error at +644 ms, while DOMContentLoaded lands at +811 ms. The
// symptom (a fleet error the extension appeared to ignore) is nowhere near the
// cause (a run_at value), so it gets a test instead of a comment.
//
// See src/page.js's RUN_AT note and docs/ogame-fleet-mechanics.md.

import { describe, it, expect } from 'vitest';
import manifest from '../../manifest.json';

/** @param {string} file */
const scriptFor = (file) =>
  /** @type {any[]} */ (manifest.content_scripts).find(
    (cs) => Array.isArray(cs.js) && cs.js.includes(file),
  );

describe('manifest — content script timing', () => {
  it('runs the MAIN-world entry at document_start', () => {
    const page = scriptFor('page.js');
    expect(page).toBeDefined();
    expect(page.world).toBe('MAIN');
    expect(page.run_at).toBe('document_start');
  });

  it('runs the isolated-world entry at document_start', () => {
    expect(scriptFor('content.js').run_at).toBe('document_start');
  });
});
