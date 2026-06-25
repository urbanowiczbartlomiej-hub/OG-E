// @ts-check

// Shared OG-E marker glyphs — the small visual vocabulary reused by BOTH the
// planet-list status markers (`features/badges`) and the event-list reminder
// badges (`features/alarmClock/eventList`), so the two surfaces speak the same
// icon language. These are OG-E's OWN assets (not an OGame DOM contract); they
// live here only so a single definition can't drift between the two consumers.

/**
 * Expedition heart — an inline SVG (data URI) of the blue heart used to mark
 * one of OUR expeditions. Crisp at any size; meant to be set as a CSS
 * `background` on a fixed-size pseudo-element/box, e.g.
 * `background:url("${EXPEDITION_HEART_URI}") center/contain no-repeat`.
 *
 * The fill (`%232C9FE0` = #2C9FE0) is baked in; dim a cancelled/passive variant
 * with `opacity`, not by editing the colour here.
 *
 * @type {string}
 */
export const EXPEDITION_HEART_URI =
  "data:image/svg+xml,<svg viewBox='0 0 32 32' xmlns='http://www.w3.org/2000/svg'><path d='M16 29C16 29 2.5 19 2.5 11C2.5 6.8 6 4 9.5 4C12.5 4 15 6 16 9C17 6 19.5 4 22.5 4C26 4 29.5 6.8 29.5 11C29.5 19 16 29 16 29Z' fill='%232C9FE0'/></svg>";
