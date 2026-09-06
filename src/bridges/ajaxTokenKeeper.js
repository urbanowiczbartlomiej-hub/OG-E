// MAIN-world keeper for the game's single rotating ajax token.
//
// THE PROBLEM (OGame 13.0, observed on 13.0.0-r5)
//   The session owns ONE ajax token. Since 13.0 `action=checkTarget` SPENDS
//   the token it was sent and hands back a fresh one in the response's
//   `newAjaxToken` field; whoever then replays the spent value is refused with
//   `{"error":100,"message":"LOCA_ERROR_INQUIRY_NOT_WORKED_TRYAGAIN"}` — the
//   red "please try again" box players see on the fleet1→fleet2 step.
//
//   The refusal has nothing to do with the target: the identical request
//   repeated with the rotated token succeeds. It is purely a bookkeeping
//   failure inside the page, and it has two known ways to happen:
//
//     1. STRANDED UPDATE. The game applies the rotation LAST:
//        `FleetDispatcher.fetchTargetPlayerData`'s callback runs ~10 DOM
//        refresh calls (`refreshDataAfterAjax`, `refreshStatusBarFleet`,
//        `validateMissions`, `refreshFleet2`, …) and only then calls
//        `updateToken(data.newAjaxToken)`. An exception anywhere in that
//        strand — trivially possible on a page carrying several third-party
//        scripts — means the update never runs, and the page keeps sending a
//        token the server retired. Every later request then fails, forever,
//        until a full reload. This is why a per-click RETRY cannot help: the
//        repeat re-reads the same stranded value.
//     2. PRIVATE CACHE. A script that keeps its own copy of the token (the
//        body fingerprint in the HAR we diagnosed — token appended LAST,
//        which is neither the game's serialisation order nor ours — points at
//        AGR) replays a value that was already spent by the game's own
//        request milliseconds earlier.
//
//   Both were measured on one page load of a 13.0 universe (HAR, 2026-07-28):
//   eventbox echoes the token at +190 ms, the game's own checkTarget spends it
//   at +244 ms, and the third-party fleet1 submit at +644 ms replays the +190 ms
//   value and is refused. Note the timescale — this is page INITIALISATION, not
//   idle play, which is why page.js must run at `document_start` (see its RUN_AT
//   note). A keeper that installs after `DOMContentLoaded` (+811 ms here) has
//   already missed the entire episode.
//
// WHAT THIS BRIDGE DOES
//   It keeps ONE fact — "the newest token the server has issued in this tab" —
//   and makes the page agree with it:
//
//     • LEARN. Every game XHR response is scanned for `newAjaxToken`
//       (regex, no JSON.parse — responses here can be large). Failure
//       responses carry a usable fresh token too, so a refusal is itself a
//       recovery point. The one exclusion is the CHAT component, which spells
//       a DIFFERENT token with the same field name — see {@link CHAT_XHR}.
//     • REPAIR. When a holder the page reads from (`window.token`, which is
//       what `appendTokenParams()` reads; `fleetDispatcher.token`, which the
//       game sets once at construction and never updates; the hidden `token`
//       form inputs) still holds a value we know to be spent, we write the
//       fresh one in. That un-strands case 1 for the GAME's own requests, and
//       for every other script that reads the page's token instead of caching.
//     • SUBSTITUTE a spent `token` on the way out of a `checkTarget`. Case 2 is
//       the one thing repairing shared state cannot reach: a sender reading its
//       own cached copy never consults the variables we fixed. The first
//       verification run suggested it did not occur here and this half shipped
//       as a bare counter; the 2026-07-29 capture proved otherwise (a spent
//       token replayed THREE SECONDS after the game spent it), so it is now
//       live. It only ever moves a token FORWARD along the sequence the server
//       issued, and never touches `sendFleet`. See {@link NORMALISE_OUTGOING}.
//
//   Net effect: the error stops happening for everyone in the page — the game,
//   OG-E's own buttons, and any other tool — instead of each script having to
//   recover from it separately.
//
//   Timing is part of the fix, not an implementation detail: page.js runs at
//   `document_start` precisely so this bridge exists before the game's first
//   request. Installed at `document_idle` it observed `rotations: 1` and
//   repaired nothing, because the whole episode was already over.
//
// FAIR PLAY / TRAFFIC
//   This adds ZERO requests. It originates nothing, schedules nothing, polls
//   nothing, and reveals nothing the page did not already have. Its main path
//   writes the fresh token into the page's OWN variables (which is what the
//   game's `updateToken` was supposed to do) and the game then builds its
//   requests as usual.
//
//   It does now correct ONE field of one outgoing request — the `token` of a
//   `checkTarget` whose sender is replaying a spent value. That is the only
//   place OG-E edits a request rather than reading it, so it is written down
//   plainly here and classified in `docs/fair-play.md` rather than buried: the
//   field is a session credential, not a game input; the corrected value is one
//   the server itself issued to this tab seconds earlier; the request count,
//   target, mission, and fleet are untouched; and there is no gameplay
//   advantage in it — a player who reloads the page gets the same repair by
//   hand, which is precisely what the refusal forces them to do today.
//
// SAFETY — the one thing that could go wrong
//   If some rotation reached the page through a channel we do NOT observe
//   (a `fetch()` call, a full page load), our "newest" would be stale and
//   writing it anywhere would BREAK a request that would otherwise have
//   worked. So provenance is tracked explicitly: we only ever overwrite a
//   token value whose history we know (`seen` — the values the page held when
//   we installed, plus every value the server has issued us since). A value of
//   unknown provenance is left strictly alone — someone else knows something
//   we don't. And if a request we repaired is refused anyway, the model is
//   wrong by definition: after a few of those, the outgoing normalisation
//   disarms itself for the rest of the page's life.
//
// @ts-check

