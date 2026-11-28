// @ts-check
// The ntfy queue as the ONE shared reminder state — pure core.
//
// Every reminder message carries its identity in its click URL (`X-Click`):
// which kind of reminder it is, which flight / wave / body it belongs to, which
// slot of that series it is, the series' anchor time, its generation and the
// full slot list of that generation. Any device can poll the shared topic,
// decode what is queued and converge on it — no other shared store (the old
// GitHub-gist alarm-clock file) is needed. See docs/ntfy-queue-plan.md.
//
// This module is DOM-free and network-free: identity encode/decode plus the
// planner that turns "what this device wants" + "what the queue holds" into
// "post these, cancel those". The I/O lives in `sync/ntfyReconciler.js`.

/** @typedef {'ad' | 'fs' | 'wv' | 'fr'} ReminderKind */

/**
 * The identity a message carries.
 *
 * @typedef {object} MessageIdentity
 * @property {ReminderKind} kind
 * @property {string} key      Event row id (ad, fs), wave id (wv), body key (fr).
 * @property {number} slot     Signed offset in seconds from `anchor`.
 * @property {number} anchor   Arrival / wave base / landing, epoch SECONDS.
 * @property {number} gen      Series generation (≥ 1); higher supersedes lower.
 * @property {number[]} plan   Every slot offset of this generation, ascending.
 * @property {string} [extra]  Kind-specific payload (fs: landing body key).
 */

/** Identity format version — bump on an incompatible change. */
const ID_VERSION = '1';

/** @type {ReadonlySet<string>} */
const KINDS = new Set(['ad', 'fs', 'wv', 'fr']);

/**
 * The click URL for one reminder: opens the universe's fleet movement when the
 * notification is tapped, and carries the identity in the fragment (never sent
 * to the game server; returned verbatim by an ntfy poll).
 *
 * @param {string} universeId  e.g. `s280-pl`.
 * @param {MessageIdentity} id
 * @returns {string}
 */
export const clickUrlFor = (universeId, id) => {
  const q = new URLSearchParams({
    oge: ID_VERSION,
    k: id.kind,
    id: id.key,
    s: String(id.slot),
    a: String(id.anchor),
    g: String(id.gen),
    p: [...id.plan].sort((x, y) => x - y).join(','),
  });
  if (id.extra) q.set('x', id.extra);
  return `https://${universeId}.ogame.gameforge.com/game/index.php?page=ingame&component=movement#${q}`;
};

/** @param {string | null} v @returns {number | null} */
const int = (v) => (v !== null && /^-?\d+$/.test(v) ? Number(v) : null);

/**
 * Decode a message's click URL back into its identity. `null` for anything
 * that is not a current-format OG-E reminder (a foreign message, an old-format
 * one, a mangled URL) — such messages are never touched by the planner.
 *
 * @param {string | undefined} click
 * @returns {MessageIdentity | null}
 */
export const decodeClick = (click) => {
  if (!click) return null;
  const hash = click.indexOf('#');
  if (hash < 0) return null;
  const q = new URLSearchParams(click.slice(hash + 1));
  if (q.get('oge') !== ID_VERSION) return null;
  const kind = q.get('k') ?? '';
  const key = q.get('id') ?? '';
  const slot = int(q.get('s'));
  const anchor = int(q.get('a'));
  const gen = int(q.get('g'));
  const planRaw = q.get('p') ?? '';
  if (!KINDS.has(kind) || !key || slot === null || anchor === null || gen === null || gen < 1) return null;
  const plan = planRaw === '' ? [] : planRaw.split(',').map((x) => int(x));
  if (plan.some((x) => x === null)) return null;
  const extra = q.get('x');
  return {
    kind: /** @type {ReminderKind} */ (kind),
    key,
    slot,
    anchor,
    gen,
    plan: /** @type {number[]} */ (plan),
    ...(extra ? { extra } : {}),
  };
};

/**
 * A message as the planner sees it: the poll's id + fire time + decoded identity.
 *
 * @typedef {object} QueuedMessage
 * @property {string} id
 * @property {number} time    Fire time, epoch SECONDS (past = already delivered).
 * @property {MessageIdentity} identity
 */

/**
 * One series this device wants on the queue.
 *
 * @typedef {object} WantedSeries
 * @property {ReminderKind} kind
 * @property {string} key
 * @property {number} anchor
 * @property {number[]} plan     The slot offsets this device would schedule.
 * @property {string} [extra]
 * @property {boolean} [rewrite] Force a NEW generation with `plan` (the player
 *   changed this series on this device: cancelled a slot). Without it an
 *   existing series keeps its own plan — the device that wrote it decides.
 */

/**
 * A message the planner wants posted.
 *
 * @typedef {object} PostOrder
 * @property {MessageIdentity} identity
 * @property {number} fireAt  Epoch SECONDS (`anchor + slot`).
 */

/** @param {ReminderKind} kind @param {string} key */
const seriesKey = (kind, key) => `${kind}\u0001${key}`;

