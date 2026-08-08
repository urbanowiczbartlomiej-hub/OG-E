// @ts-check

// EN mirror of ../galaxy-nav-panel.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'galaxy-nav-panel',
  category: 'other',
  locale: 'en',

  name: 'Galaxy navigation buttons',
  oneLiner:
    "Big, thumb-reachable arrows and galaxy/system inputs below the table — because the native header is about 16px tall on a phone.",
  order: 1,

  idea: [
    "The galaxy view is a desktop-first layout: switching galaxy/system, the arrows, and the Start / phalanx / spy / discovery buttons in the header render at roughly 16px tall on a phone — practically impossible to hit without zooming. The OG-E panel mirrors those same controls again, **below the system table**, with ~50px touch targets: galaxy and system steppers on the left/right, a \"Start\" button in the middle, and the rarer Phalanx/Spy/Discovery buttons tucked under a collapsible lid.",
    'The panel re-implements nothing — it **clicks the same native buttons and fields** that live in the header. The galaxy/system step nudges the native arrows (wrap-around and deuterium cost stay the game\'s own rules), and "Start" fills the native inputs and clicks the native submit. If a button is disabled in the header (e.g. phalanx unavailable on this body), the panel shows the same.',
  ],

  value: [
    "Without this panel, browsing several systems on a phone means constant pinch-zooming to hit a microscopic arrow, then panning back to the table. The panel keeps navigation within thumb's reach, right where you're already looking.",
  ],

  fairplay: {
    summary: [
      "The panel **adds no action that wasn't already in the header** — every button clicks the same native element you would press yourself. The request count to the game is identical to navigating by hand.",
      "Button state (enabled/disabled) is **copied from the header**, not recomputed — so it can never show anything the native UI isn't already saying.",
    ],
  },

  details: [
    'The same "Readability" switch in OG-E Settings (Display) turns this panel on and off.',
    "A separate, always-on fix: arrow keys inside a phalanx/spy/discovery dialog sometimes lose focus and hop a system twice instead of once — the panel corrects this independently of everything else.",
  ],

  screenshots: [
    { id: 'panel', caption: 'The navigation panel below the system table: galaxy/system steppers and the Start / Phalanx / Spy / Discovery buttons.' },
  ],

  codeRefs: [
    'src/features/galaxyNavPanel.js',
  ],

  status: 'drafted',
};
