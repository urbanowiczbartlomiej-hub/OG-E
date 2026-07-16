// @ts-check

// Cross-module STATUS tones — the one colour language every FAB command
// button speaks when a tap can't do what its label promises.
//
// Two tones, one meaning each, across ALL the send buttons (Expeditions,
// Colonization, Lifeforms, Daily Run, Spy):
//
//   • {@link TONE_ERROR} (rose) — the tap FAILED or cannot act at all:
//     nothing to send ('No ship'), every general fleet slot busy
//     ('Max fleets'), dispatch refused ('Failed', 'No fuel'),
//     a required AGR routine disabled.
//   • {@link TONE_WAIT} (amber) — the tap is VALID but there is nothing to
//     act on right now; come back later: busy / min-gap countdowns
//     ('Wait…', 'Wait Ns'), every send maxed ('All sent'), no colonize
//     candidates left ('No targets').
//
// Why shared: these used to live as duplicated hex literals in each
// feature's pure.js — identical by convention only, one edit away from
// silently diverging. Each feature keeps exporting its own BG_* names (its
// tests and call sites read those); the VALUES come from here. Idle / ready
// / done colours are deliberately NOT here — those are per-module identity
// (see ./fabModules.js), not shared status language.
//
// Pure data (strings only) — safe for pure.js imports.

/** Rose — the tap failed / cannot act at all. */
export const TONE_ERROR = '#fb7185';

/** Amber — valid, but nothing to act on right now; retry later. */
export const TONE_WAIT = '#fbbf24';
