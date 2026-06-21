// @ts-check

// Pure compute core of `features/sendColony/index.js` — `derive(env)`,
// `render(ctx)`, the pure helpers they call (target pickers, URL
// builders), plus every typedef / constant they reference.
//
// # Why this split exists
//
// `./index.js` mixes three very different kinds of code:
//   1. PURE — compute-the-right-label-for-env (derive + render).
//   2. IMPURE DOM — click handlers that navigate, paint helpers that
//      walk the mounted button halves.
//   3. LIFECYCLE — install/dispose, mount, store subscriptions, event
//      reactors, 1 Hz ticker.
//
// Before this file the first bucket lived in `./index.js` alongside the
// other two and had hidden reads of six module-local `let`s
// (`lastNavToFleetdispatchAt`, `lastScanSubmitAt`, `lastScanEventAt`,
// `lastCheckTargetError`, `waitStartAt`, `waitSeconds`) plus two direct
// DOM reads (`readHomePlanet`, `parseCurrentGalaxyView`). Tests worked
// around those impurities by relying on `_resetSendColonyForTest` zeroing
// the lets between cases — fragile coupling. Extracting the pure core
// makes the dependencies explicit: every field `derive` needs arrives
// through `env`, every field `render` needs arrives through `ctx`.
// Node-env tests can exercise 10 000 cases without a DOM.
//
// # Env contract
//
// `DeriveEnv` lists the full input set. `home` / `view` (previously
// read from DOM by `derive`) and the six state lets (previously hidden)
// are now optional with documented defaults — a test that forgets to
// pass `lastScanSubmitAt` gets "no cooldown active", which is the same
// as a fresh install would see. Production callers use `captureEnv()`
// in `./index.js` to fill every field from the live page.
//
// # What this file does NOT own
//
// No DOM reads, no DOM writes, no timers, no event listeners, no
// module-local mutable state. Every export is either a constant, a
// typedef, or a pure function. If you find yourself wanting to import
// `document` / `window` / `location` here, STOP — that belongs in
// `./index.js`, not here.
//
// @see ./index.js — the orchestrator that consumes this.

import {
  sysDist,
  buildGalaxyOrder,
} from '../../domain/positions.js';
import {
  COL_MAX_SYSTEM,
  COL_MAX_GALAXY,
} from '../../domain/rules.js';

/**
 * @typedef {import('../../state/scans.js').GalaxyScans} GalaxyScans
 *   Re-exported via typedef import so consumers that only need the pure
 *   core don't have to reach into `state/scans.js` themselves.
 * @typedef {import('../../domain/registry.js').RegistryEntry} RegistryEntry
 * @typedef {import('../../bridges/fleetDispatcherSnapshot.js').FleetDispatcherSnapshot} FleetDispatcherSnapshot
 * @typedef {{ galaxy: number, system: number, position: number }} Coords
 */

// ─── Mission id ───────────────────────────────────────────────────────────

/**
 * Mission code for colonize — matches `domain/rules.js MISSION_COLONIZE`.
 * Duplicated here to keep `derive()` free of the `rules.js` import
 * (important for the test env where happy-dom mocks may not have hoisted
 * the rules module yet) and because the string literal `"mission=7"` is
 * how `derive` identifies fleetdispatch URLs anyway.
 */
export const MISSION_COLONIZE = 7;

// ─── Timeouts / cooldowns ────────────────────────────────────────────────

/**
 * After this many ms without a `checkTarget` response on fleetdispatch,
 * {@link derive} returns phase `timeout`. Matches
 * `./index.js CHECK_TARGET_TIMEOUT_MS` 1:1 — kept here because it is the
 * pure derive's own tunable, not a DOM-side concern.
 */
export const CHECK_TARGET_TIMEOUT_MS = 15_000;

// ─── BG colors ───────────────────────────────────────────────────────────

/** Rim colour for idle "Send" with no candidate yet (cyan). */
export const BG_SEND_IDLE = '#12b3c2';
/** Rim colour for active "Send!" / "Send Colony [g:s:p]" (bright cyan). */
export const BG_SEND_READY = '#13d1de';

// TODO: Lifeforms button (planned)
// export const BG_LF_IDLE   = '#a78bfa'; // violet rim — idle  (hue ~255, glow:1.15)
// export const BG_LF_ACTIVE = '#bb9dff'; // violet rim — active
/** Rim colour for reserved / stale / timeout states — recoverable (amber). */
export const BG_SEND_STALE = '#f59e0b';
/** Rim colour for "No ship!" — unrecoverable until user builds a colonizer (rose). */
export const BG_SEND_ERROR = '#fb7185';
/** Rim colour for mid-countdown "Wait Xs" label (yellow). */
export const BG_SEND_WAIT = '#fbbf24';

