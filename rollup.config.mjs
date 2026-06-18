// Rollup configuration — three IIFE bundles, one per execution context:
//   src/content.js → dist/content.js   (extension isolated world)
//   src/page.js    → dist/page.js      (MAIN world, shares game's JS realm)
//   src/dashboard.js → dist/dashboard.js (extension page, own origin)
//
// Outputs are single-file IIFE — manifest content_scripts load them directly.
// No CommonJS, no node resolution: OG-E has zero runtime dependencies.
// Production builds (NODE_ENV=production) are minified with terser; dev builds
// keep sourcemaps.

import terser from '@rollup/plugin-terser';

const isProd = process.env.NODE_ENV === 'production';

/** @param {string} input  @param {string} file */
const bundle = (input, file) => ({
  input,
  output: {
    file,
    format: 'iife',
    sourcemap: !isProd,
  },
  plugins: isProd
    ? [
        terser({
          compress: { drop_console: true, drop_debugger: true, passes: 2 },
          format: { comments: false },
        }),
      ]
    : [],
});

export default [
  bundle('src/content.js', 'dist/content.js'),
  bundle('src/page.js', 'dist/page.js'),
  bundle('src/dashboard.js', 'dist/dashboard.js'),
];