import { observeXHR } from './xhrObserver.js';
import { logger } from '../lib/logger.js';

/**
 * URLs worth scanning: the game's own two ajax entry points. Narrower than
 * "everything" so third-party traffic in the page is never inspected.
 */
const GAME_XHR = /(?:game\/index\.php|ajax\.php)/;

/**
 * The chat, which is a DIFFERENT TOKEN NAMESPACE on the same entry point.
 *
 * OGame's session does NOT own one ajax token — it owns two, and only one of
 * them is the page's. `game/index.php?page=ingame&component=chat&asJson=1`
 * (the `chatUrl` global) rotates `window.ajaxChatToken`, and its JSON answers
 * spell that value with the SAME field name every other endpoint uses:
 * `"newAjaxToken"`. The two values are unrelated 32-hex strings; sending one
 * where the other belongs is simply an invalid token.
 *
 * Before this filter the keeper could not tell them apart. Chat traffic
 * matched {@link GAME_XHR}, so a chat rotation was learned as {@link latest}
 * and {@link repairHolders} then wrote the CHAT token into `window.token` —
 * the very variable the rest of the game reads. Every page-token request after
 * that was refused by the server, permanently: the alliance tabs
 * (`fetchOverview` / `fetchManagement` / `fetchBroadcast` /
 * `fetchApplications` / `fetchClasses` all send `{token: token}`) answered
 * "An error has occured!" with HTTP 200, and because that body is not the JSON
 * `$.getJSON` expects, the game's own `updateToken` never ran to heal the
 * global — so one poisoned write locked the whole component out until reload.
 *
 * Chat is therefore excluded from BOTH halves: its tokens are never learned
 * and never recorded as provenance (a chat value sitting in `seen` would also
 * corrupt the generation ordering the rewrite guard depends on).
 */
const CHAT_XHR = /[?&]component=chat(?:&|$)/;

/** The freshly issued token, as it appears in any JSON envelope. */
const NEW_TOKEN_RE = /"newAjaxToken"\s*:\s*"([A-Za-z0-9]{16,64})"/;

/** Shape gate for anything we are willing to treat as a token. */
const TOKEN_SHAPE = /^[A-Za-z0-9]{16,64}$/;

/** The `token=` field inside a urlencoded request body. */
const BODY_TOKEN_RE = /(^|&)token=([^&]*)/;

/** The refusal this whole module exists to prevent (`ERR_TOKEN_SPENT`). */
const ERROR_100_RE = /"error"\s*:\s*100\b/;

