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

  it('eventbox countdown is absolutely positioned and styled as a big chip', () => {
    installReadabilityBoost();
    const css = document.getElementById(STYLE_ID)?.textContent ?? '';
    // The countdown chip is the visual focal point of the box — if
    // this block drifts away, the box degenerates back to the squished
    // single-line AGR default.
    const countdownRule = css.match(
      /#eventboxFilled\s+\.countdown\s*\{([^}]*)\}/,
    );
    expect(countdownRule).not.toBeNull();
    const body = countdownRule?.[1] ?? '';
    expect(body).toContain('position: absolute');
    expect(body).toContain('font-size: 20px');
    expect(body).toContain('font-weight: 900');
  });

  it('parent chain gets overflow:visible so the countdown chip is not clipped', () => {
    // The chip uses position:absolute to escape its flex parent — any
    // ancestor with overflow:hidden would clip it. These three ids are
    // the ones OGame/AGR wrap #eventboxFilled in; a regression that
    // drops them brings the clipping bug right back.
    installReadabilityBoost();
    const css = document.getElementById(STYLE_ID)?.textContent ?? '';
    expect(css).toContain('#messages_collapsed');
    expect(css).toContain('#message-wrapper');
    expect(css).toContain('#notificationbarcomponent');
    expect(css).toMatch(/overflow:\s*visible\s*!important/);
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
