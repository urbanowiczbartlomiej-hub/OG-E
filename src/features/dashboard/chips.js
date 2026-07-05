// @ts-check

// Chip-group controls — the Galaxy Viewer's replacement for its 2–4-option
// <select>s. A group is a <div class="chip-group" data-value="…"> holding one
// <button data-value="…"> per option; the container's data-value is the
// single source of truth (the select's `.value` analogue) and the `.on`
// class marks the active chip. Pure DOM helpers, no state of their own —
// wiring, persistence and repaints stay with the caller (index.js), exactly
// as they did for the selects.
//
// Two chip flavours share the same CSS but different semantics:
// - SELECT groups (chipValue/setChipValue/wireChips): one value per group,
//   re-clicking the active chip is a no-op.
// - TOGGLE chips (toggleChipOn/setToggleChip/wireToggleChip): independent
//   boolean pills — Spyglass's checkbox replacements. `.on` on the BUTTON is
//   the whole state (no container data-value; each pill stands alone).

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
