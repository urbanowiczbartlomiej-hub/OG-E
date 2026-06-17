// Unit tests for domain/reminderTemplates — the pure message-template shape,
// defaults, normalisation, the wildcard renderer and its token linting.
// Node env — pure data, no DOM.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import {
  REMINDER_KINDS,
  PRESET_ICONS,
  iconFileFor,
  TEMPLATE_FIELDS,
  defaultReminderTemplates,
  normalizeReminderTemplate,
  normalizeReminderTemplates,
  renderTemplate,
  templateTokens,
  unknownTokens,
} from '../../src/domain/reminderTemplates.js';

describe('defaultReminderTemplates', () => {
  it('reproduces the historical hardcoded bodies, icons and priorities', () => {
    const d = defaultReminderTemplates();
    expect(d.wave).toEqual({
      body: 'Expeditions back ({returnTime}) — reminder #{index}/{total}.',
      icon: 'default',
      priority: 3,
    });
    expect(d.adhoc).toEqual({
      body: '{label} — arrives {arrivalTime}. 🔥',
      icon: 'urgent',
      priority: 5,
    });
    expect(d.fleetSave).toEqual({
      body: 'Fleet save: {label} — lands {landTime} ({offset}). 🔥',
      icon: 'urgent',
      priority: 5,
    });
  });

  it('returns a fresh object each call', () => {
    expect(defaultReminderTemplates()).not.toBe(defaultReminderTemplates());
  });

  it('covers exactly the three kinds', () => {
    expect(Object.keys(defaultReminderTemplates()).sort()).toEqual([...REMINDER_KINDS].sort());
  });
});

describe('iconFileFor', () => {
  it('maps a known preset id to its asset filename', () => {
    expect(iconFileFor('default')).toBe('icon128.png');
    expect(iconFileFor('urgent')).toBe('icon_red.png');
  });

  it('falls back to the first preset for unknown / missing ids', () => {
    expect(iconFileFor('nope')).toBe(PRESET_ICONS[0].file);
    expect(iconFileFor(undefined)).toBe(PRESET_ICONS[0].file);
  });
});

describe('normalizeReminderTemplate', () => {
  const fb = defaultReminderTemplates().wave;

  it('returns a copy of the fallback for null / non-object input', () => {
    expect(normalizeReminderTemplate(null, fb)).toEqual(fb);
    expect(normalizeReminderTemplate('x', fb)).toEqual(fb);
    expect(normalizeReminderTemplate(undefined, fb)).not.toBe(fb);
  });

  it('keeps a valid body / icon / priority and fills the rest', () => {
    const t = normalizeReminderTemplate({ body: 'Hi {server}', icon: 'urgent', priority: 4 }, fb);
    expect(t).toEqual({ body: 'Hi {server}', icon: 'urgent', priority: 4 });
  });

  it('rejects an unknown icon back to the fallback', () => {
    expect(normalizeReminderTemplate({ icon: 'rainbow' }, fb).icon).toBe(fb.icon);
  });

  it('clamps priority into [1,5] and rounds, falling back on garbage', () => {
    expect(normalizeReminderTemplate({ priority: 0 }, fb).priority).toBe(1);
    expect(normalizeReminderTemplate({ priority: 9 }, fb).priority).toBe(5);
    expect(normalizeReminderTemplate({ priority: 3.6 }, fb).priority).toBe(4);
    expect(normalizeReminderTemplate({ priority: 'loud' }, fb).priority).toBe(fb.priority);
  });

  it('accepts an explicit empty body (deliberately blank)', () => {
    expect(normalizeReminderTemplate({ body: '' }, fb).body).toBe('');
  });
});

describe('normalizeReminderTemplates', () => {
  it('fills every kind for null / non-object input', () => {
    expect(normalizeReminderTemplates(null)).toEqual(defaultReminderTemplates());
    expect(normalizeReminderTemplates(42)).toEqual(defaultReminderTemplates());
  });

  it('deep-normalises a partial map without touching the other kinds', () => {
    const t = normalizeReminderTemplates({ fleetSave: { priority: 2 } });
    expect(t.fleetSave.priority).toBe(2);
    expect(t.fleetSave.body).toBe(defaultReminderTemplates().fleetSave.body);
    expect(t.wave).toEqual(defaultReminderTemplates().wave);
  });
});

describe('renderTemplate', () => {
  it('substitutes known tokens', () => {
    expect(renderTemplate('Back ({returnTime}) #{index}/{total}', {
      returnTime: '14:32', index: 1, total: 4,
    })).toBe('Back (14:32) #1/4');
  });

  it('collapses missing / null / undefined tokens to empty (never leaks {token})', () => {
    expect(renderTemplate('a {coords} b', {})).toBe('a  b');
    expect(renderTemplate('a {coords} b', { coords: null })).toBe('a  b');
    expect(renderTemplate('{x}', { x: undefined })).toBe('');
  });

  it('coerces numbers and leaves non-token braces alone', () => {
    expect(renderTemplate('n={n}', { n: 0 })).toBe('n=0');
    expect(renderTemplate('plain text', {})).toBe('plain text');
  });
});

describe('templateTokens / unknownTokens', () => {
  it('lists referenced tokens deduped in first-seen order', () => {
    expect(templateTokens('{a} {b} {a} {c}')).toEqual(['a', 'b', 'c']);
    expect(templateTokens('no tokens')).toEqual([]);
  });

  it('flags tokens outside a kind catalogue', () => {
    // {coords} is valid for ad-hoc but NOT for waves.
    expect(unknownTokens('{returnTime} {coords}', 'wave')).toEqual(['coords']);
    expect(unknownTokens('{coords} {mission}', 'adhoc')).toEqual([]);
  });

  it('every default body references only catalogued tokens for its kind', () => {
    const d = defaultReminderTemplates();
    for (const kind of REMINDER_KINDS) {
      expect(unknownTokens(d[kind].body, kind)).toEqual([]);
    }
  });

  it('TEMPLATE_FIELDS covers the three kinds', () => {
    expect(Object.keys(TEMPLATE_FIELDS).sort()).toEqual([...REMINDER_KINDS].sort());
  });

  it('ad-hoc and fleet-save share the same per-fleet tokens (unified set)', () => {
    const tokensOf = (/** @type {'wave'|'adhoc'|'fleetSave'} */ kind) =>
      TEMPLATE_FIELDS[kind].map((f) => f.token);
    const shared = ['label', 'mission', 'coords', 'origin', 'originName', 'target', 'targetName', 'shipCount', 'arrivalTime'];
    for (const t of shared) {
      expect(tokensOf('adhoc')).toContain(t);
      expect(tokensOf('fleetSave')).toContain(t);
    }
    // The new per-fleet tokens are accepted (no "unknown wildcard") for both.
    const body = '{origin} {originName} {target} {targetName} {shipCount}';
    expect(unknownTokens(body, 'adhoc')).toEqual([]);
    expect(unknownTokens(body, 'fleetSave')).toEqual([]);
    // …but waves don't carry per-fleet data, so they stay flagged there.
    expect(unknownTokens('{origin}', 'wave')).toEqual(['origin']);
  });

  it('renders the new per-fleet tokens from a context', () => {
    const body = '{mission} from {originName} {origin} → {target} · {shipCount} ships, {arrivalTime}';
    const ctx = {
      mission: 'Expedition', originName: 'P1', origin: '[4:467:15]',
      target: '[4:467:16]', shipCount: '4,323', arrivalTime: '14:32',
    };
    expect(renderTemplate(body, ctx)).toBe('Expedition from P1 [4:467:15] → [4:467:16] · 4,323 ships, 14:32');
  });
});