/**
 * Plan the queue changes for ONE universe.
 *
 * Rules (docs/ntfy-queue-plan.md):
 *   - A wanted series with nothing queued → post every slot as generation 1.
 *   - A wanted series already queued → keep its newest generation's plan and
 *     anchor; post only the slots that plan lists but the queue lacks (a reload
 *     mid-post converges; a slot cancelled elsewhere is not in the plan, so it
 *     is never re-added). Different anchor (the flight was redirected) or
 *     `rewrite` → a new generation with this device's plan.
 *   - Older generations of a series → cancelled.
 *   - Same slot posted twice in one generation (two devices racing) → the
 *     extra copies are cancelled; the lowest id wins, the same on every device.
 *   - A queued series this device does NOT want → left alone, unless its key
 *     is in `gone` (provably over: row left the event list, the player
 *     disarmed / dismissed it here). Unwanted ≠ gone: another device may own it.
 *   - Only FUTURE messages are ever cancelled; slots inside `minDelaySec` or
 *     beyond `maxDelaySec` are not posted.
 *
 * Pure: no I/O, no clock — `now` is injected.
 *
 * @param {object} args
 * @param {WantedSeries[]} args.wanted
 * @param {QueuedMessage[]} args.queue  This universe's decoded messages,
 *   delivered ones included (they prove which plan a series had).
 * @param {Set<string>} args.gone  `seriesKey`-independent: `${kind}:${key}` of
 *   series that must go even if queued by another device.
 * @param {number} args.now
 * @param {number} args.minDelaySec
 * @param {number} args.maxDelaySec
 * @returns {{ post: PostOrder[], cancel: string[] }}
 */
export const planQueue = ({ wanted, queue, gone, now, minDelaySec, maxDelaySec }) => {
  /** @type {Map<string, QueuedMessage[]>} */
  const bySeries = new Map();
  for (const m of queue) {
    const k = seriesKey(m.identity.kind, m.identity.key);
    const list = bySeries.get(k);
    if (list) list.push(m);
    else bySeries.set(k, [m]);
  }

  /** @type {PostOrder[]} */
  const post = [];
  /** @type {Set<string>} */
  const cancel = new Set();
  const isFuture = (/** @type {QueuedMessage} */ m) => m.time > now;
  const canPost = (/** @type {number} */ fireAt) =>
    fireAt >= now + minDelaySec && fireAt <= now + maxDelaySec;

  /**
   * Post the plan's missing future slots for one generation.
   * @param {Omit<MessageIdentity, 'slot'>} base
   * @param {Set<number>} have  Slots of this generation already queued.
   */
  const fill = (base, have) => {
    for (const slot of base.plan) {
      if (have.has(slot)) continue;
      const fireAt = base.anchor + slot;
      if (canPost(fireAt)) post.push({ identity: { ...base, slot }, fireAt });
    }
  };

  /** @type {Set<string>} */
  const handled = new Set();
  for (const w of wanted) {
    const k = seriesKey(w.kind, w.key);
    handled.add(k);
    const plan = [...new Set(w.plan)].sort((a, b) => a - b);
    const msgs = bySeries.get(k) ?? [];
    if (msgs.length === 0) {
      fill({ kind: w.kind, key: w.key, anchor: w.anchor, gen: 1, plan, ...(w.extra ? { extra: w.extra } : {}) }, new Set());
      continue;
    }
    const topGen = Math.max(...msgs.map((m) => m.identity.gen));
    const top = msgs.filter((m) => m.identity.gen === topGen);
    const head = top[0].identity;
    const moved = head.anchor !== w.anchor;
    if (w.rewrite || moved) {
      for (const m of msgs) if (isFuture(m)) cancel.add(m.id);
      fill({ kind: w.kind, key: w.key, anchor: w.anchor, gen: topGen + 1, plan, ...(w.extra ? { extra: w.extra } : {}) }, new Set());
      continue;
    }
    for (const m of msgs) if (m.identity.gen < topGen && isFuture(m)) cancel.add(m.id);
    /** @type {Map<number, string>} slot → winning id */
    const winner = new Map();
    for (const m of [...top].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      if (!winner.has(m.identity.slot)) winner.set(m.identity.slot, m.id);
      else if (isFuture(m)) cancel.add(m.id);
    }
    fill({ ...head, plan: head.plan }, new Set(winner.keys()));
  }

  for (const [k, msgs] of bySeries) {
    if (handled.has(k)) continue;
    const { kind, key } = msgs[0].identity;
    if (!gone.has(`${kind}:${key}`)) continue;
    for (const m of msgs) if (isFuture(m)) cancel.add(m.id);
  }

  return { post, cancel: [...cancel] };
};

/**
 * The distinct series the queue currently holds, newest generation each —
 * what "armed" / "classified as fleet-save" / "has a reminder" means now that
 * the queue is the state. Delivered messages count (a series whose every slot
 * already fired is still known for the cache's lifetime).
 *
 * @param {QueuedMessage[]} queue
 * @returns {Map<string, MessageIdentity>} keyed `${kind}:${key}`.
 */
export const seriesInQueue = (queue) => {
  /** @type {Map<string, MessageIdentity>} */
  const out = new Map();
  for (const m of queue) {
    const k = `${m.identity.kind}:${m.identity.key}`;
    const cur = out.get(k);
    if (!cur || m.identity.gen > cur.gen) out.set(k, m.identity);
  }
  return out;
};
