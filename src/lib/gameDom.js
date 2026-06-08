// Single source of truth for the EXTERNAL DOM contract OG-E reads from.
//
// OG-E is a parasite on two HTML surfaces it does not control:
//
//   • OGame's native markup (`#planetList`, `.planet-koords`, the event
//     list rows, the planet-detail fields …), and
//   • AntiGameReborn (AGR), whose injected markup OG-E also leans on.
//
// These class names and ids are the single most fragile thing in the
// codebase: a game or AGR update that renames one of them silently
// breaks whichever feature reads it. Before this module those strings
// were copy-pasted across a dozen feature files, so a rename meant a
// grep-and-pray edit in six places. Centralising the *shared* ones (the
// selectors read by 2+ features) means a game change is a one-line edit
// here.
//
// SCOPE — what belongs in this file and what does not:
//
//   ✓ OGame / AGR selectors read by TWO OR MORE features. That is the
//     duplication this module exists to kill.
//   ✗ Selectors used by exactly ONE feature stay local to that feature
//     (e.g. the abandon-flow ids `#giveupCoordinates` / `#validate`, the
//     settings-tab `.ago_menu_tab_*` classes). Hoisting a single-use
//     string here only adds indirection — a change still touches one
//     file either way.
//   ✗ OG-E's OWN injected ids/classes (the dashboard's `#chart`,
//     `#statsContainer`; our `oge-*` / badge classes). Those are not a
//     contract with anyone else — they live next to the code that emits
//     them.
//
// Quirks worth knowing (kept verbatim — these are the game's spellings,
// not ours):
//   • `hightlightPlanet`  — OGame's own misspelling of "highlight".
//   • `planet-koords`     — OGame's German-flavoured spelling of "coords".

/** @ts-check */

/**
 * The active (currently selected) planet carries this class in the left
 * planet bar. Exposed as a bare class name because some call sites need
 * `classList.contains(...)` rather than a selector.
 * NB: the misspelling is the game's, not a typo here.
 */
export const ACTIVE_PLANET_CLASS = 'hightlightPlanet';

/**
 * Shared OGame-native selectors, grouped by the surface they live on.
 * Compose relative ones with `el.querySelector(...)` against a row/planet
 * node; absolute ones (those starting with `#`) against `document`.
 */
export const GAME = {
  // ── Left planet bar ────────────────────────────────────────────────
  PLANET_LIST: '#planetList',
  /** All planet+moon entries in the bar. */
  SMALL_PLANET: '#planetList .smallplanet',
  /** Only real planets (moons lack the `planet-<id>` id). */
  SMALL_PLANET_ONLY: '#planetList .smallplanet[id^="planet-"]',
  /** The active planet entry. See {@link ACTIVE_PLANET_CLASS}. */
  ACTIVE_PLANET: `#planetList .${ACTIVE_PLANET_CLASS}`,
  /** Anchor inside a `.smallplanet` row. */
  PLANET_LINK: '.planetlink',
  /** Name span inside a planet link. */
  PLANET_NAME: '.planet-name',
  /** Coordinate span inside a planet link, e.g. "[4:30:8]". */
  PLANET_KOORDS: '.planet-koords',

  // ── Event list (`#eventContent`) ───────────────────────────────────
  EVENT_CONTENT: '#eventContent',
  /** One fleet movement row, keyed by its `eventRow-<n>` id. */
  EVENT_FLEET_ROWS: '#eventContent tr.eventFleet[id^="eventRow-"]',
  /** Origin-coordinate cell, present on most fleet rows. */
  COORDS_ORIGIN: '.coordsOrigin',

  /**
   * Destination-coords cell of an event-ticker fleet row. The anchor's
   * href carries only `galaxy`+`system`, but its text is the full
   * `[g:s:p]` — parse the position from the text. Read by the reminders
   * feature (where an outbound leg lands) and by `features/fsCollect`
   * (which targets already have an inbound Deployment fleet).
   */
  COORDS_DEST: '.destCoords',
  /** Fleet-details cell (ship counts / mission text). */
  DETAILS_FLEET: '.detailsFleet',

  // ── Planet detail panel ────────────────────────────────────────────
  /** Anchor holding the current planet's coords, e.g. "[4:30:8]". */
  POSITION_FIELD_LINK: '#positionContentField a',

  // ── Fleetdispatch (the two-step send form) ─────────────────────────
  // Native OGame ids/classes read by the shared fleet courier (and the
  // buttons that drive it). Ship + mission selection go through the
  // MAIN-world `fleetDispatcher` API (see bridges/fleetExecutor.js); the
  // TARGET is set on AGR's own fleet1 controls (AGO_* below) because AGR
  // overwrites the native fleet2 coord inputs. These FD_* entries are only
  // the native step controls the ISOLATED courier clicks / observes.
  /** Step-1 container (ship selection). Hidden — not removed — on step 2. */
  FD_FLEET1: '#fleet1',
  /** Step-2 container (target / mission / dispatch). Hidden on step 1. */
  FD_FLEET2: '#fleet2',
  /** "Continue to step 2" control (step 1). Carries `.off` until ready. */
  FD_CONTINUE: '#continueToFleet2',
  /** "Dispatch fleet" control — present ONLY on step 2. */
  FD_DISPATCH: '#dispatchFleet',
  /** Class on #dispatchFleet while the game is NOT yet ready to send. */
  FD_DISABLED_CLASS: 'off',
  /** "Load all resources" control (step 2). */
  FD_ALL_RESOURCES: '#allresources',

  // ── AGR fleet1 target interface (the dedicated coord row AGR injects) ─
  // The target (coords + planet/moon type) is set HERE, on fleet1, not on
  // the native fleet2 inputs — AGR clobbers fleet2's target with its own,
  // so the only durable way to aim a fleet is through AGR's own controls.
  // Writing these inputs (with the keystroke event sequence) feeds AGR's
  // `ago_keys_arrows` handler; clicking a type span fires AGR `action:42`.
  // These are AGR-owned ids — kept verbatim; an AGR rename is a one-liner.
  /** AGR galaxy coord input (fleet1). */
  AGO_GALAXY: '#ago_galaxy',
  /** AGR system coord input (fleet1). */
  AGO_SYSTEM: '#ago_system',
  /** AGR position coord input (fleet1). */
  AGO_POSITION: '#ago_position',
  /** AGR planet target-type span (ago-data type:1, action:42). */
  AGO_TYPE_PLANET: '#ago_type .planet',
  /** AGR moon target-type span (ago-data type:3, action:42). */
  AGO_TYPE_MOON: '#ago_type .moon',

  // ── Top menu ───────────────────────────────────────────────────────
  MENU_TABLE: '#menuTable',
};
