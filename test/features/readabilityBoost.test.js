// @vitest-environment happy-dom
//
// Unit tests for the readability-boost stylesheet injector.
//
// # What we cover
//
// The module has three observable surfaces:
//
//   1. DOM injection — a `<style>` with the stable id is appended to
//      the document (head preferred, documentElement as fallback).
//   2. Idempotency — a second install returns the same dispose without
//      creating a duplicate `<style>` element.
//   3. Dispose — calling the returned fn removes the injected node.
//   4. CSS payload — the stylesheet text contains both target selectors
//      and `!important` declarations. This is a contract test: if the
//      CSS drifts away from the two low-visibility selectors the feature
//      silently stops working in-page, so we assert on strings.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  installReadabilityBoost,
  stripCountdownUnitSuffix,
  relabelStatusLine,
  MOVEMENT_LINK_LABELS,
  _resetReadabilityBoostForTest,
} from '../../src/features/readabilityBoost.js';
import { settingsStore } from '../../src/state/settings.js';

const STYLE_ID = 'oge-readability-boost';

describe('readabilityBoost', () => {
  beforeEach(() => {
    _resetReadabilityBoostForTest();
    // Clear any leftover style from a previous run (dispose missed by
    // abnormal termination, happy-dom state carrying across files, etc).
    const existing = document.getElementById(STYLE_ID);
    if (existing) existing.remove();
    // Every test starts from "feature enabled" — tests that want the
    // disabled branch flip the flag explicitly.
    settingsStore.update((s) => ({ ...s, readabilityBoost: true }));
  });

  afterEach(() => {
    _resetReadabilityBoostForTest();
    settingsStore.update((s) => ({ ...s, readabilityBoost: true }));
  });

  it('creates <style id="oge-readability-boost"> appended to document', () => {
    installReadabilityBoost();

    const el = document.getElementById(STYLE_ID);
    expect(el).not.toBeNull();
    expect(el?.tagName).toBe('STYLE');
    // Mounted under head (or documentElement if head unavailable) —
    // either way it must be somewhere in the live document tree.
    expect(document.contains(el)).toBe(true);
  });

  it('is idempotent — second call returns same dispose and no duplicate <style>', () => {
    const disposeA = installReadabilityBoost();
    const disposeB = installReadabilityBoost();

    expect(disposeA).toBe(disposeB);
    const all = document.querySelectorAll(`#${STYLE_ID}`);
    expect(all.length).toBe(1);
  });

  it('dispose removes the style element', () => {
    const dispose = installReadabilityBoost();
    expect(document.getElementById(STYLE_ID)).not.toBeNull();

    dispose();
    expect(document.getElementById(STYLE_ID)).toBeNull();
  });

  it('CSS rules include both target selectors + !important', () => {
    installReadabilityBoost();

    const css = document.getElementById(STYLE_ID)?.textContent ?? '';
    expect(css).toContain('#eventboxFilled');
    expect(css).toContain('a.ago_movement.tooltip.ago_color_lightgreen');
    expect(css).toContain('!important');
    // Guard against accidental deletion of the bold override on the
    // movement anchor — that bold is what makes the small-screen
    // stacked lines readable.
    expect(css).toContain('font-weight: 700');
  });

  it('eventbox countdown is large, bold, and yellow (primary focal point)', () => {
    installReadabilityBoost();
    const css = document.getElementById(STYLE_ID)?.textContent ?? '';
    // Countdown holds the attention budget: user reads it repeatedly.
    // Mission-type changes rarely and stays small — if someone swaps
    // these two sizes back to symmetric, the UX regresses to "which
    // number am I supposed to be watching?".
    const countdownRule = css.match(
      /#eventboxFilled\s+\.next_event\s+\.countdown\s*\{([^}]*)\}/,
    );
    expect(countdownRule).not.toBeNull();
    const body = countdownRule?.[1] ?? '';
    expect(body).toMatch(/color:\s*#fcce00/);
    // Countdown must be DISTINCTLY larger than the mission-type
    // payload — the asymmetry is the whole point. We don't pin the
    // exact px so the design can be re-tuned without a test update,
    // we just guard against anyone shrinking it below a clearly-big
    // threshold.
    const fsMatch = body.match(/font-size:\s*(\d+)px/);
    expect(fsMatch).not.toBeNull();
    expect(parseInt(fsMatch?.[1] ?? '0', 10)).toBeGreaterThanOrEqual(24);
    expect(body).toMatch(/font-weight:\s*900/);
  });

  it('mission-type payload stays smaller than the countdown', () => {
    // .friendly / .hostile / .neutral share one rule that explicitly
    // sets a SMALL font-size. If the rule drifts up to match the
    // countdown, the box turns into visual noise.
    installReadabilityBoost();
    const css = document.getElementById(STYLE_ID)?.textContent ?? '';
    const missionRule = css.match(
      /#eventboxFilled\s+\.next_event\s+\.friendly,[^{]*\{([^}]*)\}/,
    );
    expect(missionRule).not.toBeNull();
    const body = missionRule?.[1] ?? '';
    // The actual number is whatever the rule says — we just assert
    // it stays distinctly smaller than the countdown's 50 px so the
    // focal-point asymmetry survives. Countdown is 50, mission-type
    // sits well below; 30 is a comfortable upper bound.
    const m = body.match(/font-size:\s*(\d+)px/);
    expect(m).not.toBeNull();
    const fontSize = parseInt(m?.[1] ?? '0', 10);
    expect(fontSize).toBeLessThan(30);
  });

  it('both status rows ("Następna:" and "Rodzaj:") get the hide trick', () => {
    // Both `.next_event` wrappers carry a label ("Następna:" /
    // "Rodzaj:") we want gone and a nested payload (countdown digits
    // or mission-type span) we want visible. Single rule on the
    // parent sets font-size: 0, then the child selectors re-enable
    // rendering at an explicit size. A regression that narrows the
    // parent selector (e.g. `:has(.countdown)` again) would let the
    // "Rodzaj:" label leak back into the box.
    installReadabilityBoost();
    const css = document.getElementById(STYLE_ID)?.textContent ?? '';
    expect(css).toMatch(
      /#eventboxFilled\s+\.next_event\s*\{[^}]*font-size:\s*0/,
    );
    // The nested payload selectors must include .friendly/.hostile/
    // .neutral so the mission-type row survives the hide. This is the
    // direct fix for the reported "Rodzaj: visible" bug.
    expect(css).toContain('.next_event .friendly');
    expect(css).toContain('.next_event .hostile');
    expect(css).toContain('.next_event .neutral');
    expect(css).toContain('.next_event .countdown');
  });

  // ── Messages paginator ──────────────────────────────────────────
  //
  // Three constraints, each one a bug we already shipped once:
  //   1. the arrows grow by TRANSFORM (resizing the box stretches the
  //      16px-cut skin off the glyph),
  //   2. we never set `display` on the row (OGame hides a single-page pager
  //      with an inline `display:none` that an !important display beats),
  //   3. the pinned row clears the fixed 19px #siteFooter.

  it('paginator arrows are enlarged by transform, not by resizing the box', () => {
    installReadabilityBoost();
    const css = document.getElementById(STYLE_ID)?.textContent ?? '';
    const rule = css.match(/\.messagePaginator gradient-button\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    const body = rule?.[1] ?? '';
    expect(body).toMatch(/transform:\s*scale\(/);
    expect(body).not.toMatch(/(?:^|\s)(?:width|height):/);
  });

  it('never forces `display` on the paginator row (game hides it inline)', () => {
    installReadabilityBoost();
    const css = document.getElementById(STYLE_ID)?.textContent ?? '';
    // Every rule whose selector is the row itself — the wrapper divs and the
    // hide-the-duplicate rule are allowed to set display, the row is not.
    // Selector is the row and nothing else — no descendant, no :has() (the
    // wrapper divs and the hide-the-duplicate rule may set display freely).
    for (const m of css.matchAll(/\.messagePaginator(:[a-z-]+)?\s*\{([^}]*)\}/g)) {
      expect(m[2]).not.toMatch(/display:/);
    }
  });

  it('the duplicate top pager is hidden and the surviving one is pinned clear of #siteFooter', () => {
    installReadabilityBoost();
    const css = document.getElementById(STYLE_ID)?.textContent ?? '';
    // Hidden by "another pager follows me", so a lone pager is never hidden.
    expect(css).toMatch(/\.messagePaginator:has\(~ \.messagePaginator\)\s*\{[^}]*display:\s*none/);
    // Pinned by "no pager follows me" — the mirror of the hide rule above.
    // NOT :last-child: the bottom pager is not guaranteed to be the final
    // child of its container, and when it isn't, nothing gets pinned at all.
    const pinned = css.match(
      /\.messagePaginator:not\(:has\(~ \.messagePaginator\)\)\s*\{([^}]*)\}/,
    );
    expect(pinned).not.toBeNull();
    const body = pinned?.[1] ?? '';
    // fixed, not sticky: sticky is clamped to its own containing block, so an
    // ancestor that scrolls (or ends right below the pager) lifts it nowhere.
    expect(body).toMatch(/position:\s*fixed/);
    expect(body).not.toMatch(/position:\s*sticky/);
    // #siteFooter is fixed at bottom:0 with height:19px — pinning at 0 would
    // park the arrows underneath it.
    const bottom = body.match(/bottom:\s*(\d+)px/);
    expect(bottom).not.toBeNull();
    expect(parseInt(bottom?.[1] ?? '0', 10)).toBeGreaterThanOrEqual(19);
  });

  it('gives back the flow space the fixed pager no longer takes', () => {
    // A fixed box holds no space in the flow, so without this the strip sits
    // on the last message. Scoped with :has() so only a page with a pager pays.
    installReadabilityBoost();
    const css = document.getElementById(STYLE_ID)?.textContent ?? '';
    const rule = css.match(/body:has\(\.messagePaginator\)\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    const pad = rule?.[1].match(/padding-bottom:\s*(\d+)px/);
    expect(pad).not.toBeNull();
    // Taller than the pinned strip itself (scaled arrows + its 19px offset).
    expect(parseInt(pad?.[1] ?? '0', 10)).toBeGreaterThanOrEqual(54);
  });

  it('the arrow wrappers are widened past the game\'s fixed 20px', () => {
    // `#messages .firstPage…` pins each wrapper to 20px, so a scaled 35px
    // arrow overhangs its own flex item and reads as touching its neighbour.
    installReadabilityBoost();
    const css = document.getElementById(STYLE_ID)?.textContent ?? '';
    const rule = css.match(/\.messagePaginator \.firstPage,[^{]*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    const width = rule?.[1].match(/width:\s*(\d+)px/);
    expect(width).not.toBeNull();
    expect(parseInt(width?.[1] ?? '0', 10)).toBeGreaterThanOrEqual(35);
  });

  it('removes the <style> when settings.readabilityBoost flips to false', () => {
    installReadabilityBoost();
    expect(document.getElementById(STYLE_ID)).not.toBeNull();

    settingsStore.update((s) => ({ ...s, readabilityBoost: false }));
    expect(document.getElementById(STYLE_ID)).toBeNull();

    // Flipping back on re-injects — same contract.
    settingsStore.update((s) => ({ ...s, readabilityBoost: true }));
    expect(document.getElementById(STYLE_ID)).not.toBeNull();
  });

  // ── stripCountdownUnitSuffix — pure helper ──────────────────────

  describe('stripCountdownUnitSuffix', () => {
    it('strips Polish "sek." AND compacts "min." to "m"', () => {
      expect(stripCountdownUnitSuffix('42min. 56sek.')).toBe('42m 56');
    });

    it('strips English "sec." AND compacts "min."', () => {
      expect(stripCountdownUnitSuffix('1h 23min. 45sec.')).toBe('1h 23m 45');
    });

    it('strips single-letter "s" suffix', () => {
      expect(stripCountdownUnitSuffix('2min. 7s')).toBe('2m 7');
    });

    it('strips "sek" with no trailing dot', () => {
      expect(stripCountdownUnitSuffix('12sek')).toBe('12');
    });

    it('compacts a minutes-only countdown to "Nm"', () => {
      // The game briefly renders a countdown without seconds on the
      // minute roll-over. Before the minute rewrite this string used
      // to pass through untouched; now it compacts to "42m" — still
      // shorter than the original, still unambiguous.
      expect(stripCountdownUnitSuffix('42min.')).toBe('42m');
    });

    it('preserves hours ("h") and other non-minute units', () => {
      // Only the minutes suffix is rewritten. Hours keep their "h",
      // days keep whatever locale suffix the game uses.
      expect(stripCountdownUnitSuffix('2h 0min. 0sek.')).toBe('2h 0m 0');
    });

    it('leaves non-numeric expiry strings alone', () => {
      // OGame renders "teraz" / "now" / similar on countdown expiry.
      // Stripping those would leave an empty box.
      expect(stripCountdownUnitSuffix('teraz')).toBe('teraz');
      expect(stripCountdownUnitSuffix('now')).toBe('now');
      expect(stripCountdownUnitSuffix('')).toBe('');
    });

    it('is idempotent — second application is a no-op', () => {
      const once = stripCountdownUnitSuffix('42min. 56sek.');
      expect(stripCountdownUnitSuffix(once)).toBe(once);
    });
  });

  // ── relabelStatusLine — pure helper ─────────────────────────────

  describe('relabelStatusLine', () => {
    it('replaces the locale label but keeps the used/total counts', () => {
      expect(relabelStatusLine('Floty: 35/37', MOVEMENT_LINK_LABELS.fleets))
        .toBe('Fleets: 35/37');
      expect(
        relabelStatusLine('Ekspedycje: 15/15', MOVEMENT_LINK_LABELS.expeditions),
      ).toBe('Expos: 15/15');
    });

    it('is locale-agnostic — parses only the trailing count pair', () => {
      expect(relabelStatusLine('Flotten: 1/12', MOVEMENT_LINK_LABELS.fleets))
        .toBe('Fleets: 1/12');
      expect(relabelStatusLine('Флот: 9/11', MOVEMENT_LINK_LABELS.fleets))
        .toBe('Fleets: 9/11');
    });

    it('tolerates spaces around the slash', () => {
      expect(relabelStatusLine('Floty: 3 / 9', MOVEMENT_LINK_LABELS.fleets))
        .toBe('Fleets: 3/9');
    });

    it('is idempotent on already-relabelled text', () => {
      const once = relabelStatusLine('Floty: 35/37', MOVEMENT_LINK_LABELS.fleets);
      expect(relabelStatusLine(once, MOVEMENT_LINK_LABELS.fleets)).toBe(once);
    });

    it('returns the input untouched when no count pair is present', () => {
      expect(relabelStatusLine('Floty: brak', MOVEMENT_LINK_LABELS.fleets))
        .toBe('Floty: brak');
    });
  });

  it('movement-link rule stacks vertically regardless of AGR colour modifier', () => {
    // Layout (flex column + bold + bigger font) is applied to the bare
    // `a.ago_movement.tooltip` selector so the rule fires for BOTH the
    // lightgreen ("slots free") and palered ("37/37 — fleets capped")
    // variants AGR may swap the anchor between. The lightgreen-only
    // sibling rule supplies the green tint without forcing it onto the
    // palered case.
    installReadabilityBoost();
    const css = document.getElementById(STYLE_ID)?.textContent ?? '';
    // The layout rule lives in a multi-selector that ALSO targets the
    // step-2 wrapper anchor (`#ago_summary_fleets > a.tooltip`) — AGR
    // drops the `ago_movement` class on the fleet2 page, so a single
    // selector would miss it. We match across the selector list to the
    // body, then assert the column-flex contract.
    const layoutRule = css.match(
      /a\.ago_movement\.tooltip\s*,[^{]*\{([^}]*)\}/,
    );
    expect(layoutRule).not.toBeNull();
    const body = layoutRule?.[1] ?? '';
    expect(body).toContain('flex-direction: column');
    expect(body).toContain('align-items: flex-start');
    // Step-2 anchor is part of the SAME layout rule — guard against a
    // future split that forgets the fleet2 wrapper.
    expect(layoutRule?.[0] ?? '').toContain('#ago_summary_fleets');
    // The lightgreen-tint rule is still present for the "slots free"
    // case, but it does NOT carry layout — only the colour. Same
    // multi-selector shape: step-1 anchor + step-2 wrapper anchor.
    expect(css).toMatch(
      /a\.ago_movement\.tooltip\.ago_color_lightgreen\s*,[^{]*\{[^}]*color:\s*#4af74d/,
    );
    expect(css).toMatch(
      /#ago_summary_fleets\s*>\s*a\.tooltip\.ago_color_lightgreen[^{]*\{[^}]*color:\s*#4af74d/,
    );
    // No universal-child rule cascading colour into descendants — if
    // one reappears, the red "Ekspedycje: 14/14" span loses its tint.
    expect(css).not.toMatch(
      /a\.ago_movement\.tooltip[^{]*\s+\*\s*\{/,
    );
  });

  it('brightens AGR\'s pale-red "capped" variant for both anchor and inner span', () => {
    // The native AGR salmon washes out on the dark card (barely legible on
    // small mobile viewports), so we brighten it to a vivid red — for the
    // anchor itself when the whole link is palered (fleets capped) AND for
    // the inner palered span (expeditions capped). Still a warning colour,
    // just readable.
    installReadabilityBoost();
    const css = document.getElementById(STYLE_ID)?.textContent ?? '';
    // Anchor-level palered (fleets capped → bare fleets text node).
    expect(css).toMatch(
      /a\.ago_movement\.tooltip\.ago_color_palered[^{]*\{[^}]*color:\s*#ff5d5d/,
    );
    // Inner palered span (expeditions capped).
    expect(css).toMatch(
      /a\.ago_movement\.tooltip\s+\.ago_color_palered[^{]*\{[^}]*color:\s*#ff5d5d/,
    );
    // Both must also cover the step-2 wrapper anchor.
    expect(css).toContain('#ago_summary_fleets > a.tooltip.ago_color_palered');
    expect(css).toContain('#ago_summary_fleets > a.tooltip .ago_color_palered');
  });

  it('pins a cross-device font on the movement box so width matches phone vs desktop', () => {
    // We inherit OGame's wide Verdana on desktop but Android falls back to
    // the much narrower Roboto, so the label looked narrower on the phone.
    // Pinning Roboto → Arial → sans-serif makes both platforms render a
    // close-width typeface instead of diverging.
    installReadabilityBoost();
    const css = document.getElementById(STYLE_ID)?.textContent ?? '';
    const layoutRule = css.match(/a\.ago_movement\.tooltip\s*,[^{]*\{([^}]*)\}/);
    expect(layoutRule?.[1] ?? '').toMatch(
      /font-family:\s*Roboto,\s*Arial,\s*sans-serif/,
    );
  });

  it('pins the same cross-device font on the notification bar', () => {
    installReadabilityBoost();
    const css = document.getElementById(STYLE_ID)?.textContent ?? '';
    // Component + its descendants (the nested message spans) get the font.
    expect(css).toMatch(
      /#notificationbarcomponent[^{]*\{[^}]*font-family:\s*Roboto,\s*Arial,\s*sans-serif/,
    );
    expect(css).toContain('#notificationbarcomponent *');
  });

  it('unpins AGR\'s fixed 185px width on the step-2 wrapper so the bigger font does not wrap', () => {
    // #ago_fleet2 #ago_summary_fleets is sized to a fixed 185px by AGR; our
    // larger font wraps inside it and the overflow hides under the component
    // below. We override to width:auto (+ drop the margin) at matching
    // two-ID specificity.
    installReadabilityBoost();
    const css = document.getElementById(STYLE_ID)?.textContent ?? '';
    const rule = css.match(/#ago_fleet2\s+#ago_summary_fleets\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    const body = rule?.[1] ?? '';
    expect(body).toMatch(/width:\s*auto\s*!important/);
    expect(body).toMatch(/margin:\s*0\s*!important/);
  });
});
