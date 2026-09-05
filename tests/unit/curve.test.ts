import { describe, expect, it, beforeEach } from 'vitest';
import {
  LevelCurve,
  CurveConfigError,
  getCurve,
  __clearCurveCache,
} from '../../src/modules/leveling/domain/curve/curve.js';
import {
  BASE_FORMULAS,
  CLOSED_FORM_TOTALS,
  closedFormLinearLevel,
} from '../../src/modules/leveling/domain/curve/formulas.js';
import type { CurveConfig, CurveType } from '../../src/modules/leveling/domain/types.js';

const cfg = (over: Partial<CurveConfig> = {}): CurveConfig => ({
  type: 'linear',
  multiplierBps: 10000,
  maxLevel: null,
  hardCapXp: false,
  ...over,
});

beforeEach(() => __clearCurveCache());

/**
 * GOLDEN FIXTURES — spec `04` §4.3.
 *
 * These numbers were verified by brute-force summation before any code existed.
 * They are a compatibility contract: changing the curve implementation in a way
 * that alters them re-levels every member of every server. If this test fails,
 * the change is wrong until proven otherwise.
 */
describe('curve: golden fixtures (spec 04 §4.3)', () => {
  const GOLDEN: Record<CurveType, Record<number, number>> = {
    linear: { 1: 75, 5: 1375, 10: 5250, 20: 20500, 50: 126250, 100: 502500 },
    exponential: { 1: 75, 5: 1025, 10: 4425, 20: 23350, 50: 267125, 100: 1896750 },
    flat: { 1: 1000, 5: 5000, 10: 10000, 20: 20000, 50: 50000, 100: 100000 },
  };

  for (const [type, totals] of Object.entries(GOLDEN) as [CurveType, Record<number, number>][]) {
    for (const [level, expected] of Object.entries(totals)) {
      it(`${type}: totalXpToReach(${level}) === ${expected}`, () => {
        expect(new LevelCurve(cfg({ type })).totalXpToReach(Number(level))).toBe(expected);
      });
    }
  }

  it('linear: next-level widths match the published formula', () => {
    const curve = new LevelCurve(cfg({ type: 'linear' }));
    expect(curve.xpForLevel(1)).toBe(175);
    expect(curve.xpForLevel(5)).toBe(575);
    expect(curve.xpForLevel(50)).toBe(5075);
    expect(curve.xpForLevel(100)).toBe(10075);
  });

  it('exponential: next-level widths match the published formula', () => {
    const curve = new LevelCurve(cfg({ type: 'exponential' }));
    expect(curve.xpForLevel(1)).toBe(130);
    expect(curve.xpForLevel(10)).toBe(1075);
    expect(curve.xpForLevel(50)).toBe(15075);
    expect(curve.xpForLevel(100)).toBe(55075);
  });
});

describe('curve: agreement with closed forms at multiplier 1.0', () => {
  for (const type of ['linear', 'exponential', 'flat'] as CurveType[]) {
    it(`${type}: table matches the closed form for N = 0..60`, () => {
      const curve = new LevelCurve(cfg({ type }));
      for (let n = 0; n <= 60; n++) {
        expect(curve.totalXpToReach(n)).toBe(CLOSED_FORM_TOTALS[type](n));
      }
    });

    it(`${type}: widths match the base formula for L = 0..60`, () => {
      const curve = new LevelCurve(cfg({ type }));
      for (let l = 0; l <= 60; l++) {
        expect(curve.xpForLevel(l)).toBe(BASE_FORMULAS[type](l));
      }
    });
  }

  it('linear: binary search agrees with the exact algebraic inverse', () => {
    const curve = new LevelCurve(cfg({ type: 'linear' }));
    for (let xp = 0; xp < 300_000; xp += 137) {
      expect(curve.levelFromTotalXp(xp)).toBe(closedFormLinearLevel(xp));
    }
  });
});

describe('curve: level boundaries', () => {
  it('everyone starts at level 0 with 0 XP', () => {
    const curve = new LevelCurve(cfg());
    expect(curve.levelFromTotalXp(0)).toBe(0);
    expect(curve.totalXpToReach(0)).toBe(0);
  });

  it('exactly on a threshold is the higher level, one below is the lower', () => {
    const curve = new LevelCurve(cfg());
    for (const level of [1, 2, 5, 17, 40]) {
      const threshold = curve.totalXpToReach(level);
      expect(curve.levelFromTotalXp(threshold)).toBe(level);
      expect(curve.levelFromTotalXp(threshold - 1)).toBe(level - 1);
    }
  });

  it('negative XP is treated as zero', () => {
    expect(new LevelCurve(cfg()).levelFromTotalXp(-500)).toBe(0);
  });
});

