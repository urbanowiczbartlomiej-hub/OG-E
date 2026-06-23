// @vitest-environment happy-dom
//
// Behavioural tests for the attack-alarm orchestrator. Detection is driven
// through DETERMINISTIC, synchronous paths — the install-time check and the
// `oge:eventBoxLoaded` re-check — rather than the MutationObserver, whose
// delivery timing would make the suite flaky.
//
// # What we cover
//
//   1. Style injection + install idempotency.
//   2. Feature OFF → a live attack flag raises nothing.
//   3. Feature ON + attack flag → overlay + banner shown, enriched text.
//   4. Flag clearing hides the alarm.
//   5. Dismiss (✕) mutes the current attack; an unchanged re-check stays
//      quiet, a changed fingerprint re-fires.
//   6. Toggling the setting off mid-attack hides the alarm.
//   7. Preview works regardless of the setting and auto-clears.
//   8. Dispose tears everything down.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  installThreatHighlight,
  _resetThreatHighlightForTest,
} from '../../src/features/threatHighlight/index.js';
import { settingsStore } from '../../src/state/settings.js';
import { EVENT_BOX_LOADED_EVENT, THREAT_HIGHLIGHT_TEST_EVENT } from '../../src/lib/ogeEvents.js';

const STYLE_ID = 'oge-threat-highlight-style';
const OVERLAY_ID = 'oge-threat-overlay';
const BANNER_ID = 'oge-threat-banner';

/** Create/update the top-bar attack flag. */
const setFlag = (/** @type {boolean} */ attacked) => {
  let el = document.getElementById('attack_alert');
  if (!el) {
    el = document.createElement('div');
    el.id = 'attack_alert';
    document.body.appendChild(el);
  }
  el.className = attacked ? 'tooltip' : 'tooltip noAttack';
  return el;
};

/**
 * Build `#eventContent` with the given hostile/fleet rows.
 *
 * @param {Array<{ missionType: string, isReturn?: boolean, hostile?: boolean, arrivalAt?: number, dest?: string }>} rows
 */
const setEventRows = (rows) => {
  document.getElementById('eventContent')?.remove();
  const table = document.createElement('table');
  table.id = 'eventContent';
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.className = 'eventFleet';
    tr.id = `eventRow-${i}`;
    tr.setAttribute('data-mission-type', r.missionType);
    tr.setAttribute('data-return-flight', r.isReturn ? 'true' : 'false');
    if (r.arrivalAt != null) tr.setAttribute('data-arrival-time', String(r.arrivalAt));
    if (r.hostile) {
      const s = document.createElement('span');
      s.className = 'hostile';
      tr.appendChild(s);
    }
    const dest = document.createElement('td');
    dest.className = 'destCoords';
    dest.textContent = r.dest || '';
    tr.appendChild(dest);
    table.appendChild(tr);
  });
  document.body.appendChild(table);
};

const overlayVisible = () => {
  const el = document.getElementById(OVERLAY_ID);
  return Boolean(el) && /** @type {HTMLElement} */ (el).style.display === 'block';
};
const bannerText = () => document.getElementById(BANNER_ID)?.textContent ?? '';

/** Future epoch-seconds arrival, so summaries report a finite soonest ETA. */
const soonArrival = () => Math.floor(Date.now() / 1000) + 120;

