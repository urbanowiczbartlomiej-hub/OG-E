// @ts-check

// Reminder MESSAGE TEMPLATES — the user-customisable body / icon / priority
// for each of the three notification kinds (expedition waves, ad-hoc fleet
// reminders, fleet-save). Everything here is PURE: no DOM, no storage, no
// clock. The shape, its defaults, the wildcard catalogue, and the renderer
// all live here so they are unit-testable in Node and shared verbatim across
// the game/dashboard origins.
//
// # What is and isn't customisable (and why)
//
// The user edits the BODY (with `{wildcard}` tokens), the ICON (a preset —
// not a free URL, so we never widen host permissions), and the PRIORITY
// (1–5). The TITLE is deliberately NOT templated: on the shared ntfy topic
// the title doubles as the per-kind queue filter (see
// `sync/ntfyReconciler.reconcileQueue` — it matches messages by exact title
// so the three kinds never sweep each other). A user-editable title would
// break that routing, so the title stays system-managed.
//
// # Wildcards: a shared common set, one per-fleet set, plus what each kind adds
//
// `{server}` + `{mission}` are COMMON to all three kinds (a wave's mission is
// always "Expedition", but exposing it keeps the three editors uniform).
//
// Ad-hoc and fleet-save both derive from ONE event-list row at arm/detect
// time, so they share the SAME per-fleet set ({@link FLEET_FIELDS}: coords /
// origin / originName / target / targetName / direction / shipCount /
// arrivalTime / offset) — the two editors now read IDENTICALLY, both adding the
// series {@link SERIES_FIELDS} (`{index}`/`{total}`) on top. Note `{coords}`
// (where THIS leg lands) is NOT redundant with `{origin}`/`{target}` (the fixed
// launch + mission target): on a return leg it equals origin, on an outbound
// leg it equals target — and `{direction}` names which it is ("outbound" /
// "return"), derived from exactly that comparison (see {@link legDirection}).
// `{offset}` reads the slot's position relative to arrival ("10 min before" /
// "at landing"); it's a single "before" lead on ad-hoc, the full landing-
// relative phrase on fleet-save. Waves add `{returnTime}` + the same series
// `{index}`/`{total}`.
//
// `{label}` (= `{mission} → {coords}`) and `{landTime}` (= `{arrivalTime}`)
// are NO LONGER advertised — the composite and the alias were redundant. The
// renderer still substitutes them (the sync layer keeps both in context) so
// any body saved before this cleanup keeps rendering, they just don't appear
// as chips.
//
// Expedition-wave bodies, by contrast, canNOT name a single fleet's count /
// coords / origin: the series is queued the instant the FIRST expedition of a
// wave is detected — before the burst finishes — so a browser close mid-send
// still leaves reminders queued (see `sync/ntfyReconciler.waveBody`). Any
// token the renderer is handed without a value collapses to the empty string,
// so a template never leaks a literal `{coords}` into a push.

/**
 * The three notification kinds, in render order. Stable ids used as the keys
 * of {@link ReminderGlobalConfig.templates} and {@link TEMPLATE_FIELDS}.
 *
 * @typedef {'wave' | 'adhoc' | 'fleetSave'} ReminderKind
 */

/** @type {ReadonlyArray<ReminderKind>} */
export const REMINDER_KINDS = Object.freeze(['wave', 'adhoc', 'fleetSave']);

/**
 * Preset notification icons — the only icons the picker offers. Each `file`
 * names an asset under `icons/`; the (non-pure) sync layer turns it into a
 * public https URL (see `sync/ntfyReconciler.iconUrl`). Kept here (as plain
 * data, not DOM) so the dashboard picker and the publisher agree on the set.
 *
 * Adding a preset means shipping the PNG in the SAME release that first
 * references it (an unreleased icon 404s in the ntfy app).
 *
 * @typedef {object} PresetIcon
 * @property {string} id     stable id stored in the template.
 * @property {string} label  human label for the dashboard picker.
 * @property {string} file   asset filename under `icons/`.
 */

