import type { CurveConfig } from '../types.js';
import { BASE_FORMULAS } from './formulas.js';

/**
 * The level curve (ADR-003, Accepted).
 *
 * A precomputed cumulative table plus binary search, NOT a closed-form inverse.
 * Rationale: `curve_multiplier` is applied and rounded *per level*, so
 *   sum(round(f(i) * m)) !== round(sum(f(i)) * m)
 * and any algebraic inverse would silently disagree with the per-level widths
 * shown to users at exactly the level boundaries. Off-by-one at a boundary is
 * the worst kind of bug in a leveling system, so we make it structurally
 * impossible: the same table that produces the widths produces the lookup.
 *
 * Cost: ~8 KB per distinct (type, multiplier, bound). Built once, cached.
 */

/** Default ceiling when a guild sets no max level. Extends lazily beyond this. */
export const DEFAULT_LEVEL_BOUND = 1000;

/** Hard ceiling on lazy table growth, so a pathological config cannot OOM. */
export const ABSOLUTE_LEVEL_CEILING = 1_000_000;

/** Guard against a configuration whose thresholds overflow safe integers. */
export const MAX_SAFE_TOTAL_XP = Number.MAX_SAFE_INTEGER;

export class CurveConfigError extends Error {}

export interface RankProgress {
  readonly level: number;
  readonly totalXp: number;
  /** XP earned inside the current level. */
  readonly xpIntoLevel: number;
  /** Width of the current level — XP needed to reach the next one. */
  readonly xpForNextLevel: number;
  /** 0..1. Exactly 1 only when the member is capped at max level. */
  readonly progressRatio: number;
  readonly isMaxLevel: boolean;
}

export class LevelCurve {
  /** cumulative[i] = total XP required to REACH level i. cumulative[0] === 0. */
  private cumulative: number[];
  private bound: number;

  constructor(private readonly config: CurveConfig) {
    if (!Number.isFinite(config.multiplierBps) || config.multiplierBps <= 0) {
      throw new CurveConfigError('curve multiplierBps must be a positive number');
    }
    if (config.maxLevel !== null && config.maxLevel < 0) {
      throw new CurveConfigError('maxLevel must be >= 0 or null');
    }
    this.bound = config.maxLevel ?? DEFAULT_LEVEL_BOUND;
    this.cumulative = this.build(this.bound);
  }

  private build(upTo: number): number[] {
    const widthOf = BASE_FORMULAS[this.config.type];
    const table: number[] = new Array<number>(upTo + 1);
    table[0] = 0;
    let running = 0;
    for (let level = 0; level < upTo; level++) {
      running += this.widthAt(level, widthOf);
      if (running > MAX_SAFE_TOTAL_XP) {
        throw new CurveConfigError(
          `curve overflows safe integer range at level ${level + 1}; ` +
            `lower the multiplier or set a maxLevel`,
        );
      }
      table[level + 1] = running;
    }
    return table;
  }

  private widthAt(level: number, widthOf: (l: number) => number): number {
    // Multiplier applied and rounded PER LEVEL — see the class comment.
    return Math.max(1, Math.round((widthOf(level) * this.config.multiplierBps) / 10000));
  }

  /** Grow the table so that index `level` exists. Geometric, so it converges. */
  private ensureLevel(level: number): void {
    if (level < this.cumulative.length) return;
    if (this.config.maxLevel !== null) return;
    if (level > ABSOLUTE_LEVEL_CEILING) {
      throw new CurveConfigError(
        `level ${level} exceeds the absolute ceiling of ${ABSOLUTE_LEVEL_CEILING}`,
      );
    }
    let next = this.bound;
    while (next <= level) next = Math.max(next * 2, next + DEFAULT_LEVEL_BOUND);
    this.bound = Math.min(next, ABSOLUTE_LEVEL_CEILING);
    this.cumulative = this.build(this.bound);
  }

