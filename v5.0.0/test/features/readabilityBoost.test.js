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
  _resetReadabilityBoostForTest,
} from '../../src/features/readabilityBoost.js';

const STYLE_ID = 'oge5-readability-boost';

describe('readabilityBoost', () => {
  beforeEach(() => {
    _resetReadabilityBoostForTest();
    // Clear any leftover style from a previous run (dispose missed by
    // abnormal termination, happy-dom state carrying across files, etc).
    const existing = document.getElementById(STYLE_ID);
    if (existing) existing.remove();
  });

  afterEach(() => {
    _resetReadabilityBoostForTest();
  });

  it('creates <style id="oge5-readability-boost"> appended to document', () => {
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

  it('CSS rules include the two target selectors + !important', () => {
    installReadabilityBoost();

    const css = document.getElementById(STYLE_ID)?.textContent ?? '';
    expect(css).toContain('#eventboxFilled');
    expect(css).toContain('a.ago_movement.tooltip.ago_color_lightgreen');
    expect(css).toContain('!important');
    // Guard against accidental deletion of the bold override that
    // carries most of the perceptual contrast lift for the event box.
    expect(css).toContain('font-weight: bold');
    // Movement link bumped to `larger` — separate rule from the colour
    // override so the size lift actually lands on the anchor text.
    expect(css).toContain('font-size: larger');
  });

  it('#eventboxFilled descendant rule does NOT force a colour override', () => {
    // Earlier revisions set `color: #fff` on `#eventboxFilled *`, which
    // flattened the game's resource / status colour coding. The current
    // contract is: colour only on the root, bold on descendants. A
    // regression that re-adds `color:` into the `*` rule block would
    // silently break in-game palette semantics.
    installReadabilityBoost();

    const css = document.getElementById(STYLE_ID)?.textContent ?? '';
    const descendantRule = css.match(/#eventboxFilled\s+\*\s*\{([^}]*)\}/);
    expect(descendantRule).not.toBeNull();
    expect(descendantRule?.[1]).not.toContain('color:');
  });
});
