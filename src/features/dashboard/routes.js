// @ts-check

// Dashboard "FS Routes" tab — edit the fleet-save micro-fleet routes as a
// single text DSL, per selected universe. Reads/writes the same
// per-universe chrome.storage key (`<universeId>:oge_fsRoutes`) the
// in-game fsCollect feature consumes. The collect target (set in-game) is
// preserved on save — this tab only edits the `routes` map.
//
// Installed like the reminders tab: the host passes a `getUniverseId`
// getter and calls the returned `refresh()` whenever the selected
// universe changes.
//
// @see ../../domain/fsRoutes.js — the DSL parse/format (pure, shared).
// @see ../../state/fsRoutes.js — the store + per-universe key helper.

import { chromeStore } from '../../lib/storage.js';
import { fsRoutesKeyFor } from '../../state/fsRoutes.js';
import { parseRoutesDsl, formatRoutesDsl } from '../../domain/fsRoutes.js';

/**
 * @param {{ getUniverseId: () => string }} opts
 * @returns {{ refresh: () => void }}
 */
export const installRoutes = ({ getUniverseId }) => {
  const ta = /** @type {HTMLTextAreaElement | null} */ (
    document.getElementById('routesDsl')
  );
  const saveBtn = document.getElementById('routesSaveBtn');
  const revertBtn = document.getElementById('routesRevertBtn');
  const status = document.getElementById('routesStatus');
  // Defensive: if the markup is absent (older dashboard.html), no-op so a
  // missing tab never throws during boot.
  if (!ta) return { refresh: () => {} };

  /** Last value loaded from / written to storage — the revert baseline. */
  let baseline = '';

  /** @param {string} msg @param {string} [color] */
  const setStatus = (msg, color) => {
    if (status) {
      status.textContent = msg;
      status.style.color = color || '#888';
    }
  };

  const refresh = async () => {
    const uni = getUniverseId();
    if (!uni) {
      ta.value = '';
      baseline = '';
      setStatus('');
      return;
    }
    const stored = /** @type {any} */ (await chromeStore.get(fsRoutesKeyFor(uni)));
    const routes =
      stored && typeof stored === 'object' && stored.routes ? stored.routes : {};
    ta.value = formatRoutesDsl(routes);
    baseline = ta.value;
    setStatus('');
  };

  const save = async () => {
    const uni = getUniverseId();
    if (!uni) {
      setStatus('No universe selected.', '#e66');
      return;
    }
    const { routes, errors } = parseRoutesDsl(ta.value);
    // Preserve the in-game-set collect target; we only own `routes` here.
    const stored = /** @type {any} */ (await chromeStore.get(fsRoutesKeyFor(uni)));
    const collectTarget =
      stored && typeof stored === 'object' ? stored.collectTarget ?? null : null;
    await chromeStore.set(fsRoutesKeyFor(uni), { routes, collectTarget });
    baseline = formatRoutesDsl(routes);
    const n = Object.keys(routes).length;
    if (errors.length) {
      const detail = errors.map((e) => `L${e.line}: ${e.message}`).join('; ');
      setStatus(`Saved ${n} route(s). ${errors.length} skipped — ${detail}`, '#e6a23c');
    } else {
      setStatus(`Saved ${n} route(s).`, '#67c23a');
    }
  };

  saveBtn?.addEventListener('click', () => void save());
  revertBtn?.addEventListener('click', () => {
    ta.value = baseline;
    setStatus('Reverted to last saved.');
  });

  return { refresh: () => void refresh() };
};