/**
 * Switch for the OUTGOING half — substituting a spent `token` inside a
 * `checkTarget` body. **Ships ON since 2026-07-29**, and the measurement is
 * why.
 *
 * History, because the flip matters (it is the one place OG-E edits a field of
 * a request rather than only reading it — see `docs/fair-play.md`):
 *
 *   • 2026-07-28, first verification run: LEARN + REPAIR alone made the refusal
 *     disappear (`repairs: 5`, `rewrites: 0`), so we concluded the third party
 *     READS the page's token rather than caching it, and shipped the outgoing
 *     half disabled with only its detector live.
 *   • 2026-07-29, same universe, 1.54.0 (document_start already in effect):
 *     the refusal came back, and this time the detector named the cause —
 *     `staleOutgoing: 1`, `unknown: 0`, `repairs: 1`. The HAR shows why:
 *
 *       +185 ms  checkTarget  body `galaxy,system,position,type,token,union`
 *                             (the GAME's serialiser) sends 948c4f…, server
 *                             answers 258fcc… — 948c4f… is now spent.
 *       +3257 ms checkTarget  body `am203,…,union,token` — token appended
 *                             LAST, neither the game's field order nor ours —
 *                             replays 948c4f… ⇒ error 100.
 *
 *     Three seconds apart, so this is not a race: the sender held its own copy
 *     of a value the game had already spent, exactly the PRIVATE CACHE case
 *     (2) in the header. No amount of repairing shared page state reaches it —
 *     the only place left to correct it is the request itself.
 *
 * The substitution stays narrow by construction: `checkTarget` only (never
 * `sendFleet`, so no repair can ever be part of a fleet leaving), only ever
 * writes a value the server issued in this tab, refuses a token whose
 * provenance we cannot vouch for, refuses to move the token BACKWARDS (see
 * {@link generationOf}), and disarms itself permanently after
 * {@link FAILED_REWRITE_LIMIT} repaired-yet-refused requests.
 */
const NORMALISE_OUTGOING = true;

/**
 * How many repaired-but-still-refused requests it takes to conclude that our
 * notion of "newest" is wrong and stop rewriting outgoing bodies. Not 1: two
 * genuinely concurrent requests can legitimately race (the first rotates the
 * token while the second is already in flight), and that race would otherwise
 * disarm us on a healthy page.
 */
const FAILED_REWRITE_LIMIT = 3;

/** Provenance ring size — plenty; a session rotates a handful per minute. */
const SEEN_MAX = 40;

/** Per-instance marker: this request went out with a token WE substituted. */
const REPAIRED_FLAG = '_oge_tokenRepaired';

/** Per-instance send-order stamp — see {@link acceptedSeq}. */
const SEQ_FLAG = '_oge_tokenSeq';

// ─── module state ──────────────────────────────────────────────────────────

/** Newest token the server has issued in this tab, or `null` before the first. */
let latest = /** @type {string | null} */ (null);

/**
 * Monotonic send counter and the highest stamp whose rotation we accepted.
 *
 * Responses can land out of order, and "arrived last" is NOT "issued last" —
 * the server rotates per request in ARRIVAL order, which tracks send order,
 * not response order. So a rotation is only accepted from a request that was
 * sent no earlier than the one we last learned from; otherwise a slow early
 * response would downgrade us to a token the server already retired (and this
 * module would become the very bug it fixes).
 */
let seq = 0;
let acceptedSeq = -1;

/**
 * Tokens whose provenance we know: what the page held at install time plus
 * every value the server has issued since. Anything in here that is not
 * {@link latest} is spent, and therefore safe to overwrite. Values seen ONLY
 * in an outgoing request are deliberately NOT recorded — they may have come
 * from a rotation we missed, i.e. be NEWER than ours.
 */
const seen = new Set();
/** Insertion order for {@link seen}, so the ring can evict the oldest. */
const seenOrder = /** @type {string[]} */ ([]);

/** Outgoing normalisation gives up after {@link FAILED_REWRITE_LIMIT}. */
let rewriteDisarmed = false;

const stats = {
  /** Game requests seen at all — 0 means we installed too late to matter. */
  requests: 0,
  /** Rotations observed. */
  rotations: 0,
  /** Holder writes performed (a stranded update we un-stranded). */
  repairs: 0,
  /** Outgoing bodies caught carrying a spent token (counted even when we
   * are not allowed to touch them — see {@link NORMALISE_OUTGOING}). */
  staleOutgoing: 0,
  /** Outgoing bodies whose spent token we actually replaced. */
  rewrites: 0,
  /** Requests we repaired that were refused anyway. */
  failedRewrites: 0,
  /** Values left alone because we could not vouch for their provenance. */
  unknown: 0,
  /** Rotations refused because applying them would have moved us BACKWARDS. */
  downgrades: 0,
  /** Rotations refused by the send-order guard (a response that arrived late). */
  outOfOrder: 0,
};

