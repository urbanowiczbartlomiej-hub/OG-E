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
    expect(css).toContain('font-weight: bold');
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
    expect(body).toMatch(/color:\s*#ffe04b/);
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
    // it's not the same 20px used by the countdown.
    const m = body.match(/font-size:\s*(\d+)px/);
    expect(m).not.toBeNull();
    const fontSize = parseInt(m?.[1] ?? '0', 10);
    expect(fontSize).toBeLessThan(20);
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

  it('movement-link rule stacks vertically and leaves child colours alone', () => {
    // flex-direction: column + align-items: flex-start is what gets
    // "Floty: …" on top of "Ekspedycje: …" — and critically the rule
    // does NOT cascade colour through `*`, so the native red on
    // `.ago_color_palered` (Ekspedycje maxed) stays red.
    installReadabilityBoost();
    const css = document.getElementById(STYLE_ID)?.textContent ?? '';
    const linkRule = css.match(
      /a\.ago_movement\.tooltip\.ago_color_lightgreen\s*\{([^}]*)\}/,
    );
    expect(linkRule).not.toBeNull();
    const body = linkRule?.[1] ?? '';
    expect(body).toContain('flex-direction: column');
    expect(body).toContain('align-items: flex-start');
    // No universal-child rule targeting the anchor's descendants — if
    // one reappears, the red "Ekspedycje: 14/14" span loses its tint.
    expect(css).not.toMatch(
      /a\.ago_movement\.tooltip\.ago_color_lightgreen\s+\*/,
    );
  });
});
