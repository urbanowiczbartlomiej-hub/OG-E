// Lifeform artifact counter — the last known "Zebrane artefakty: N / M"
// reading from the game's lfresearch page, persisted per-origin (each OGame
// universe lives on its own subdomain, so plain localStorage scoping is the
// universe namespace — same reasoning as `state/dailyActions.js`).
//
// Written by `features/sendLifeform` (live DOM read on lfresearch visits +
// an hourly background refetch); read back by the same feature to gate the
// Discovery button once the cap is reached. Kept in state/ so the key has a
// single owner and any future consumer (dashboard, sync) doesn't have to
// import from features/.
//
// @ts-check

import { safeLS } from '../lib/storage.js';

/** localStorage key holding the JSON-serialized {@link ArtifactReading}. */
const LF_ARTIFACTS_KEY = 'oge-lf-artifacts';

/**
 * One observation of the artifact counter. `current` may legitimately
 * EXCEED `max` (the game overshoots when several discoveries land at once
 * — e.g. 3609 / 3600), so consumers must gate on `current >= max`, not
 * equality.
 *
 * @typedef {object} ArtifactReading
 * @property {number} current  collected artifacts at `readAt`.
 * @property {number} max      the account's artifact cap (e.g. 3600).
 * @property {number} readAt   epoch-ms of the observation.
 */

/**
 * Read the last persisted artifact observation, or `null` when absent or
 * unparsable (corrupt JSON degrades to "never read", never throws).
 *
 * @returns {ArtifactReading | null}
 */
export const readLfArtifacts = () => {
  const raw = safeLS.get(LF_ARTIFACTS_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object') return null;
    const { current, max, readAt } = v;
    if (
      !Number.isFinite(current) ||
      !Number.isFinite(max) ||
      !Number.isFinite(readAt)
    ) {
      return null;
    }
    return { current, max, readAt };
  } catch {
    return null;
  }
};

/**
 * Persist a fresh artifact observation (full overwrite).
 *
 * @param {ArtifactReading} reading
 * @returns {void}
 */
export const writeLfArtifacts = (reading) => {
  safeLS.set(LF_ARTIFACTS_KEY, JSON.stringify(reading));
};
