// @vitest-environment happy-dom

// Tests for the in-game header-bar reader. `extractOwnProfile` is the meat
// (DOM scraping) and is covered against a realistic header; `installOwnProfile`
// is checked for the write-once-idempotent contract with `writeOwnProfile`
// mocked away.
//
// @ts-check

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/state/ownProfile.js', () => ({
  writeOwnProfile: vi.fn(() => Promise.resolve()),
}));

import {
  extractOwnProfile,
  installOwnProfile,
  _resetOwnProfileForTest,
} from '../../src/features/ownProfile.js';
import { writeOwnProfile } from '../../src/state/ownProfile.js';

// A realistic header bar (trimmed from the live s163-pl markup).
const HEADER = `
<div id="headerbarcomponent"><div id="bar">
  <div id="playerName">PL Kalyke
    <a href="/game/index.php?page=ingame&component=playerprofile&profileId=122360"></a>
    <span class="honorRank rank_starlord2 tooltipHTML"></span>
    <span class="textBeefy"><a href="#" class="textBeefy">Yoxid</a></span>
  </div>
  <div id="headerBarLinks">
    <span><a href="/game/index.php?page=highscore&site=3&category=1&searchRelId=122360">Statystyki</a>&nbsp;(250)</span>
  </div>
</div></div>`;

beforeEach(() => {
  _resetOwnProfileForTest();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('extractOwnProfile', () => {
  it('parses rank, rankClass, id and name from the header bar', () => {
    document.body.innerHTML = HEADER;
    expect(extractOwnProfile()).toEqual({
      id: 122360,
      name: 'Yoxid',
      rank: 250,
      rankClass: 'rank_starlord2',
    });
  });

  it('returns null when no recognisable header is present', () => {
    document.body.innerHTML = '<div>nothing here</div>';
    expect(extractOwnProfile()).toBeNull();
  });

  it('omits fields the header lacks (no honour rank, no name)', () => {
    document.body.innerHTML =
      '<div id="bar"><div id="headerBarLinks"><span>'
      + '<a href="?page=highscore&searchRelId=5">Stats</a>&nbsp;(42)</span></div></div>';
    expect(extractOwnProfile()).toEqual({ id: 5, rank: 42 });
  });
});

describe('installOwnProfile', () => {
  it('writes the parsed profile once, idempotently', () => {
    document.body.innerHTML = HEADER;
    installOwnProfile();
    installOwnProfile(); // second call is a no-op
    expect(writeOwnProfile).toHaveBeenCalledTimes(1);
    expect(writeOwnProfile).toHaveBeenCalledWith({
      id: 122360,
      name: 'Yoxid',
      rank: 250,
      rankClass: 'rank_starlord2',
    });
  });

  it('writes nothing when the header is absent', () => {
    document.body.innerHTML = '<div>no header</div>';
    installOwnProfile();
    expect(writeOwnProfile).not.toHaveBeenCalled();
  });
});
