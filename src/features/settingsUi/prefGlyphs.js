// @ts-check

// Flat line glyphs for the preferences panel tiles (sections/preferences.js)
// — same sketch language as the FAB glyphs in shared/buttonGlyphs.js (0 0 64
// 64 viewBox, `currentColor` strokes, round caps) but deliberately FLAT: the
// radial `.oge-node` dome is reserved for FAB modules (a tile there previews
// an orb you toggle), while a preference is a plain switch, so it wears a
// plain sketch. Local to settingsUi — the panel is the only consumer (the
// "Who's spying" tile reuses the shared EYE_GLYPH, which belongs to the spy
// family in buttonGlyphs.js).
//
// Each glyph is LITERAL about its feature: the markers glyph is a planet with
// the three badge dots the feature actually paints; the trader glyph is a
// coin with a returning arc (the recurring trader event), etc.

/** Auto next planet — planet with double chevrons onward (autoRedirectExpedition). */
export const NEXT_PLANET_GLYPH = [
  '<g fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">',
  '<circle cx="17" cy="32" r="10"/>',
  '<path d="M11.5 28.5 Q17 26 22.5 28.5" stroke-width="2.6"/>',
  '<path d="M33 24 l8 8 -8 8"/>',
  '<path d="M42 24 l8 8 -8 8"/>',
  '</g>',
].join('');

/** Readability boost — a block of text lines (readabilityBoost). */
export const READABILITY_GLYPH = [
  '<g fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round">',
  '<path d="M14 18 h36"/>',
  '<path d="M14 28 h26"/>',
  '<path d="M14 38 h32"/>',
  '<path d="M14 48 h20"/>',
  '</g>',
].join('');

/** Planet markers — planet plus the three badge dots the feature paints (expeditionBadges). */
export const PLANET_MARKERS_GLYPH = [
  '<g fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round">',
  '<circle cx="26" cy="32" r="12"/>',
  '<path d="M18 28 Q26 24.5 34 28" stroke-width="2.6"/>',
  '<circle cx="47" cy="20" r="3.2" fill="currentColor" stroke="none"/>',
  '<circle cx="47" cy="32" r="3.2" fill="currentColor" stroke="none"/>',
  '<circle cx="47" cy="44" r="3.2" fill="currentColor" stroke="none"/>',
  '</g>',
].join('');

/** Event pulse — a dot radiating pulse arcs (eventMenuHighlight). */
export const EVENT_PULSE_GLYPH = [
  '<g fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round">',
  '<circle cx="24" cy="40" r="5" fill="currentColor" stroke="none"/>',
  '<path d="M33 31 a13 13 0 0 1 4 9"/>',
  '<path d="M40 24 a23 23 0 0 1 7 16"/>',
  '</g>',
].join('');

/** Trader pulse — a coin with a returning arc (the recurring trader event; traderMenuHighlight). */
export const TRADER_PULSE_GLYPH = [
  '<g fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">',
  '<circle cx="26" cy="38" r="11"/>',
  '<path d="M26 32 v12 M22.5 35 h7" stroke-width="2.6"/>',
  '<path d="M37 20 a11 11 0 0 1 11 11"/>',
  '<path d="M44 14 l4 6 -7 2"/>',
  '</g>',
].join('');

/** Attack banner — a crosshair (threatHighlight). */
export const ATTACK_BANNER_GLYPH = [
  '<g fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round">',
  '<circle cx="32" cy="32" r="12"/>',
  '<circle cx="32" cy="32" r="2.6" fill="currentColor" stroke="none"/>',
  '<path d="M32 12 v8 M32 44 v8 M12 32 h8 M44 32 h8"/>',
  '</g>',
].join('');