describe('curve: multiplier applies per level with rounding', () => {
  it('a 2x multiplier doubles each width', () => {
    const curve = new LevelCurve(cfg({ multiplierBps: 20000 }));
    expect(curve.xpForLevel(0)).toBe(150);
    expect(curve.xpForLevel(1)).toBe(350);
    expect(curve.totalXpToReach(1)).toBe(150);
  });

  it('a fractional multiplier rounds each level, not the total', () => {
    // level 0 width 75 * 1.5 = 112.5 -> 113 (half-up), not 112.
    const curve = new LevelCurve(cfg({ multiplierBps: 15000 }));
    expect(curve.xpForLevel(0)).toBe(113);
    expect(curve.totalXpToReach(1)).toBe(113);
  });

  it('per-level rounding can diverge from scaling the closed-form total', () => {
    // This divergence is precisely why ADR-003 uses a table, not an inverse.
    const curve = new LevelCurve(cfg({ multiplierBps: 15000 }));
    const tableTotal = curve.totalXpToReach(10);
    const naive = Math.round(CLOSED_FORM_TOTALS.linear(10) * 1.5);
    expect(tableTotal).not.toBe(naive);
  });

  it('a width never rounds below 1 XP', () => {
    const curve = new LevelCurve(cfg({ multiplierBps: 1 }));
    expect(curve.xpForLevel(0)).toBeGreaterThanOrEqual(1);
  });
});

describe('curve: max level', () => {
  it('caps the reported level but keeps accepting XP (decision C9)', () => {
    const curve = new LevelCurve(cfg({ maxLevel: 10 }));
    const far = curve.totalXpToReach(10) * 100;
    expect(curve.levelFromTotalXp(far)).toBe(10);
    const p = curve.progressFor(far);
    expect(p.isMaxLevel).toBe(true);
    expect(p.progressRatio).toBe(1);
    expect(p.xpForNextLevel).toBe(0);
    expect(p.totalXp).toBe(far);
  });
});

describe('curve: progressFor', () => {
  it('splits total XP into level, progress and remaining', () => {
    const curve = new LevelCurve(cfg());
    const total = curve.totalXpToReach(5) + 200;
    const p = curve.progressFor(total);
    expect(p.level).toBe(5);
    expect(p.xpIntoLevel).toBe(200);
    expect(p.xpForNextLevel).toBe(575);
    expect(p.progressRatio).toBeCloseTo(200 / 575, 10);
    expect(p.isMaxLevel).toBe(false);
  });

  it('a brand-new member reads as level 0 with zero progress', () => {
    const p = new LevelCurve(cfg()).progressFor(0);
    expect(p).toMatchObject({ level: 0, xpIntoLevel: 0, xpForNextLevel: 75, progressRatio: 0 });
  });
});

describe('curve: totalXpForLevelAndProgress (backs /xp set)', () => {
  it('round-trips a level and within-level progress', () => {
    const curve = new LevelCurve(cfg());
    const total = curve.totalXpForLevelAndProgress(7, 300);
    const p = curve.progressFor(total);
    expect(p.level).toBe(7);
    expect(p.xpIntoLevel).toBe(300);
  });

  it('refuses progress that exceeds the level width', () => {
    const curve = new LevelCurve(cfg());
    expect(() => curve.totalXpForLevelAndProgress(1, 99999)).toThrow(CurveConfigError);
  });

  it('refuses negative progress', () => {
    expect(() => new LevelCurve(cfg()).totalXpForLevelAndProgress(1, -1)).toThrow(CurveConfigError);
  });
});

describe('curve: configuration guards', () => {
  it('rejects a non-positive multiplier', () => {
    expect(() => new LevelCurve(cfg({ multiplierBps: 0 }))).toThrow(CurveConfigError);
  });

  it('rejects a negative max level', () => {
    expect(() => new LevelCurve(cfg({ maxLevel: -1 }))).toThrow(CurveConfigError);
  });

  it('rejects a negative level lookup', () => {
    expect(() => new LevelCurve(cfg()).xpForLevel(-1)).toThrow(CurveConfigError);
    expect(() => new LevelCurve(cfg()).totalXpToReach(-1)).toThrow(CurveConfigError);
  });

  it('refuses a configuration that would overflow safe integers', () => {
    // exponential totals ~1.67e9 at level 1000; a 1e7x multiplier pushes the
    // level-1000 threshold past Number.MAX_SAFE_INTEGER.
    expect(() => new LevelCurve(cfg({ type: 'exponential', multiplierBps: 1e11 }))).toThrow(
      CurveConfigError,
    );
  });
});

describe('curve: extends lazily past the default bound', () => {
  it('resolves a level beyond 1000 when uncapped', () => {
    const curve = new LevelCurve(cfg({ type: 'flat' }));
    // flat = 1000/level, so 1,500,000 XP is level 1500 — past the initial table.
    expect(curve.levelFromTotalXp(1_500_000)).toBe(1500);
  });
});

describe('curve: caching', () => {
  it('returns the same instance for an identical config', () => {
    expect(getCurve(cfg())).toBe(getCurve(cfg()));
  });

  it('returns a different instance when the config differs', () => {
    expect(getCurve(cfg())).not.toBe(getCurve(cfg({ multiplierBps: 20000 })));
  });
});