/**
 * How many decisions the diagnostic ring keeps.
 *
 * Why a ring at all: the counters say WHAT happened but never WHY, and on the
 * 2026-07-29 capture that gap cost a full round of guesswork — five game
 * requests carrying four distinct tokens produced `rotations: 2`, and nothing
 * in the snapshot said which two learns were dropped or on which guard. The
 * ring makes the next reproduction self-explanatory instead of inferred.
 */
const DECISIONS_MAX = 20;

/**
 * Masked, ordered trail of what the keeper decided, newest last. Tokens are
 * truncated to the same 4 characters `__ogeToken()` already exposes, so the
 * trail stays safe to paste into a bug report.
 *
 * @type {string[]}
 */
const decisions = [];

/**
 * Append one decision to {@link decisions}.
 *
 * @param {string} what  Short verb — `rot`, `skip:same`, `rewrite`, …
 * @param {string | null | undefined} token  Token the decision was about.
 * @param {string} [note]  Optional detail (a counter, a holder label).
 * @returns {void}
 */
const trace = (what, token, note) => {
  decisions.push(`${what} ${token ? token.slice(0, 4) : '—'}${note ? ` ${note}` : ''}`);
  if (decisions.length > DECISIONS_MAX) decisions.shift();
};

/** @type {(() => void) | null} */
let unsubscribeFn = null;

// ─── provenance ────────────────────────────────────────────────────────────

/**
 * Record a token whose history we know.
 *
 * @param {unknown} value
 * @returns {void}
 */
const note = (value) => {
  if (typeof value !== 'string' || !TOKEN_SHAPE.test(value)) return;
  if (seen.has(value)) return;
  seen.add(value);
  seenOrder.push(value);
  if (seenOrder.length > SEEN_MAX) {
    const dropped = seenOrder.shift();
    if (dropped !== undefined) seen.delete(dropped);
  }
};

/**
 * May we overwrite `current` with {@link latest}? Only when it is empty or a
 * value we have positively seen the server issue (or the page hold at
 * install). Everything else is somebody else's newer knowledge.
 *
 * @param {unknown} current
 * @returns {boolean}
 */
const overwritable = (current) => {
  if (typeof current !== 'string' || current === '') return true;
  if (seen.has(current)) return true;
  stats.unknown += 1;
  return false;
};

/**
 * Position of a token in {@link seenOrder} — its GENERATION, i.e. how far along
 * the observed issue sequence it sits. `-1` for a value we never saw.
 *
 * This exists because "provenance is known" is a weaker statement than "this is
 * older than what I hold". `seen` answers the first; only order answers the
 * second, and the second is what makes writing safe: every token we act on
 * moves the page FORWARD along a sequence the server itself dictated, never
 * back. That guard is what keeps a keeper whose {@link latest} has fallen
 * behind (a rotation that reached the page through a channel we do not observe,
 * or one our own ordering guard discarded) from turning a request that would
 * have worked into one that cannot.
 *
 * Note the ordering is ARRIVAL order of first observation, which is exactly
 * right here: `note()` pushes a token the moment we first see it, so a value
 * that is new to us always lands at the end (highest generation), and a
 * response merely ECHOING a token we already knew keeps its original, lower
 * one. Comparing generations therefore distinguishes "the server issued
 * something newer" from "an old value came round again" — which the raw
 * response text cannot.
 *
 * @param {string} token
 * @returns {number}
 */
const generationOf = (token) => seenOrder.indexOf(token);

// ─── the page's token holders ──────────────────────────────────────────────

/**
 * Every place in the page that a request builder may read the token from.
 * Each entry reads and writes ONE holder; a missing holder yields `undefined`
 * from `read` and is skipped.
 *
 * `window.token` is the one the game itself reads (`appendTokenParams()`).
 * `fleetDispatcher.token` is the constructor's page-load copy — the game
 * never refreshes it, so it is permanently stale by design and a prime
 * suspect for what a third-party serialiser picks up. The hidden inputs are
 * what any form-based POST would carry.
 *
 * @returns {Array<{ label: string, read: () => unknown, write: (t: string) => void }>}
 */
