import type { CurveType } from '../types.js';

/**
 * Arcane's three documented level formulas.
 *
 * ADR-002 (Accepted): these are read as the XP required to advance FROM `level`
 * TO `level + 1` — the *width* of a level — not as cumulative totals. Members
 * start at level 0, so level 1 costs 75 XP on the default linear curve.
 *
 * Documented by Arcane; the per-level-width reading is our inference and is
 * recorded as such in ADR-002.
 *   linear      (level * 100) + 75      [Arcane default]
 *   exponential 5 * level^2 + level*50 + 75
 *   flat        1000
 */
export type LevelWidthFn = (level: number) => number;

export const BASE_FORMULAS: Readonly<Record<CurveType, LevelWidthFn>> = {
  linear: (level) => level * 100 + 75,
  exponential: (level) => 5 * level * level + level * 50 + 75,
  flat: () => 1000,
};

/**
 * Closed-form cumulative totals at multiplier 1.0, used ONLY as a cross-check in
 * tests. Production code uses the precomputed table (ADR-003) because per-level
 * rounding under a multiplier breaks the algebraic identity:
 *   sum(round(f(i) * m)) !== round(sum(f(i)) * m)
 *
 * Verified by brute-force summation for N = 0..59.
 */
export const CLOSED_FORM_TOTALS: Readonly<Record<CurveType, (n: number) => number>> = {
  linear: (n) => 50 * n * n + 25 * n,
  exponential: (n) => (5 * (n - 1) * n * (2 * n - 1)) / 6 + 25 * (n - 1) * n + 75 * n,
  flat: (n) => 1000 * n,
};

/**
 * Exact inverse for the linear curve at multiplier 1.0. Test cross-check only.
 * N = floor((-25 + sqrt(625 + 200X)) / 100)
 */
export function closedFormLinearLevel(totalXp: number): number {
  return Math.floor((-25 + Math.sqrt(625 + 200 * totalXp)) / 100);
}
