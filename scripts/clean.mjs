// Pre-build step: nuke `dist/` so production builds cannot pick up
// stale artifacts from earlier runs (old bundles, legacy zips, a
// previous version's manifest, etc). Keeps `npm run package` and the
// AMO / CWS upload flow honest — whatever ships is what THIS build
// produced, nothing more.
//
// Idempotent: missing `dist/` is not an error.

import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const DIST = resolve(import.meta.dirname, '..', 'dist');
rmSync(DIST, { recursive: true, force: true });
console.log('clean: removed dist/');
