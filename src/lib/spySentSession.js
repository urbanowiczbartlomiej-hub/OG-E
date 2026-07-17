// @ts-check

// Per-tab session record of espionage-probe sends: "g:s:p" coord → epoch-ms
// the user tapped Send. Two consumers, which is why it lives in `lib` (the
// zero-dependency floor both may import):
//
//   - `features/sendSpy` MARKS a coord on every successful dispatch and reads
//     the coord set so the FAB doesn't re-propose a planet whose probe is
//     still in flight (survives the post-send page reload).
//   - `state/activityObs` reads the send TIMES for the self-induced-activity
//     discount (SPYGLASS-REDESIGN.md §6.6bis): our own probe's arrival lights
//     the target body's activity marker for the next hour, and counting that
//     marker would make the routine tracker measure its own scanning rhythm.
//     state/ may not import features/, so the shared key lives here.
//
// sessionStorage (page origin, per tab) is deliberate: probe flights resolve
// within the session, and a fresh tab starting empty only costs one redundant
// re-propose / one conservatively-kept marker. Legacy shape tolerance: the
// pre-timestamp format was a plain JSON array of coords — read as "sent at
// unknown time" (`0`), which the discount treats as no-time-info (no drop).

/** sessionStorage key. Shared BY IMPORT — never inline this string. */
export const SPY_SENT_KEY = 'oge_spySentCoords';

/**
 * Read the sent map: "g:s:p" → epoch-ms of the send tap (0 = legacy entry,
 * time unknown). Returns `{}` when nothing was sent / storage is unavailable.
 * @returns {Record<string, number>}
 */
export const readSpySentMap = () => {
  try {
    const raw = window.sessionStorage.getItem(SPY_SENT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      /** @type {Record<string, number>} */
      const out = {};
      for (const c of parsed) out[String(c)] = 0;
      return out;
    }
    if (parsed && typeof parsed === 'object') {
      /** @type {Record<string, number>} */
      const out = {};
      for (const k of Object.keys(parsed)) {
        const v = Number(/** @type {Record<string, unknown>} */ (parsed)[k]);
        out[k] = Number.isFinite(v) && v > 0 ? v : 0;
      }
      return out;
    }
  } catch {
    /* sessionStorage unavailable / corrupt — behave as "nothing sent". */
  }
  return {};
};

/**
 * Record a probe send to a coord at `sentAtMs`. Best-effort — storage failure
 * degrades to "not remembered" (the FAB then re-proposes after reload; the
 * activity discount just keeps one marker it could have dropped).
 * @param {string} coord  "g:s:p"
 * @param {number} sentAtMs
 * @returns {void}
 */
export const markSpySent = (coord, sentAtMs) => {
  const map = readSpySentMap();
  map[coord] = sentAtMs;
  try {
    window.sessionStorage.setItem(SPY_SENT_KEY, JSON.stringify(map));
  } catch {
    /* degrade silently — see above */
  }
};

/**
 * Forget a probe send. Used to roll back an OPTIMISTIC mark when the sendFleet
 * response turns out to report failure (the bridge marks on the reload-safe
 * `send` phase, then unmarks here if the server rejected the fleet). Best-effort;
 * a missing key is a no-op.
 * @param {string} coord  "g:s:p" | "g:s:p:3"
 * @returns {void}
 */
export const unmarkSpySent = (coord) => {
  const map = readSpySentMap();
  if (!(coord in map)) return;
  delete map[coord];
  try {
    window.sessionStorage.setItem(SPY_SENT_KEY, JSON.stringify(map));
  } catch {
    /* degrade silently — see above */
  }
};
