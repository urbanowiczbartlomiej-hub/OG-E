// @ts-check

// Chip-group controls — the Galaxy Viewer's replacement for its 2–4-option
// <select>s. A group is a <div class="chip-group" data-value="…"> holding one
// <button data-value="…"> per option; the container's data-value is the
// single source of truth (the select's `.value` analogue) and the `.on`
// class marks the active chip. Pure DOM helpers, no state of their own —
// wiring, persistence and repaints stay with the caller (index.js), exactly
// as they did for the selects.
//
// Three chip flavours share the same vocabulary but different semantics:
// - SELECT groups (chipValue/setChipValue/wireChips): one value per group,
//   re-clicking the active chip is a no-op.
// - TOGGLE chips (toggleChipOn/setToggleChip/wireToggleChip): independent
//   boolean pills — Spyglass's checkbox replacements. `.on` on the BUTTON is
//   the whole state (no container data-value; each pill stands alone).
// - ACTION chips (watchChip): a built element, not a wired one — it carries no
//   state of its own, it reports a state it was handed and calls back.

/**
 * Current value of a chip group (its `data-value`). Empty string when the
 * element is missing (tests without the full DOM).
 *
 * @param {HTMLElement | null} el
 * @returns {string}
 */
export const chipValue = (el) => el?.dataset.value ?? '';

/**
 * Set a chip group's value and repaint the `.on` marker. Refuses values no
 * chip carries (mirrors the old `querySelector('[value=…]')` restore guard,
 * so a stale persisted pref can't select a phantom option).
 *
 * @param {HTMLElement | null} el
 * @param {string} v
 * @returns {boolean} Whether the value existed and was applied.
 */
export const setChipValue = (el, v) => {
  if (!el) return false;
  const btns = /** @type {HTMLButtonElement[]} */ ([...el.querySelectorAll('button[data-value]')]);
  if (!btns.some((b) => b.dataset.value === v)) return false;
  el.dataset.value = v;
  for (const b of btns) b.classList.toggle('on', b.dataset.value === v);
  return true;
};

/**
 * Wire a chip group: paint the initial `.on` state from the static
 * `data-value` and delegate clicks. Re-clicking the active chip is a no-op
 * (select semantics — no spurious change events); a `.disabled` group
 * ignores clicks entirely.
 *
 * @param {HTMLElement | null} el
 * @param {(value: string) => void} onChange
 * @returns {void}
 */
export const wireChips = (el, onChange) => {
  if (!el) return;
  setChipValue(el, chipValue(el));
  el.addEventListener('click', (e) => {
    if (el.classList.contains('disabled')) return;
    const t = e.target;
    const btn = t instanceof Element ? /** @type {HTMLElement | null} */ (t.closest('button[data-value]')) : null;
    if (!btn) return;
    const v = btn.dataset.value ?? '';
    if (v === chipValue(el)) return;
    setChipValue(el, v);
    onChange(v);
  });
};

/**
 * Is an independent toggle pill on? Missing element = off (tests without the
 * full DOM), mirroring `chipValue`'s null-tolerance.
 *
 * @param {HTMLElement | null} btn
 * @returns {boolean}
 */
export const toggleChipOn = (btn) => !!btn?.classList.contains('on');

/**
 * Set a toggle pill's state without firing its change callback (the
 * programmatic-restore analogue of writing `input.checked` — prefs restore
 * must never trigger a spurious repaint).
 *
 * @param {HTMLElement | null} btn
 * @param {boolean} on
 * @returns {void}
 */
export const setToggleChip = (btn, on) => {
  btn?.classList.toggle('on', !!on);
};

/**
 * Wire an independent boolean pill: click flips `.on` and reports the new
 * state. The `.on` class IS the state — callers read it via
 * {@link toggleChipOn} exactly where they used to read `.checked`.
 *
 * @param {HTMLElement | null} btn
 * @param {(on: boolean) => void} onChange
 * @returns {void}
 */
export const wireToggleChip = (btn, onChange) => {
  if (!btn) return;
  btn.addEventListener('click', () => {
    onChange(btn.classList.toggle('on'));
  });
};

/**
 * Enable/disable a chip group IN PLACE, with the reason in a sibling note —
 * the group keeps its layout slot (no show/hide reflow) and the user can
 * read WHY it doesn't apply right now, instead of watching controls vanish.
 *
 * @param {HTMLElement | null} el
 * @param {boolean} enabled
 * @param {HTMLElement | null} noteEl
 * @param {string} note  Shown only while disabled.
 * @returns {void}
 */
export const setChipsEnabled = (el, enabled, noteEl, note) => {
  if (el) el.classList.toggle('disabled', !enabled);
  if (noteEl) noteEl.textContent = enabled ? '' : note;
};

/**
 * The "watch" ACTION pill — outline `+ watch` = not on the scan list, filled
 * `✓ watch` = on the in-game scan FAB's watch-list. Offered from several
 * surfaces (the Players table, the "Who's spying on you" prober rows, the
 * "Your neighbours" rows, Patrol) — one builder so the label/behaviour can't
 * drift into hand-copied variants.
 *
 * The click is stopped from bubbling: on every one of those surfaces the row
 * around the pill has its own click (open the player's profile), and a watch
 * toggle must never trigger it.
 *
 * @param {string} id  Player id handed back to `onToggle`.
 * @param {boolean} watched
 * @param {(id: string) => void} [onToggle]
 * @returns {HTMLSpanElement}
 */
export const watchChip = (id, watched, onToggle) => {
  const chip = document.createElement('span');
  chip.textContent = watched ? '✓ watch' : '+ watch';
  // .hit-pad: ≥36px touch hit-box (coarse pointers only) without growing the
  // visible pill.
  chip.className = 'hit-pad';
  chip.style.cssText =
    'display:inline-block;font-size:11px;border-radius:11px;padding:2px 9px;'
    + 'cursor:pointer;user-select:none;white-space:nowrap;'
    + (watched
      ? 'background:#16352a;border:1px solid #2f6f4f;color:#7fd6a8;'
      : 'background:transparent;border:1px solid #2a3a45;color:#8b95a0;');
  chip.title = watched
    ? 'Watching (on your scan list + the map) — click to remove'
    : 'Watch this player (adds to the scan list + the map)';
  if (onToggle) chip.addEventListener('click', (e) => { e.stopPropagation(); onToggle(id); });
  return chip;
};
