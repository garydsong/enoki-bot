import type { LocationChain, PassiveXpSource, Snowflake, StackingMode, XpRule } from '../types.js';
import { locationChainIds } from '../restrictions/resolver.js';

/**
 * Booster resolution (spec `04` §3.3).
 *
 * Boosts are ADDITIVE BONUS PERCENTAGES over a 1.0 base, in basis points.
 * This matches Arcane's own documented worked example: a 10% vote boost plus a
 * 25% role boost yields 35% when stacking is on, and 25% when it is off. They
 * are not multiplied factors.
 *
 * This entire module runs in the AMOUNT phase. It can never resurrect an
 * eligibility denial — see ADR-011.
 */

export const NEUTRAL_BPS = 10000;

export interface BoosterInput {
  readonly roleIds: readonly Snowflake[];
  readonly userId: Snowflake;
  readonly source: PassiveXpSource;
  readonly location?: LocationChain | undefined;
  readonly now: number;
}

export interface ApplicableBooster {
  readonly targetType: XpRule['targetType'];
  readonly targetId: string | null;
  readonly bonusBps: number;
}

export interface BoosterResult {
  readonly multiplierBps: number;
  readonly totalBonusBps: number;
  readonly applicable: readonly ApplicableBooster[];
  readonly clamped: boolean;
}

function isActive(rule: XpRule, now: number): boolean {
  return rule.expiresAt == null || rule.expiresAt > now;
}

function appliesToSource(rule: XpRule, source: PassiveXpSource): boolean {
  return rule.sourceScope == null || rule.sourceScope === source;
}

/** Every boost rule that applies to this member, in this place, for this source. */
export function findApplicableBoosters(
  rules: readonly XpRule[],
  input: BoosterInput,
): ApplicableBooster[] {
  const heldRoles = new Set(input.roleIds);
  const chain = new Set(input.location ? locationChainIds(input.location) : []);

  const applicable: ApplicableBooster[] = [];

  for (const rule of rules) {
    if (rule.kind !== 'boost') continue;
    if (rule.bonusBps === undefined || rule.bonusBps === 0) continue;
    if (!isActive(rule, input.now)) continue;
    if (!appliesToSource(rule, input.source)) continue;

    let matches = false;
    switch (rule.targetType) {
      case 'guild':
        matches = true;
        break;
      case 'role':
        matches = rule.targetId !== null && heldRoles.has(rule.targetId);
        break;
      case 'channel':
      case 'category':
        matches = rule.targetId !== null && chain.has(rule.targetId);
        break;
      case 'user':
        matches = rule.targetId === input.userId;
        break;
      case 'source':
        matches = rule.targetId === input.source;
        break;
    }

    if (matches) {
      applicable.push({
        targetType: rule.targetType,
        targetId: rule.targetId,
        bonusBps: rule.bonusBps,
      });
    }
  }

  return applicable;
}

/**
 * Combine applicable boosts into a final multiplier.
 *
 * stack   -> bonuses are summed  (10% + 25% = 35%)
 * highest -> only the largest applies (10% + 25% = 25%)
 */
export function resolveMultiplier(
  rules: readonly XpRule[],
  input: BoosterInput,
  mode: StackingMode,
  maxMultiplierBps: number,
): BoosterResult {
  const applicable = findApplicableBoosters(rules, input);

  let totalBonusBps = 0;
  if (applicable.length > 0) {
    totalBonusBps =
      mode === 'stack'
        ? applicable.reduce((sum, b) => sum + b.bonusBps, 0)
        : applicable.reduce(
            (max, b) => (max === null || b.bonusBps > max ? b.bonusBps : max),
            null as number | null,
          ) ?? 0;
  }

  const raw = NEUTRAL_BPS + totalBonusBps;
  // Floor at 0 (a -100% nerf means no XP); ceiling is the guild's safety valve.
  const multiplierBps = Math.min(Math.max(raw, 0), maxMultiplierBps);

  return {
    multiplierBps,
    totalBonusBps,
    applicable,
    clamped: multiplierBps !== raw,
  };
}
