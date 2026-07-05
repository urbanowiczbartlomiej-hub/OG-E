// @ts-check
// Loot-rhythm analysis: per-body loot stats from the scan-history ring, and the
// hoard ("mother") planet detection a collector farmer's pattern exposes.

import { describe, it, expect } from 'vitest';
import { bodyLootStats, motherPlanetOf } from '../../src/domain/lootRhythm.js';

describe('bodyLootStats', () => {
  it('averages resTotal across history + latest, tracking peak and newest', () => {
    const stats = bodyLootStats(
      { resources: 200, timestamp: 3 },
      [{ resTotal: 100, ts: 1 }, { resTotal: 300, ts: 2 }],
    );
    expect(stats).not.toBeNull();
    expect(stats?.samples).toBe(3);
    expect(stats?.avg).toBe(200); // (100 + 300 + 200) / 3
    expect(stats?.max).toBe(300);
    expect(stats?.last).toBe(200); // newest by ts (3)
  });

  it('works from history alone when the latest carries no resources', () => {
    const stats = bodyLootStats({}, [{ resTotal: 500, ts: 1 }, { resTotal: 700, ts: 2 }]);
    expect(stats?.avg).toBe(600);
    expect(stats?.max).toBe(700);
    expect(stats?.last).toBe(700);
  });

  it('returns null when no observation carried a resource figure', () => {
    expect(bodyLootStats(undefined, [])).toBeNull();
    expect(bodyLootStats({}, [{ ts: 1 }])).toBeNull();
  });
});

describe('motherPlanetOf', () => {
  it('flags the body whose peak loot towers over the empire (≥5× median, ≥50M)', () => {
    // The pentagon pattern: 3 producing planets at ~3M, one hoard at 1.45B.
    const mother = motherPlanetOf({
      '4:486:6': { maxLoot: 3_000_000 },
      '4:487:8': { maxLoot: 3_000_000 },
      '4:488:15': { maxLoot: 3_000_000 },
      '4:486:9': { maxLoot: 1_450_000_000 },
    });
    expect(mother).toBe('4:486:9');
  });

  it('returns null when no body clearly stands out', () => {
    expect(motherPlanetOf({
      a: { maxLoot: 3_000_000 }, b: { maxLoot: 3_500_000 }, c: { maxLoot: 2_800_000 },
    })).toBeNull();
  });

  it('needs at least three bodies to compare against', () => {
    expect(motherPlanetOf({ a: { maxLoot: 1_000_000_000 }, b: { maxLoot: 1_000_000 } })).toBeNull();
  });

  it('ignores a relative spike that is still under the absolute 50M floor', () => {
    // 10× the median, but the peak (10M) is below the hoard floor.
    expect(motherPlanetOf({
      a: { maxLoot: 1_000_000 }, b: { maxLoot: 1_000_000 },
      c: { maxLoot: 1_000_000 }, d: { maxLoot: 10_000_000 },
    })).toBeNull();
  });
});
