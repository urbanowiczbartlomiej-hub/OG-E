// @ts-check

// Background "watermark" glyphs for the floating buttons — one monochrome
// line-sketch per command concept, painted faintly BEHIND the label as a
// glanceability cue (see decorateButton's `.oge-art` layer in
// buttonChrome.js). These are NOT the game's DOM contract: they are OG-E's
// own decorative surface, so they live next to the buttons that emit them.
//
// Each value is the INNER markup of a `0 0 64 64` SVG (the wrapping <svg>
// is added by appendGlyph). The source art shipped with hard colours
// (#1F2A44 strokes, #FFB703 accents); here every paint is normalised to
// `currentColor` so the glyph tints to the zone's `--rim` automatically and
// "self-mutes" with the state colour instead of fighting it. Keep them as
// simple silhouettes — no gradients, no per-glyph palette to maintain.
//
// Assigned per ZONE (ZoneConfig.glyph) rather than per button: a single
// centred glyph reads cleanly on a 1-zone circle, so split buttons only
// carry one on the zone where it actually means something.

/** Expedition — comet with a tail and two sparks (sendExpedition). */
export const COMET_GLYPH = [
  '<g fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" transform="translate(32,32) scale(1.15) translate(-32,-32)">',
  '<line x1="35" y1="29" x2="10" y2="54"/>',
  '<line x1="40" y1="35" x2="24" y2="51"/>',
  '<line x1="29" y1="24" x2="17" y2="36"/>',
  '<circle cx="44" cy="20" r="9" fill="currentColor"/>',
  '<path d="M55 40 v6 M52 43 h6"/>',
  '<path d="M14 16 v5 M11.5 18.5 h5"/>',
  '</g>',
].join('');

/** Colonization — a landing craft with legs and feet (sendColony). */
export const LANDER_GLYPH = [
  // Native art sits low (y≈27–53) and narrow, so it read smaller than the
  // other glyphs. Scale up ~1.3 about its own bbox centre (32,40) and recentre
  // on the 64-grid so it fills the node / menu orb like the rest.
  '<g fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" transform="translate(32,32) scale(1.3) translate(-32,-40)">',
  '<path d="M20 41 V27 a12 12 0 0 1 24 0 V41 Z"/>',
  '<circle cx="32" cy="29" r="4.5" fill="currentColor"/>',
  '<line x1="23" y1="41" x2="15" y2="53"/>',
  '<line x1="41" y1="41" x2="49" y2="53"/>',
  '<line x1="10" y1="53" x2="20" y2="53"/>',
  '<line x1="44" y1="53" x2="54" y2="53"/>',
  '</g>',
].join('');

/** Daily run — home planet with a flight arc to a neighbour (dailyRun). */
export const PLANET_ARROW_GLYPH = [
  '<g fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">',
  '<circle cx="18" cy="45" r="11"/>',
  '<path d="M12.5 41.5 Q18 39 23.5 41.5" stroke-width="2.5"/>',
  '<path d="M29.5 36 Q39 34 44 21"/>',
  '<path d="M45.5 28 L44 21 L38.1 25.2"/>',
  '<circle cx="52" cy="11" r="6" fill="currentColor"/>',
  '</g>',
].join('');

/** Lifeforms — a DNA double helix with four rungs (sendLifeform). */
export const DNA_GLYPH = [
  '<g fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" transform="translate(32,32) rotate(45) scale(1.15) translate(-32,-32)">',
  '<line x1="25" y1="14" x2="39" y2="14"/>',
  '<line x1="29" y1="22" x2="35" y2="22"/>',
  '<line x1="29" y1="42" x2="35" y2="42"/>',
  '<line x1="25" y1="50" x2="39" y2="50"/>',
  '<path d="M23 7 C23 20 41 24 41 32 C41 40 23 44 23 57"/>',
  '<path d="M41 7 C41 20 23 24 23 32 C23 40 41 44 41 57"/>',
  '</g>',
].join('');
