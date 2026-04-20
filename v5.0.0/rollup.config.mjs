// Rollup configuration — three IIFE bundles, one per execution context:
//   src/content.js → dist/content.js   (extension isolated world)
//   src/page.js    → dist/page.js      (MAIN world, shares game's JS realm)
//   src/histogram.js → dist/histogram.js (extension page, own origin)
//
// Outputs are single-file IIFE — manifest content_scripts load them directly.
// No CommonJS, no node resolution: v5 has zero runtime dependencies.
//
// @rollup/plugin-replace injects the manifest version as `__OGE_VERSION__`
// so the source never hardcodes a version number.

import replace from '@rollup/plugin-replace';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('./manifest.json', 'utf-8'));
const isProd = process.env.NODE_ENV === 'production';

/** @param {string} input  @param {string} file */
const bundle = (input, file) => ({
  input,
  output: {
    file,
    format: 'iife',
    sourcemap: !isProd,
  },
  plugins: [
    replace({
      preventAssignment: true,
      values: {
        __OGE_VERSION__: JSON.stringify(manifest.version),
      },
    }),
  ],
});

export default [
  bundle('src/content.js', 'dist/content.js'),
  bundle('src/page.js', 'dist/page.js'),
  bundle('src/histogram.js', 'dist/histogram.js'),
];