/** @type {ReadonlyArray<PresetIcon>} */
export const PRESET_ICONS = Object.freeze([
  { id: 'default', label: 'Default (OG-E)', file: 'icon128.png' },
  { id: 'urgent', label: 'Urgent (red)', file: 'icon_red.png' },
]);

/** Fallback icon id when a stored value is unknown. */
export const DEFAULT_ICON_ID = 'default';

/**
 * Resolve a stored icon id to its asset filename, falling back to the
 * default preset for an unknown / missing id. Pure — the https URL wrapping
 * happens in the sync layer (it needs the release ref).
 *
 * @param {unknown} iconId
 * @returns {string}  asset filename under `icons/`.
 */
export const iconFileFor = (iconId) => {
  const hit = PRESET_ICONS.find((p) => p.id === iconId);
  return (hit ?? PRESET_ICONS[0]).file;
};

/**
 * One wildcard a template body may reference: the `{token}` text, a human
 * label for the dashboard chip, and a `sample` used to render the live
 * preview (so the user sees a realistic message, not empty tokens).
 *
 * @typedef {object} TemplateField
 * @property {string} token   the `{name}` placeholder (without braces).
 * @property {string} label   human label for the dashboard chip.
 * @property {string} sample  representative value for the live preview.
 */

/**
 * Tokens every kind shares. `{mission}` is common because a wave's mission is
 * always "Expedition" — exposing it anyway keeps the three editors uniform.
 */
const COMMON_FIELDS = Object.freeze([
  { token: 'server', label: 'Server id', sample: '123' },
  { token: 'mission', label: 'Mission', sample: 'Expedition' },
]);

/**
 * Per-fleet tokens shared by ad-hoc + fleet-save (both derive from one
 * event-list row, so they expose the SAME set in the SAME order). `coords` is
 * where THIS leg lands; `origin`/`target` are its fixed launch + mission target
 * (see `features/reminders/fleetSaveScan.fleetRowMeta`). `direction` names the
 * leg ("outbound"/"return") and `offset` the slot's timing relative to arrival
 * — both kinds carry them now, so the two editors are fully aligned.
 *
 * @type {ReadonlyArray<TemplateField>}
 */
const FLEET_FIELDS = Object.freeze([
  { token: 'coords', label: 'Landing coords', sample: '[4:467:16]' },
  { token: 'origin', label: 'Origin coords', sample: '[4:467:15]' },
  { token: 'originName', label: 'Origin name', sample: 'P1' },
  { token: 'target', label: 'Target coords', sample: '[4:467:16]' },
  { token: 'targetName', label: 'Target name', sample: 'Deep space' },
  { token: 'direction', label: 'Leg (outbound/return)', sample: 'return' },
  { token: 'shipCount', label: 'Ship count', sample: '4,323' },
  { token: 'arrivalTime', label: 'Arrival time', sample: '14:32' },
  { token: 'offset', label: 'When (before/at/after)', sample: '10 min before' },
]);

/**
 * Series tokens: which reminder in a kind's schedule this push is, of how many.
 * Shared by all three kinds — waves are an offset series, fleet-save fires a
 * landing-relative series, and ad-hoc is a single-slot "1 of 1" today but is
 * slated to grow its own schedule (so it carries the pair for forward-uniformity
 * rather than rendering a misleading bare value later).
 *
 * @type {ReadonlyArray<TemplateField>}
 */
const SERIES_FIELDS = Object.freeze([
  { token: 'index', label: 'Reminder # (1-based)', sample: '1' },
  { token: 'total', label: 'Total reminders', sample: '4' },
]);

/**
 * The wildcard catalogue per kind — the tokens each body may reference and
 * the values the live preview substitutes. The renderer accepts ANY token
 * present in its context; this list is what the UI advertises and what
 * {@link unknownTokens} validates against.
 *
 * @type {Readonly<Record<ReminderKind, ReadonlyArray<TemplateField>>>}
 */