// ─── Pure target selection ─────────────────────────────────────────────────

/**
 * Find the next colonization target in the local scan DB, respecting
 * the user's `colPositions` priority, the in-flight registry, and the
 * "prefer other galaxies first" toggle.
 *
 * Two-stage guard:
 *   1. `scan.positions[pos].status === 'empty'` — the game observed
 *      the slot empty (so `empty_sent` from prior fleets is filtered).
 *   2. `inFlight.has("g:s:pos")` — any entry in `registry` with
 *      `arrivalAt > now` blocks the same coord key. This is the
 *      second line of defence after `mergeScanResult`'s empty_sent
 *      preservation.
 *
 * Galaxy-order policy:
 *   - `preferOther=false` (default): [home, home+1, home-1, …]
 *   - `preferOther=true`: move home to the end — trades fast home
 *     sends for predictable min-gap timing across galaxies.
 *
 * Within the home galaxy, systems are searched farthest-first by default
 * (better arrival spread); set `farthestFirst=false` to flip it to
 * nearest-first. Other galaxies are always linear 1..499.
 *
 * Free-slot source (the "composite", §2c): a target slot counts as free when
 *   - a LIVE scan exists for its system and observed that slot `empty`
 *     (live always wins — it's fresher and knows what the weekly API can't), OR
 *   - no live scan exists for the system AND the API occupancy `index` does not
 *     list that coord as occupied (a provisional, server-wide candidate).
 * A slot blocked by an in-flight registry entry OR present in `rejected` (coords
 * the game's checkTarget just refused this session) is skipped. With no `index`
 * the function degrades to the classic scan-only behaviour.
 *
 * @param {GalaxyScans} scans
 * @param {RegistryEntry[]} registry
 * @param {{ galaxy: number, system: number }} home
 * @param {number[]} targets  user's parsed `colPositions` list
 * @param {boolean} preferOther  move home galaxy to end of order
 * @param {boolean} [farthestFirst]  home-galaxy system order: farthest free
 *   system first (default, true) vs. nearest first (false).
 * @param {import('../../domain/apiOccupancy.js').OccupancyIndex | null} [index]
 *   API occupancy index (whole-server breadth). Omit/`null` → scan-only.
 * @param {Set<string> | null} [rejected]  `"g:s:p"` coords to skip (session
 *   rejections from checkTarget for slots not in the scan map).
 * @returns {{ galaxy: number, system: number, position: number, link: string } | null}
 */
export const findNextColonizeTarget = (
  scans,
  registry,
  home,
  targets,
  preferOther,
  farthestFirst = true,
  index = null,
  rejected = null,
) => {
  if (targets.length === 0) return null;

  const now = Date.now();
  const inFlight = new Set(
    registry.filter((r) => (r.arrivalAt || 0) > now).map((r) => r.coords),
  );

  let order = buildGalaxyOrder(home.galaxy, COL_MAX_GALAXY);
  if (preferOther && order.length > 1) {
    order = [...order.slice(1), order[0]];
  }

  for (const g of order) {
    // Home galaxy — farthest- or nearest-first per `farthestFirst`; other
    // galaxies — sequential 1..N.
    const systems =
      g === home.galaxy
        ? Array.from({ length: COL_MAX_SYSTEM }, (_, i) => i + 1).sort((a, b) =>
            farthestFirst
              ? sysDist(b, home.system) - sysDist(a, home.system)
              : sysDist(a, home.system) - sysDist(b, home.system),
          )
        : Array.from({ length: COL_MAX_SYSTEM }, (_, i) => i + 1);

    for (const s of systems) {
      const key = /** @type {`${number}:${number}`} */ (`${g}:${s}`);
      const scan = scans[key];
      for (const pos of targets) {
        const coordKey =
          /** @type {`${number}:${number}:${number}`} */ (`${g}:${s}:${pos}`);
        if (inFlight.has(coordKey)) continue;
        if (rejected && rejected.has(coordKey)) continue;
        if (!isFreeTarget(scan, index, coordKey, pos)) continue;
        const base = location.href.split('?')[0];
        const link =
          base +
          `?page=ingame&component=fleetdispatch` +
          `&galaxy=${g}&system=${s}&position=${pos}` +
          `&type=1&mission=${MISSION_COLONIZE}&am208=1`;
        return { galaxy: g, system: s, position: pos, link };
      }
    }
  }
  return null;
};

