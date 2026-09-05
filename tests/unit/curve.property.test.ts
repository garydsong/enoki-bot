import { describe, expect, it } from 'vitest';
import { LevelCurve } from '../../src/modules/leveling/domain/curve/curve.js';
import type { CurveConfig, CurveType } from '../../src/modules/leveling/domain/types.js';

/**
 * THE INVARIANT (spec `08` §4.3 rule 5).
 *
 *   totalXpToReach(level) <= X < totalXpToReach(level + 1)
 *
 * where level = levelFromTotalXp(X). This single property catches every
 * off-by-one the cumulative table or the binary search could contain, across
 * every curve and multiplier — including the fractional multipliers where
 * per-level rounding makes an algebraic inverse wrong.
 *
 * Deterministic pseudo-random inputs: a fixed seed, so a failure is reproducible
 * rather than a flake.
 */

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // xorshift32
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

const TYPES: CurveType[] = ['linear', 'exponential', 'flat'];
const MULTIPLIERS = [10000, 5000, 15000, 25000, 7777, 33333];

describe('curve: level/XP invariant holds for every curve and multiplier', () => {
  for (const type of TYPES) {
    for (const multiplierBps of MULTIPLIERS) {
      it(`${type} @ ${multiplierBps}bps`, () => {
        const config: CurveConfig = { type, multiplierBps, maxLevel: null, hardCapXp: false };
        const curve = new LevelCurve(config);
        const rand = makeRng(0xc0ffee + multiplierBps);

        for (let i = 0; i < 400; i++) {
          const xp = Math.floor(rand() * 2_000_000);
          const level = curve.levelFromTotalXp(xp);

          expect(curve.totalXpToReach(level)).toBeLessThanOrEqual(xp);
          expect(curve.totalXpToReach(level + 1)).toBeGreaterThan(xp);
        }
      });
    }
  }
});

describe('curve: monotonicity', () => {
  for (const type of TYPES) {
    it(`${type}: thresholds strictly increase and levels never decrease`, () => {
      const curve = new LevelCurve({
        type,
        multiplierBps: 10000,
        maxLevel: null,
        hardCapXp: false,
      });

      let previousThreshold = -1;
      for (let level = 0; level <= 200; level++) {
        const threshold = curve.totalXpToReach(level);
        expect(threshold).toBeGreaterThan(previousThreshold);
        previousThreshold = threshold;
      }

      let previousLevel = 0;
      for (let xp = 0; xp < 200_000; xp += 997) {
        const level = curve.levelFromTotalXp(xp);
        expect(level).toBeGreaterThanOrEqual(previousLevel);
        previousLevel = level;
      }
    });
  }
});

describe('curve: progress is always internally consistent', () => {
  it('xpIntoLevel + (remaining) always lands on the next threshold', () => {
    const curve = new LevelCurve({
      type: 'exponential',
      multiplierBps: 12345,
      maxLevel: null,
      hardCapXp: false,
    });
    const rand = makeRng(42);

    for (let i = 0; i < 500; i++) {
      const xp = Math.floor(rand() * 500_000);
      const p = curve.progressFor(xp);
      expect(p.xpIntoLevel).toBeGreaterThanOrEqual(0);
      expect(p.xpIntoLevel).toBeLessThan(p.xpForNextLevel);
      expect(p.progressRatio).toBeGreaterThanOrEqual(0);
      expect(p.progressRatio).toBeLessThan(1);
      expect(curve.totalXpToReach(p.level) + p.xpIntoLevel).toBe(xp);
    }
  });
});