const holders = () => {
  const w = /** @type {any} */ (window);
  /** @type {Array<{ label: string, read: () => unknown, write: (t: string) => void }>} */
  const list = [
    {
      label: 'window.token',
      read: () => w.token,
      write: (t) => {
        w.token = t;
      },
    },
  ];
  if (w.fleetDispatcher && typeof w.fleetDispatcher === 'object') {
    list.push({
      label: 'fleetDispatcher.token',
      read: () => w.fleetDispatcher.token,
      write: (t) => {
        w.fleetDispatcher.token = t;
      },
    });
  }
  for (const el of document.querySelectorAll('input[name="token"]')) {
    const input = /** @type {HTMLInputElement} */ (el);
    // Never touch a field OG-E itself injected (every OG-E element carries an
    // `oge` id/class prefix). Belt to the provenance braces: today OG-E puts no
    // such input in the game page, and this keeps that true by construction.
    if (input.closest('[id^="oge"],[class*="oge-"]')) continue;
    list.push({
      label: 'input[name=token]',
      read: () => input.value,
      write: (t) => {
        input.value = t;
      },
    });
  }
  return list;
};

/**
 * Record whatever the page holds right now as known-provenance.
 *
 * Called at install AND again just before the first rotation is applied: at
 * `document_start` there may be no `window.token` yet, and a value that only
 * appears later would otherwise look like somebody else's newer knowledge and
 * be left alone — the exact case this module exists to fix. Safe by ordering:
 * anything a holder contains before our first observed response landed was set
 * earlier than that response, so it cannot be fresher than what we learned.
 *
 * @returns {void}
 */
const seedProvenance = () => {
  for (const h of holders()) {
    try {
      note(h.read());
    } catch {
      // exotic getter — skip
    }
  }
};

/**
 * Bring the page's holders in line with {@link latest}.
 *
 * Deliberately a no-op on the happy path: when the game's own `updateToken`
 * ran, every holder already agrees and we write nothing at all.
 *
 * @returns {void}
 */
const repairHolders = () => {
  if (!latest) return;
  let repaired = 0;
  let visible = 0;

  for (const h of holders()) {
    /** @type {unknown} */
    let current;
    try {
      current = h.read();
    } catch {
      continue; // exotic getter — not our business
    }
    if (current === undefined || current === null) continue;
    // An EMPTY holder is skipped rather than filled: a blank field is not the
    // stale-token bug we are here for, and refusing to write into one keeps us
    // clear of any unrelated `input[name=token]` that some other script (or a
    // future OG-E panel) might put in the page. Everything non-empty still has
    // to clear the provenance check below.
    if (current === '') continue;
    visible += 1;
    if (current === latest) continue;
    if (!overwritable(current)) {
      logger.warn('[ajaxTokenKeeper] holder holds a token of unknown provenance — left alone', {
        holder: h.label,
      });
      continue;
    }
    // DIRECTION, same rule the outgoing rewrite obeys: only ever move a holder
    // FORWARD along the sequence the server issued. `overwritable` says we know
    // where the current value came from; it does NOT say ours is newer, and the
    // repair path used to take that on faith — which is what let a rotation
    // learned from the wrong source (the chat namespace, before CHAT_XHR) stomp
    // a perfectly live `window.token`. Refusing is always safe: the worst case
    // is the stale-token refusal the player would have seen anyway.
    if (generationOf(latest) <= generationOf(/** @type {string} */ (current))) {
      trace('repair:noforward', /** @type {string} */ (current), `have=${latest.slice(0, 4)}`);
      continue;
    }
    try {
      h.write(latest);
      repaired += 1;
    } catch {
      // Read-only property; nothing to do but move on.
    }
  }

  if (repaired === 0 && visible > 0) return;

  // Either we just corrected a stranded holder, or the token is not visible to
  // us at all (bundled in a module scope). Both cases are exactly what the
  // game's OWN setter is for: it writes whichever variable the game reads,
  // whatever its scope. Called only in those two cases, so a healthy page
  // never sees us touch it.
  const setter = /** @type {any} */ (window).fleetDispatcher?.updateToken;
  if (typeof setter === 'function') {
    try {
      setter.call(/** @type {any} */ (window).fleetDispatcher, latest);
    } catch {
      // The game's own setter threw — nothing further we can do here.
    }
  }

  if (repaired > 0) {
    stats.repairs += repaired;
    trace('repair', latest, `holders=${repaired}`);
    logger.warn('[ajaxTokenKeeper] page was holding a spent ajax token — repaired', {
      holders: repaired,
      totalRepairs: stats.repairs,
    });
  }
};