/**
 * Composite free-slot test (§2c). Live scan wins; otherwise the API index
 * answers for never-scanned systems. Pure.
 *
 * @param {import('../../state/scans.js').SystemScan | undefined} scan
 *   Live scan for the slot's system, if any.
 * @param {import('../../domain/apiOccupancy.js').OccupancyIndex | null} index
 * @param {string} coordKey  `"g:s:p"`.
 * @param {number} pos
 * @returns {boolean}
 */
const isFreeTarget = (scan, index, coordKey, pos) => {
  const p = scan && scan.positions ? scan.positions[pos] : undefined;
  if (p) return p.status === 'empty';
  return !!(index && index.occupied && !index.occupied.has(coordKey));
};

/**
 * Pick the first free target position inside the galaxy view the user
 * is currently staring at. Pure: inputs in, coord out, no DOM / clock.
 *
 * Implements the "current-view priority" rule: when the user has just
 * scanned a system and is still on its galaxy
 * view, a matching free slot in THAT system takes precedence over the
 * global best candidate from `findNextColonizeTarget`. Gives immediate
 * visual feedback ("you see it, Send goes there") instead of bouncing
 * to some other galaxy.
 *
 * A position is a hit when both:
 *   - `scans[view.galaxy:view.system].positions[pos].status === 'empty'`
 *   - no registry entry with `arrivalAt > now` exists for the same
 *     `g:s:pos` coord key (same in-flight guard as findNextColonizeTarget).
 *
 * Priority is `targets[]` order — the caller passes the user's
 * `colPositions` preference list and we return the first index that
 * matches. Returns `null` when the view system is not in `scans`, has
 * no `positions` record, or every target slot is already inFlight.
 *
 * @param {GalaxyScans} scans
 * @param {RegistryEntry[]} registry
 * @param {number[]} targets  user's parsed `colPositions` list
 * @param {{ galaxy: number, system: number }} view  current galaxy-view coords
 * @param {number} now  epoch-ms "now" for inFlight filtering
 * @param {import('../../domain/apiOccupancy.js').OccupancyIndex | null} [index]
 *   API occupancy index, so a free slot in view is found even before a live
 *   scan lands (the live scan, once observed, overrides it).
 * @param {Set<string> | null} [rejected]  session checkTarget rejections.
 * @returns {{ galaxy: number, system: number, position: number } | null}
 */
export const pickCandidateInView = (scans, registry, targets, view, now, index = null, rejected = null) => {
  if (targets.length === 0) return null;
  const key = /** @type {`${number}:${number}`} */ (
    `${view.galaxy}:${view.system}`
  );
  const scan = scans[key];

  const inFlight = new Set(
    registry.filter((r) => (r.arrivalAt || 0) > now).map((r) => r.coords),
  );

  for (const pos of targets) {
    const coordKey =
      /** @type {`${number}:${number}:${number}`} */ (
        `${view.galaxy}:${view.system}:${pos}`
      );
    if (inFlight.has(coordKey)) continue;
    if (rejected && rejected.has(coordKey)) continue;
    if (!isFreeTarget(scan, index, coordKey, pos)) continue;
    return { galaxy: view.galaxy, system: view.system, position: pos };
  }
  return null;
};

// ─── Discriminated unions ────────────────────────────────────────────────

/**
 * The single-zone colonize button state. `kind` distinguishes the galaxy view
 * (current-view candidate priority) from everywhere else; `candidate` is the
 * next colonization target the Send tap will aim at, or `null` when none is
 * available. (The Scan half — and its `nextScan`/`scanCooldown`/`scansRemaining`
 * fields — was removed in §2d: the API breadth layer means there's no manual
 * galaxy-scanning frontier to drive any more.)
 *
 * @typedef {{ kind: 'idle' | 'galaxy', candidate: Coords | null }} ButtonContext
 */

/**
 * Single-zone paint instruction. `subtext` flips the caller to a two-line
 * render (big primary on top, small caption below). `dim: true` renders the
 * zone at reduced opacity (disabled / waiting hint).
 *
 * @typedef {{ text: string, bg: string, subtext?: string, hint?: string, dim?: boolean }} Paint
 */

/**
 * Full button render — the single Send zone's paint.
 *
 * @typedef {{ send: Paint }} RenderResult
 */

