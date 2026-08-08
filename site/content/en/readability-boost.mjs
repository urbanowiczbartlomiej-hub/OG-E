// @ts-check

// EN mirror of ../readability-boost.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'readability-boost',
  category: 'game-ui',
  locale: 'en',

  name: 'Readability',
  oneLiner:
    'Trims verbose labels in the top game bar so the numbers that actually matter on a small screen get bigger and easier to read.',
  order: 2,

  idea: [
    'The fleet-event box shows three pieces of information by default (mission count, next mission type + target, countdown), but wraps them in labels ("Missions:", "Next:", "Type:") that eat more space than the payload. Readability collapses those labels to zero, tucks the box under the AGR header, and anchors the countdown full-size on the right, with the rest in a left column that reserves a gutter so a long mission name never slides under the timer.',
    "The same treatment reaches the fleet-movement link in the fleetdispatch header: the green colour lands only on the link itself (not its children), so the native red 'expedition limit reached' indicator inside it keeps working as intended.",
  ],

  value: [
    "On a phone, AGR/OGame's native layout squeezes the same information into space designed for desktop — labels eat the room the numbers should have. Readability gives that space back to the numbers, so the countdown to your next mission and your slot status are readable without squinting.",
  ],

  fairplay: {
    summary: [
      'This is purely **CSS on already-displayed elements** — no number or label is swapped for a different value, only restyled. Theme colours stay the game\'s own; only layout and size change.',
      'On by default, but one switch in Settings turns everything off at once — with no flash of unstyled content at page start.',
    ],
  },

  details: [
    'Covers the fleet-event box (`#eventboxFilled`) and the fleet-movement link in the fleetdispatch header.',
    'The same switch also reveals the galaxy navigation panel (see "Navigation buttons" in the "Other" chapter).',
    'Toggled in the OG-E Settings panel, the "Readability" tile.',
  ],

  screenshots: [
    { id: 'eventbox', caption: 'The fleet-event box before and after trimming its labels.' },
  ],

  codeRefs: [
    'src/features/readabilityBoost.js',
  ],

  status: 'drafted',
};