  /**
   * Grow the table until its top threshold exceeds `totalXp`, so that a binary
   * search over it cannot clamp to the table's end and under-report the level.
   * Growth is geometric: an uncapped guild with an enormous total still resolves
   * in a handful of rebuilds rather than one per thousand levels.
   */
  private ensureCovers(totalXp: number): void {
    if (this.config.maxLevel !== null) return;
    let last = this.cumulative[this.cumulative.length - 1] ?? 0;
    while (totalXp >= last && this.bound < ABSOLUTE_LEVEL_CEILING) {
      this.bound = Math.min(
        Math.max(this.bound * 2, this.bound + DEFAULT_LEVEL_BOUND),
        ABSOLUTE_LEVEL_CEILING,
      );
      this.cumulative = this.build(this.bound);
      last = this.cumulative[this.cumulative.length - 1] ?? 0;
    }
  }

  /** XP required to advance from `level` to `level + 1`. */
  xpForLevel(level: number): number {
    if (level < 0) throw new CurveConfigError('level must be >= 0');
    this.ensureLevel(level + 1);
    const here = this.cumulative[level];
    const next = this.cumulative[level + 1];
    if (here === undefined || next === undefined) {
      // Only reachable at a hard maxLevel bound; the width is still well-defined.
      return this.widthAt(level, BASE_FORMULAS[this.config.type]);
    }
    return next - here;
  }

  /** Cumulative XP required to reach `level` from zero. */
  totalXpToReach(level: number): number {
    if (level < 0) throw new CurveConfigError('level must be >= 0');
    this.ensureLevel(level);
    const value = this.cumulative[level];
    if (value !== undefined) return value;
    // Capped curve asked beyond its bound: extend just for this query.
    return this.build(level)[level] ?? 0;
  }

  /**
   * The level a member holds with `totalXp`. Binary search over the cumulative
   * table: the largest L such that totalXpToReach(L) <= totalXp.
   */
  levelFromTotalXp(totalXp: number): number {
    if (totalXp <= 0) return 0;
    this.ensureCovers(totalXp);

    let lo = 0;
    let hi = this.cumulative.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const threshold = this.cumulative[mid];
      if (threshold !== undefined && threshold <= totalXp) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }

    const cap = this.config.maxLevel;
    return cap === null ? lo : Math.min(lo, cap);
  }

  /** Full progress view for `/rank` and the level-up message. */
  progressFor(totalXp: number): RankProgress {
    const safeTotal = Math.max(0, Math.floor(totalXp));
    const level = this.levelFromTotalXp(safeTotal);
    const isMaxLevel = this.config.maxLevel !== null && level >= this.config.maxLevel;

    if (isMaxLevel) {
      return {
        level,
        totalXp: safeTotal,
        xpIntoLevel: safeTotal - this.totalXpToReach(level),
        xpForNextLevel: 0,
        progressRatio: 1,
        isMaxLevel: true,
      };
    }

    const floor = this.totalXpToReach(level);
    const width = this.xpForLevel(level);
    const into = safeTotal - floor;

    return {
      level,
      totalXp: safeTotal,
      xpIntoLevel: into,
      xpForNextLevel: width,
      progressRatio: width > 0 ? Math.min(1, into / width) : 0,
      isMaxLevel: false,
    };
  }

  /**
   * Total XP corresponding to a level plus optional within-level progress.
   * Backs `/xp set level` and Arcane's `/xp set xp` semantics.
   */
  totalXpForLevelAndProgress(level: number, xpIntoLevel = 0): number {
    if (xpIntoLevel < 0) throw new CurveConfigError('xpIntoLevel must be >= 0');
    const width = this.xpForLevel(level);
    if (xpIntoLevel >= width && width > 0) {
      throw new CurveConfigError(
        `xpIntoLevel ${xpIntoLevel} exceeds the width of level ${level} (${width}); use set level instead`,
      );
    }
    return this.totalXpToReach(level) + xpIntoLevel;
  }
}

/**
 * Cache curves by configuration identity. Building a 1000-entry table is cheap
 * but happens on every XP event otherwise.
 */
const cache = new Map<string, LevelCurve>();

function keyOf(config: CurveConfig): string {
  return `${config.type}:${config.multiplierBps}:${config.maxLevel ?? 'none'}:${config.hardCapXp}`;
}

export function getCurve(config: CurveConfig): LevelCurve {
  const key = keyOf(config);
  let curve = cache.get(key);
  if (!curve) {
    curve = new LevelCurve(config);
    cache.set(key, curve);
  }
  return curve;
}

/** Test helper — never call from production code. */
export function __clearCurveCache(): void {
  cache.clear();
}