export const TEMPLATE_FIELDS = Object.freeze({
  // Waves: NO per-fleet fields — the series is queued on the FIRST expedition,
  // before the burst (count / origins / coords) is known. Series + return only.
  wave: Object.freeze([
    ...COMMON_FIELDS,
    { token: 'returnTime', label: 'Return time', sample: '14:32' },
    ...SERIES_FIELDS,
  ]),
  // Ad-hoc and fleet-save expose the IDENTICAL catalogue now: the shared
  // per-fleet set plus the series pair.
  adhoc: Object.freeze([...COMMON_FIELDS, ...FLEET_FIELDS, ...SERIES_FIELDS]),
  fleetSave: Object.freeze([...COMMON_FIELDS, ...FLEET_FIELDS, ...SERIES_FIELDS]),
});

/**
 * One kind's editable message: the body template, a preset icon id, and the
 * ntfy priority (1–5). Title is intentionally absent (system-managed — see
 * the module header).
 *
 * @typedef {object} ReminderTemplate
 * @property {string} body      free text with `{token}` wildcards.
 * @property {string} icon      a {@link PRESET_ICONS} id.
 * @property {number} priority  ntfy priority, 1 (min) … 5 (max).
 */

/**
 * Built-in defaults — they reproduce the historical hardcoded bodies,
 * priorities and icons EXACTLY, so enabling templating changes nothing until
 * the user edits a field. A fresh object each call so callers can't mutate a
 * shared literal.
 *
 * Wave stays priority 3 (background nudge, default icon); ad-hoc and
 * fleet-save ring at 5 with the red icon and carry the trailing 🔥 the old
 * flare logic appended — folded into the default body now that the body is
 * the single source of truth.
 *
 * @returns {Record<ReminderKind, ReminderTemplate>}
 */
export const defaultReminderTemplates = () => ({
  wave: {
    body: 'Expeditions back ({returnTime}) — reminder #{index}/{total}.',
    icon: 'default',
    priority: 3,
  },
  adhoc: {
    body: '{mission} → {coords} — arrives {arrivalTime}. 🔥',
    icon: 'urgent',
    priority: 5,
  },
  fleetSave: {
    body: 'Fleet save: {mission} → {coords} — lands {arrivalTime} ({offset}). 🔥',
    icon: 'urgent',
    priority: 5,
  },
});

/**
 * Clamp an arbitrary stored value to an integer ntfy priority in [1, 5],
 * falling back to `fallback` for garbage.
 *
 * @param {unknown} v
 * @param {number} fallback
 * @returns {number}
 */
const coercePriority = (v, fallback) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(5, Math.max(1, n));
};

/**
 * Normalise one (possibly partial / legacy / null) stored template into a
 * complete {@link ReminderTemplate}, filling holes from `fallback`. Pure and
 * total.
 *
 * @param {unknown} raw
 * @param {ReminderTemplate} fallback  the matching kind's default.
 * @returns {ReminderTemplate}
 */
export const normalizeReminderTemplate = (raw, fallback) => {
  if (!raw || typeof raw !== 'object') return { ...fallback };
  const r = /** @type {Partial<ReminderTemplate>} */ (raw);
  return {
    body: typeof r.body === 'string' ? r.body : fallback.body,
    icon: PRESET_ICONS.some((p) => p.id === r.icon) ? /** @type {string} */ (r.icon) : fallback.icon,
    priority: coercePriority(r.priority, fallback.priority),
  };
};

/**
 * Normalise a whole `{ wave, adhoc, fleetSave }` template map, filling each
 * kind (and each kind's holes) from {@link defaultReminderTemplates}. Pure
 * and total — always returns a valid, complete map.
 *
 * @param {unknown} raw
 * @returns {Record<ReminderKind, ReminderTemplate>}
 */