/**
 * Input to {@link derive}. Every field except the first 7 is optional;
 * missing fields default to "no effect on derive's decision", so a
 * minimal test can pass just `{ search, fleetDispatcher, scans,
 * registry, targets, preferOther, now }` and reason about the idle /
 * galaxy branches.
 *
 * `home` and `view` previously came from `readHomePlanet()` /
 * `parseCurrentGalaxyView()` inside `derive`. Moving them into `env`
 * keeps the pure core DOM-free — `./index.js captureEnv()` makes the
 * reads in production, tests pass the values explicitly.
 *
 * @typedef {object} DeriveEnv
 * @property {string} search `location.search` (raw, including leading `?`).
 * @property {FleetDispatcherSnapshot | null} fleetDispatcher
 *   Snapshot published by `bridges/fleetDispatcherSnapshot.js`, or
 *   `null` when the bridge hasn't fired yet / we're off fleetdispatch.
 * @property {GalaxyScans} scans
 * @property {RegistryEntry[]} registry
 * @property {number[]} targets Parsed target positions (Galaxy-Scan config).
 * @property {boolean} preferOther `preferOtherGalaxies` (Galaxy-Scan config).
 * @property {boolean} [farthestFirst] `preferFarthestSystems` (Galaxy-Scan
 *   config). Home-galaxy system order; defaults to true (farthest-first) when
 *   omitted (keeps older tests/callers on the historical behaviour).
 * @property {number} now Epoch-ms (tests pass a fixed value, production
 *   passes `Date.now()`).
 * @property {{ galaxy: number, system: number } | null} [home]
 *   Home-planet coords (from the active row in `#planetList`). `null`
 *   means `readHomePlanet` bailed (no live DOM, broken game state);
 *   callers then get an empty-candidate idle/galaxy.
 * @property {{ galaxy: number, system: number } | null} [view]
 *   Current galaxy-view coords (from `#galaxy_input` / URL). `null`
 *   outside the galaxy component.
 * @property {import('../../domain/apiOccupancy.js').OccupancyIndex | null} [index]
 *   API occupancy index (whole-server breadth) from `features/apiContext` via
 *   the shared handoff. Omit/`null` → the picker uses live scans only.
 * @property {Set<string> | null} [rejected]
 *   `"g:s:p"` coords the game's checkTarget refused this session (for slots not
 *   in the scan map), so the picker stops re-proposing them.
 */

// ─── Pure derive ──────────────────────────────────────────────────────────

/**
 * Pure `env → ButtonContext` compute — galaxy branch (current-view priority)
 * vs. everywhere else. Only computes the next colonize candidate now that the
 * Scan half is gone; on fleetdispatch the Send label + action are owned by the
 * courier-driven handler in index.js.
 *
 * @param {DeriveEnv} env
 * @returns {ButtonContext}
 */
export const derive = (env) => {
  // Materialise optional fields with documented defaults. `??` (not `||`)
  // so a legitimate `0` stays `0` rather than falling to the default.
  const home = env.home ?? null;
  const view = env.view ?? null;
  const farthestFirst = env.farthestFirst ?? true;
  const index = env.index ?? null;
  const rejected = env.rejected ?? null;

  // Galaxy branch — current-view priority so the coords the user is looking at
  // win over the global pick.
  if (env.search.includes('component=galaxy')) {
    /** @type {Coords | null} */
    let candidate = null;
    if (home && view) {
      candidate = pickCandidateInView(
        env.scans,
        env.registry,
        env.targets,
        view,
        env.now,
        index,
        rejected,
      );
    }
    if (!candidate && home) {
      const global = findNextColonizeTarget(
        env.scans,
        env.registry,
        home,
        env.targets,
        env.preferOther,
        farthestFirst,
        index,
        rejected,
      );
      if (global) {
        candidate = {
          galaxy: global.galaxy,
          system: global.system,
          position: global.position,
        };
      }
    }
    return { kind: 'galaxy', candidate };
  }

  // Idle branch — anywhere else (overview, galaxy-less research, ...).
  /** @type {Coords | null} */
  let candidate = null;
  if (home) {
    const global = findNextColonizeTarget(
      env.scans,
      env.registry,
      home,
      env.targets,
      env.preferOther,
      farthestFirst,
      index,
      rejected,
    );
    if (global) {
      candidate = {
        galaxy: global.galaxy,
        system: global.system,
        position: global.position,
      };
    }
  }
  return { kind: 'idle', candidate };
};

// ─── Pure render ──────────────────────────────────────────────────────────

/**
 * Render a `ctx` to a paint instruction for the single Send zone. Pure: no DOM,
 * no window. Plain "Colonize" either way — coordinates appear only once the user
 * has tapped (the courier handler arms `colTarget`), keeping the idle view
 * minimal. The brighter rim signals a candidate is ready to aim at.
 *
 * @param {ButtonContext} ctx
 * @returns {RenderResult}
 */
export const render = (ctx) => {
  return {
    send: ctx.candidate
      ? { text: 'Colonize', bg: BG_SEND_READY }
      : { text: 'Colonize', bg: BG_SEND_IDLE },
  };
};
