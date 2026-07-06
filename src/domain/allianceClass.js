// @ts-check

// Pure helpers for the alliance CLASS — the combat / trade / research
// specialisation an alliance opts into. OGame does NOT expose it in the public
// XML API (alliances.xml is id/name/tag/members only). The ONLY machine-readable
// sources are (a) a spied espionage report's `allianceclass` field and (b) the
// in-game ALLIANCE highscore (page=highscore&category=2), where every row's name
// cell carries the class as a CSS token on `span.alliance_class`:
//
//   <span title="Wojownik (Sojusz)"          class="alliance_class small warrior">…</span>
//   <span title="Handlarz (Sojusz)"          class="alliance_class small trader">…</span>
//   <span title="Naukowiec (Sojusz)"         class="alliance_class small explorer">…</span>
//   <span title="Brak wyboru klasy sojuszu"  class="alliance_class small none">…</span>
//
// Verbatim game vocabulary (keep — a rename is a one-line fix here). NOTE the
// Researcher alliance's slug is `explorer` (it mirrors the Discoverer player
// class), NOT `researcher`. The danger model branches only on 'warrior', so
// 'trader' / 'explorer' are carried but not (yet) scored. 'none' is a REAL,
// meaningful value — a harvested "this alliance has no class" — kept distinct
// from undefined ("never harvested"), so the UI can tell known-no-class from
// unknown-go-look.
//
// Pure: no DOM, no storage, no time. The ingest feature reads the DOM and passes
// plain CSS tokens / row ids here; this module is unit-tested with plain fixtures.

/** The alliance-class CSS slugs OGame emits (besides 'none' = no class chosen). */
export const ALLIANCE_CLASS_SLUGS = /** @type {const} */ (['warrior', 'trader', 'explorer']);

/** Every token that can appear as the class marker, including 'none'. */
const CLASS_TOKENS = new Set([...ALLIANCE_CLASS_SLUGS, 'none']);

/**
 * The class marker out of a `span.alliance_class` element's CSS tokens. Returns
 * the slug ('warrior' | 'trader' | 'explorer' | 'none'), or undefined when the
 * span carries none of them (unexpected markup → the caller skips that row).
 * @param {Iterable<string>} tokens  e.g. a DOMTokenList ['alliance_class','small','warrior']
 * @returns {'warrior'|'trader'|'explorer'|'none'|undefined}
 */
export function allianceClassFromTokens(tokens) {
  for (const t of tokens) {
    if (CLASS_TOKENS.has(t)) return /** @type {'warrior'|'trader'|'explorer'|'none'} */ (t);
  }
  return undefined;
}

/**
 * Alliance id out of a highscore row's `id="position500921"`.
 * @param {string|undefined|null} rowId
 * @returns {string|undefined}
 */
export function allianceIdFromPositionId(rowId) {
  const m = /^position(\d+)$/.exec(rowId || '');
  return m ? m[1] : undefined;
}

/**
 * Is this resolved class the combat (warrior) alliance? The single tell the
 * danger model reads — one place so both danger sources (highscore + spy report)
 * ask the same question.
 * @param {string|undefined} slug
 * @returns {boolean}
 */
export const isWarriorAlliance = (slug) => slug === 'warrior';