export const normalizeReminderTemplates = (raw) => {
  const d = defaultReminderTemplates();
  const r = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  return {
    wave: normalizeReminderTemplate(r.wave, d.wave),
    adhoc: normalizeReminderTemplate(r.adhoc, d.adhoc),
    fleetSave: normalizeReminderTemplate(r.fleetSave, d.fleetSave),
  };
};

/**
 * Render a body template against a context, substituting each `{token}` with
 * its value. Any token absent from `ctx` (or null/undefined) collapses to
 * the empty string, so a push never shows a literal `{token}`. Pure.
 *
 * @param {string} template
 * @param {Record<string, string | number | null | undefined>} ctx
 * @returns {string}
 */
export const renderTemplate = (template, ctx) =>
  String(template).replace(/\{(\w+)\}/g, (_m, key) => {
    const v = ctx[key];
    return v === null || v === undefined ? '' : String(v);
  });

/**
 * Split a push label of the form `"Mission → [g:s:p]"` into its `{mission}`
 * and `{coords}` parts — the inverse of the `${mission} → [${landing}]`
 * format the event-list / fleet-save labellers build (see
 * `features/reminders/eventList.labelFor` and `fleetSaveScan.fleetSaveLabelFor`).
 *
 * Deriving the two from the combined label here means the templating wildcards
 * `{mission}` / `{coords}` work WITHOUT persisting the parts separately (no
 * reminder-gist schema change). A label with no destination (just a mission
 * name) yields an empty `coords`. Coords keep their `[...]` brackets — that's
 * how they read in a push. Pure.
 *
 * @param {string} label
 * @returns {{ mission: string, coords: string }}
 */
export const splitLabel = (label) => {
  const s = String(label);
  const i = s.indexOf(' → ');
  if (i === -1) return { mission: s.trim(), coords: '' };
  return { mission: s.slice(0, i).trim(), coords: s.slice(i + 3).trim() };
};

/**
 * Name the leg from where it lands: `'return'` when the landing `coords` match
 * the launch `origin`, `'outbound'` when they match the mission `target`. All
 * three are the SAME bracketed dense `[g:s:p]` format (see
 * `features/reminders/fleetSaveScan`), so an exact string compare is reliable.
 * Returns `''` when undecidable — coords missing, or origin === target so the
 * match is ambiguous — which the renderer then collapses to an empty token.
 * Pure.
 *
 * @param {string} coords  Landing coords (where THIS leg arrives).
 * @param {string} origin  Launch coords (fixed).
 * @param {string} target  Mission-target coords (fixed).
 * @returns {'' | 'outbound' | 'return'}
 */
export const legDirection = (coords, origin, target) => {
  const c = String(coords ?? '');
  if (!c) return '';
  const isReturn = c === String(origin ?? '');
  const isOutbound = c === String(target ?? '');
  if (isReturn && !isOutbound) return 'return';
  if (isOutbound && !isReturn) return 'outbound';
  return '';
};

/**
 * The set of `{token}` names a template references (deduped, in first-seen
 * order). Used by the dashboard to lint a body. Pure.
 *
 * @param {string} template
 * @returns {string[]}
 */
export const templateTokens = (template) => {
  /** @type {string[]} */
  const out = [];
  const re = /\{(\w+)\}/g;
  let m;
  while ((m = re.exec(String(template))) !== null) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
};

/**
 * The tokens a body references that are NOT in the given kind's catalogue —
 * i.e. tokens that will always render empty. The dashboard surfaces these as
 * a warning so the user catches a typo (`{cords}`) before it ships a blank.
 * Pure.
 *
 * @param {string} template
 * @param {ReminderKind} kind
 * @returns {string[]}
 */
export const unknownTokens = (template, kind) => {
  const known = new Set(TEMPLATE_FIELDS[kind].map((f) => f.token));
  return templateTokens(template).filter((t) => !known.has(t));
};
