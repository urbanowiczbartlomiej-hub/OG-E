// @vitest-environment happy-dom
//
// Unit tests for the universe id parser. The parser is pure (no
// `location`, no DOM, no globals), so happy-dom is not strictly needed
// — kept for consistency with the rest of the lib test suite which
// already runs under happy-dom.

import { describe, it, expect } from 'vitest';
import { parseUniverseId } from '../../src/lib/universeId.js';

describe('parseUniverseId', () => {
  it('parses the canonical universe form', () => {
    expect(parseUniverseId('s163-pl.ogame.gameforge.com')).toBe('s163-pl');
    expect(parseUniverseId('s1-en.ogame.gameforge.com')).toBe('s1-en');
    expect(parseUniverseId('s100-de.ogame.gameforge.com')).toBe('s100-de');
  });

  it('parses three- and four-letter locale codes', () => {
    // The regex allows 2..4 lowercase letters between `-` and `.`
    // so future Gameforge locales longer than two chars still parse.
    expect(parseUniverseId('s5-fra.ogame.gameforge.com')).toBe('s5-fra');
    expect(parseUniverseId('s5-test.ogame.gameforge.com')).toBe('s5-test');
  });

  it('returns full host on forum / lobby / landing subdomains', () => {
    // No `sNNN-XX.` prefix → fallback returns the full host so the
    // caller still gets a unique namespace string. Production never
    // reaches this branch (manifest filter blocks it) but the test
    // exercises the fallback explicitly.
    expect(parseUniverseId('forum.pl.ogame.gameforge.com'))
      .toBe('forum.pl.ogame.gameforge.com');
    expect(parseUniverseId('lobby.ogame.gameforge.com'))
      .toBe('lobby.ogame.gameforge.com');
    expect(parseUniverseId('ogame.gameforge.com'))
      .toBe('ogame.gameforge.com');
  });

  it('returns input unchanged for empty / non-host strings', () => {
    expect(parseUniverseId('')).toBe('');
    expect(parseUniverseId('not-a-host')).toBe('not-a-host');
  });

  it('requires the trailing dot — bare ids do not match', () => {
    // The pattern is anchored to a host (with the trailing `.`), so
    // a bare `s10` or `s10-pl` without the rest of the host falls
    // back. This is what makes the parser safe against accidental
    // matches inside paths or query strings.
    expect(parseUniverseId('s10')).toBe('s10');
    expect(parseUniverseId('s10-pl')).toBe('s10-pl');
  });

  it('is case-sensitive — uppercase input falls back', () => {
    // `location.host` is normalized to lowercase by the browser, so
    // mixed case is necessarily a non-browser caller. We fall back
    // rather than silently downcasing — the resulting namespace is
    // distinct from the lowercase one, which is the conservative
    // choice (no silent collisions).
    expect(parseUniverseId('S163-PL.ogame.gameforge.com'))
      .toBe('S163-PL.ogame.gameforge.com');
  });
});
