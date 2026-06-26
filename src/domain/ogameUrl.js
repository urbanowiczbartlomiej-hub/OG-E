// @ts-check

// OGame in-game URL builder — the single home for the fragile
// `?page=ingame&component=<x>` query contract that every navigation target in
// the extension shares. Before this module the base-extraction
// (`href.split('?')[0]`) and the `?page=ingame&component=` literal were
// hand-rolled at ~8 sites across features, the fleet courier, and a bridge;
// each was a separate place to typo the contract or drift the param order.
//
// Pure string logic — no DOM, no `location`, no storage (the `domain/` axiom) —
// so BRIDGES (MAIN world, no chrome.*) may import it just as freely as features
// and sync. Callers pass the source href in (usually `location.href` or an
// anchor's href); the read of `location` stays at the call site.

/**
 * Strip the query (and anything after it) off an OGame in-game URL, leaving the
 * `<origin><path>` base. OGame's in-game pages all live at one path
 * (`/game/index.php`) and differ only by query, so every builder derives its
 * base this way — dropping the tail avoids leaking stale params (an old
 * `position=` / `mission=`) into the next navigation.
 *
 * @param {string} href
 * @returns {string}
 */
export const ogameUrlBase = (href) => String(href).split('?')[0];

/**
 * Build an in-game component URL:
 * `<base>?page=ingame&component=<component>[&k=v…]`, where the base is derived
 * from `href`. Extra params are appended in insertion order — the game's URL
 * format is stable and the browser's navigation cache keys on the exact string,
 * so canonical ordering helps reuse (don't reorder a caller's params).
 *
 * @param {string} href  A full in-game URL (usually `location.href` or an anchor href).
 * @param {string} component  The `component=` value (fleetdispatch, galaxy, lfresearch, overview, …).
 * @param {Record<string, string | number>} [params]  Extra query params, appended in order.
 * @returns {string}
 */
export const ingameComponentUrl = (href, component, params = {}) => {
  let url = `${ogameUrlBase(href)}?page=ingame&component=${component}`;
  for (const [key, value] of Object.entries(params)) url += `&${key}=${value}`;
  return url;
};

/**
 * Build a fleet-dispatch URL pre-armed to send espionage probes to one planet.
 * Opening it lands the player on the in-game fleet dispatch already targeted at
 * the coords with the probe count filled in — the USER still presses send (no
 * auto-dispatch; see docs/fair-play.md). Params: `type:1` = planet,
 * `mission:6` = espionage (domain/rules.js `MISSION_ESPIONAGE` — kept a literal
 * here so this pure URL module stays import-free for the bridges), `am210` =
 * espionage-probe ship id × count.
 *
 * NOTE: `gameHref` must be a URL on the TARGET universe's own origin, not the
 * dashboard's extension origin — derive it from the selected universe / server
 * domain at the call site.
 *
 * @param {string} gameHref  A full in-game URL on the target universe's origin.
 * @param {{ galaxy: number, system: number, position: number }} coords
 * @param {number} probes    Espionage probes to pre-arm.
 * @returns {string}
 */
export const spyMissionUrl = (gameHref, { galaxy, system, position }, probes) =>
  ingameComponentUrl(gameHref, 'fleetdispatch', {
    galaxy,
    system,
    position,
    type: 1,
    mission: 6,
    am210: probes,
  });