// ─── install ───────────────────────────────────────────────────────────────

/**
 * Install the keeper. Idempotent — a second call returns the same unsubscribe
 * without registering a second pair of observers.
 *
 * Install EARLY (first in page.js): the sooner the first response is seen, the
 * fewer requests can go out on a retired token.
 *
 * @returns {() => void} Unsubscribe.
 */
export const installAjaxTokenKeeper = () => {
  if (unsubscribeFn) return unsubscribeFn;

  seedProvenance();

  const unsubLoad = observeXHR({
    urlPattern: GAME_XHR,
    on: 'load',
    handler: ({ xhr, url, response }) => {
      if (CHAT_XHR.test(url)) return; // other namespace — see CHAT_XHR
      if (typeof response !== 'string' || response === '') return;

      // A request WE repaired that was refused anyway ⇒ our "newest" is not
      // the server's. A couple of those are a legitimate in-flight race; more
      // than that and we stop touching outgoing traffic for good.
      const repairedWith = /** @type {any} */ (xhr)[REPAIRED_FLAG];
      if (typeof repairedWith === 'string' && ERROR_100_RE.test(response)) {
        stats.failedRewrites += 1;
        trace('refused', repairedWith, `n=${stats.failedRewrites}`);
        if (!rewriteDisarmed && stats.failedRewrites >= FAILED_REWRITE_LIMIT) {
          rewriteDisarmed = true;
          logger.error(
            '[ajaxTokenKeeper] repaired requests keep being refused — disarming token normalisation',
            { failedRewrites: stats.failedRewrites },
          );
        }
      }

      const m = NEW_TOKEN_RE.exec(response);
      if (!m) return;
      const fresh = m[1];
      note(fresh);
      if (fresh === latest) return;

      // Downgrade guard. Not every response that carries `newAjaxToken` is
      // reporting a ROTATION — `fetchEventBox` / `catchEvents` merely echo the
      // session's current value. So a slow echo can land after a `checkTarget`
      // has already rotated past it and would otherwise be "learned",
      // downgrading us to a token the server retired: this module becoming the
      // very bug it exists to fix. A value we have already seen and that sits
      // EARLIER in the issue sequence than what we hold can only be such an
      // echo. (A genuinely new token was just pushed to the end by `note`, so
      // it always compares as newer and passes.) This is deliberately
      // independent of the send-order stamp below — it holds even for a request
      // we never stamped.
      if (latest !== null && generationOf(fresh) < generationOf(latest)) {
        stats.downgrades += 1;
        trace('skip:older', fresh, `have=${latest.slice(0, 4)}`);
        return;
      }

      // Out-of-order guard: learn only from a request sent no earlier than the
      // one we last learned from. Requests that predate the install carry no
      // stamp and count as the beginning of time.
      const stamp = /** @type {any} */ (xhr)[SEQ_FLAG];
      const at = typeof stamp === 'number' ? stamp : 0;
      if (at < acceptedSeq) {
        stats.outOfOrder += 1;
        trace('skip:order', fresh, `seq=${at}<${acceptedSeq}`);
        return;
      }
      acceptedSeq = at;

      if (latest === null) seedProvenance();
      latest = fresh;
      stats.rotations += 1;
      trace('rot', fresh, `seq=${at}`);

      // The game's own callback for this very response has already run by now
      // (its handler was registered before send; ours inside it), so if the
      // update was going to be stranded, it already is — and we fix it here.
      repairHolders();
    },
  });

  const unsubSend = observeXHR({
    urlPattern: GAME_XHR,
    on: 'send',
    rewritesBody: true,
    handler: ({ xhr, url, body }) => {
      if (CHAT_XHR.test(url)) return; // other namespace — see CHAT_XHR

      // Stamp EVERY game request with its send order — that is what makes the
      // load handler's out-of-order guard possible.
      stats.requests += 1;
      seq += 1;
      /** @type {any} */ (xhr)[SEQ_FLAG] = seq;

      // Everything below is scoped to checkTarget: it is the one endpoint known
      // to spend the token, the only one observed to refuse over it, and the one
      // whose worst case is a re-validated target — never a fleet leaving.
      if (!/action=checkTarget/.test(url)) return;
      if (!latest || typeof body !== 'string') return;
      const m = BODY_TOKEN_RE.exec(body);
      if (!m) return;
      const sent = m[2];
      if (sent === latest) return;
      // Provenance check BEFORE anything else: a value we cannot vouch for
      // might be NEWER than ours, and downgrading it would break a request
      // that was about to succeed.
      if (!seen.has(sent)) {
        stats.unknown += 1;
        trace('out:unknown', sent);
        return;
      }

      // DETECTION — a sender is replaying a value the server retired. Since
      // 2026-07-29 this is also the signal we ACT on; the counter stays because
      // it is the only way to tell "the fix is working" from "the fix never had
      // to fire".
      stats.staleOutgoing += 1;
      logger.warn('[ajaxTokenKeeper] outgoing checkTarget carries a spent token', {
        staleOutgoing: stats.staleOutgoing,
        willSubstitute: NORMALISE_OUTGOING && !rewriteDisarmed,
      });
      if (!NORMALISE_OUTGOING || rewriteDisarmed) {
        trace('out:stale', sent, rewriteDisarmed ? 'disarmed' : 'detect-only');
        return;
      }

      // DIRECTION. Substitute only when our value is provably LATER in the
      // issue sequence than the one being sent. `seen.has(sent)` above says we
      // know where the outgoing token came from; it does NOT say ours is newer.
      // If our `latest` has fallen behind — a rotation delivered through a
      // channel we cannot observe, or one the guards above discarded — then
      // writing it in would replace a token that might still be live with one
      // that certainly is not, breaking a request that was about to succeed.
      // Refusing is always safe: the worst case is the refusal the player would
      // have seen anyway.
      if (generationOf(latest) <= generationOf(sent)) {
        trace('out:noforward', sent, `have=${latest.slice(0, 4)}`);
        return;
      }

      /** @type {any} */ (xhr)[REPAIRED_FLAG] = latest;
      stats.rewrites += 1;
      trace('rewrite', sent, `→${latest.slice(0, 4)}`);
      const prefixEnd = m.index + m[1].length;
      return `${body.slice(0, prefixEnd)}token=${latest}${body.slice(m.index + m[0].length)}`;
    },
  });

  // Support affordance: a masked, read-only snapshot the user can paste back
  // ("is the keeper doing anything?") without leaking a live session token.
  // Never overwrites an existing property — the page is not ours.
  //
  // `installedAt` is the load stage we were installed at, and it is the FIRST
  // thing to read: anything other than `loading` means the manifest's
  // `document_start` is not in effect and every counter below is measuring a
  // page whose initialisation traffic we never saw (that was the whole 1.53.1
  // failure — see page.js's RUN_AT note).
  //
  // `log` is the second thing to read: the counters cannot say WHY a decision
  // went the way it did, and on a page where several scripts touch the token
  // that is exactly the question. See {@link DECISIONS_MAX}.
  const installedAt = document.readyState;
  try {
    const w = /** @type {any} */ (window);
    if (!('__ogeToken' in w)) {
      w.__ogeToken = () => ({
        installedAt,
        ...stats,
        disarmed: rewriteDisarmed,
        latest: latest ? `${latest.slice(0, 4)}…(${latest.length})` : null,
        log: decisions.slice(),
      });
    }
  } catch {
    // Sealed window — the diagnostics are optional.
  }

  unsubscribeFn = () => {
    unsubLoad();
    unsubSend();
    unsubscribeFn = null;
  };
  return unsubscribeFn;
};

/**
 * Test-only: detach the observers and clear the learned state.
 *
 * @returns {void}
 */
export const _resetAjaxTokenKeeperForTest = () => {
  if (unsubscribeFn) unsubscribeFn();
  unsubscribeFn = null;
  latest = null;
  seen.clear();
  seenOrder.length = 0;
  rewriteDisarmed = false;
  seq = 0;
  acceptedSeq = -1;
  stats.requests = 0;
  stats.rotations = 0;
  stats.staleOutgoing = 0;
  stats.repairs = 0;
  stats.rewrites = 0;
  stats.failedRewrites = 0;
  stats.unknown = 0;
  stats.downgrades = 0;
  stats.outOfOrder = 0;
  decisions.length = 0;
};
