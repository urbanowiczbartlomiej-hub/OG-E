// @ts-check
//
// Shared event-row DOM reader. OGame marks a moon endpoint on a fleet/event
// row with a `<figure class="moon">` inside the origin/dest cell; planets (and
// debris) carry no such figure. Two features read this same marker to derive a
// body's `type` for the shared `domain/bodies.bodyKey` identity — the badge UI
// (fleet-save row marking) and the alarmClock FS scanner — and they MUST agree
// on it, because both key into `state/fleetSaveSet`. A feature must not import
// another feature, so the reader lives here in the shared layer rather than
// being copied per feature (where the two copies could silently drift).

/**
 * Body type of an event-row origin/dest cell: a moon carries `figure.moon`,
 * everything else (planet / debris) is treated as planet — only OUR endpoints
 * need an accurate planet-vs-moon split, and ours are never debris.
 *
 * @param {Element | null} cell
 * @returns {number} 1 = planet, 3 = moon.
 */
export const figureType = (cell) =>
  cell?.querySelector('figure')?.classList.contains('moon') ? 3 : 1;