describe('threatHighlight', () => {
  beforeEach(() => {
    _resetThreatHighlightForTest();
    settingsStore.update((s) => ({ ...s, threatHighlight: false }));
    document.getElementById('attack_alert')?.remove();
    document.getElementById('eventContent')?.remove();
    document.getElementById(STYLE_ID)?.remove();
    document.getElementById(OVERLAY_ID)?.remove();
    document.getElementById(BANNER_ID)?.remove();
  });

  afterEach(() => {
    _resetThreatHighlightForTest();
    settingsStore.update((s) => ({ ...s, threatHighlight: false }));
    vi.useRealTimers();
  });

  it('injects its <style> and is idempotent', () => {
    const a = installThreatHighlight();
    const b = installThreatHighlight();
    expect(a).toBe(b);
    expect(document.querySelectorAll(`#${STYLE_ID}`).length).toBe(1);
    const css = document.getElementById(STYLE_ID)?.textContent ?? '';
    expect(css).toContain('@keyframes oge-threat-vig');
    expect(css).toContain('pointer-events: none');
  });

  it('does NOTHING for a live attack while the feature is off', () => {
    setFlag(true);
    installThreatHighlight();
    expect(document.getElementById(OVERLAY_ID)).toBeNull();
    expect(document.getElementById(BANNER_ID)).toBeNull();
  });

  it('raises the alarm on install when the flag is already attacked', () => {
    settingsStore.update((s) => ({ ...s, threatHighlight: true }));
    setFlag(true);
    setEventRows([
      { missionType: '1', hostile: true, arrivalAt: soonArrival(), dest: '[1:2:3]' },
    ]);
    installThreatHighlight();
    expect(overlayVisible()).toBe(true);
    expect(bannerText()).toContain('UNDER ATTACK');
    expect(bannerText()).toContain('1 hostile fleet');
    expect(bannerText()).toContain('[1:2:3]');
  });

  it('hides the alarm once the flag clears', () => {
    settingsStore.update((s) => ({ ...s, threatHighlight: true }));
    setFlag(true);
    installThreatHighlight();
    expect(overlayVisible()).toBe(true);

    setFlag(false);
    document.dispatchEvent(new CustomEvent(EVENT_BOX_LOADED_EVENT));
    expect(overlayVisible()).toBe(false);
  });

  it('dismiss mutes the current attack but re-fires when it escalates', () => {
    settingsStore.update((s) => ({ ...s, threatHighlight: true }));
    setFlag(true);
    setEventRows([{ missionType: '1', hostile: true, arrivalAt: soonArrival(), dest: '[1:2:3]' }]);
    installThreatHighlight();
    expect(overlayVisible()).toBe(true);

    // Dismiss → hidden, and an unchanged re-check stays quiet.
    /** @type {HTMLButtonElement} */ (
      document.querySelector(`#${BANNER_ID} .oge-threat-x`)
    ).click();
    expect(overlayVisible()).toBe(false);
    document.dispatchEvent(new CustomEvent(EVENT_BOX_LOADED_EVENT));
    expect(overlayVisible()).toBe(false);

    // A second incoming fleet changes the fingerprint → alarm returns.
    setEventRows([
      { missionType: '1', hostile: true, arrivalAt: soonArrival(), dest: '[1:2:3]' },
      { missionType: '2', hostile: true, arrivalAt: soonArrival() + 30, dest: '[4:5:6]' },
    ]);
    document.dispatchEvent(new CustomEvent(EVENT_BOX_LOADED_EVENT));
    expect(overlayVisible()).toBe(true);
    expect(bannerText()).toContain('2 hostile fleets');
  });

  it('hides the alarm when the setting is switched off mid-attack', () => {
    settingsStore.update((s) => ({ ...s, threatHighlight: true }));
    setFlag(true);
    installThreatHighlight();
    expect(overlayVisible()).toBe(true);

    settingsStore.update((s) => ({ ...s, threatHighlight: false }));
    expect(overlayVisible()).toBe(false);
  });

  it('previews on demand regardless of the setting, then auto-clears', () => {
    vi.useFakeTimers();
    // Feature OFF and no attack — preview must still show.
    installThreatHighlight();
    document.dispatchEvent(new CustomEvent(THREAT_HIGHLIGHT_TEST_EVENT));
    expect(overlayVisible()).toBe(true);
    expect(bannerText().toLowerCase()).toContain('preview');

    vi.advanceTimersByTime(10000);
    expect(overlayVisible()).toBe(false);
  });

  it('dispose removes overlay, banner and style', () => {
    settingsStore.update((s) => ({ ...s, threatHighlight: true }));
    setFlag(true);
    const dispose = installThreatHighlight();
    expect(document.getElementById(OVERLAY_ID)).not.toBeNull();

    dispose();
    expect(document.getElementById(OVERLAY_ID)).toBeNull();
    expect(document.getElementById(BANNER_ID)).toBeNull();
    expect(document.getElementById(STYLE_ID)).toBeNull();
  });
});
