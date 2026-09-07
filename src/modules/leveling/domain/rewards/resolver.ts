import type { RoleRewardRule, Snowflake, StackingMode } from '../types.js';

/**
 * Role reward resolution (ADR-007, Accepted).
 *
 * Rewards are reconciled, not incrementally granted: we compute a DESIRED ROLE
 * SET as a pure function of level and configuration, diff it against what the
 * member actually holds, and apply the difference. Any reconciliation from any
 * trigger converges to the correct state, so a failed API call, a config change,
 * or an XP removal cannot leave a member permanently wrong.
 *
 * THE CARDINAL RULE: we only ever remove a role that appears in this guild's
 * reward rules. A member's staff role, colour role, or self-assigned role is
 * untouchable. Violating this is the most damaging bug this module could have,
 * so it is enforced here and asserted by a named test.
 */

export interface RewardDiff {
  readonly desired: readonly Snowflake[];
  readonly toAdd: readonly Snowflake[];
  readonly toRemove: readonly Snowflake[];
  readonly unchanged: readonly Snowflake[];
}

/** True when a rule's threshold has been met at `level`. */
function ruleThreshold(rule: RoleRewardRule): number {
  return rule.type === 'exact' ? rule.level : rule.startLevel;
}

/**
 * Has this rule been earned at `level`?
 *
 * For a RECURRING rule the answer is simply "have you reached the first
 * iteration": the rule names ONE role granted again at every Nth level, and a
 * member either holds that role or does not — there is no way to hold it twice.
 * The `everyN` step matters only to `attainedThreshold`, which decides where
 * the rule sits when stacking is `highest`.
 *
 * (This used to read `(level - startLevel) % everyN === 0 || level > startLevel`,
 * which computes exactly the same thing while implying the modulo does work.)
 */
function ruleQualifies(rule: RoleRewardRule, level: number): boolean {
  if (rule.type === 'exact') return level >= rule.level;
  if (rule.everyN <= 0) return false;
  return level >= rule.startLevel;
}

/**
 * The highest threshold actually attained by a rule at `level`.
 * For a recurring rule this is the most recent qualifying iteration.
 */
function attainedThreshold(rule: RoleRewardRule, level: number): number {
  if (rule.type === 'exact') return rule.level;
  const steps = Math.floor((level - rule.startLevel) / rule.everyN);
  return rule.startLevel + steps * rule.everyN;
}

/** Every role that this guild manages as a reward. Never remove anything else. */
export function managedRewardRoles(rules: readonly RoleRewardRule[]): Set<Snowflake> {
  return new Set(rules.map((r) => r.roleId));
}

/**
 * The set of reward roles a member at `level` should hold.
 *
 * stack   -> every rule whose threshold is met
 * highest -> only the rule(s) at the highest attained threshold
 */
export function desiredRewardRoles(
  level: number,
  rules: readonly RoleRewardRule[],
  mode: StackingMode,
): Set<Snowflake> {
  const qualifying = rules.filter((r) => ruleQualifies(r, level));
  if (qualifying.length === 0) return new Set();

  if (mode === 'stack') {
    return new Set(qualifying.map((r) => r.roleId));
  }

  // highest: find the top attained threshold, keep every rule sitting on it.
  const top = qualifying.reduce(
    (max, r) => Math.max(max, attainedThreshold(r, level)),
    Number.NEGATIVE_INFINITY,
  );
  return new Set(qualifying.filter((r) => attainedThreshold(r, level) === top).map((r) => r.roleId));
}

/**
 * Diff desired against actual. `toRemove` is intersected with the managed set,
 * so roles we do not own are never touched.
 */
export function computeRewardDiff(
  level: number,
  rules: readonly RoleRewardRule[],
  mode: StackingMode,
  actualRoleIds: readonly Snowflake[],
  options: { readonly removeOnLevelDown: boolean } = { removeOnLevelDown: true },
): RewardDiff {
  const desired = desiredRewardRoles(level, rules, mode);
  const actual = new Set(actualRoleIds);
  const managed = managedRewardRoles(rules);

  const toAdd = [...desired].filter((id) => !actual.has(id));
  const unchanged = [...desired].filter((id) => actual.has(id));

  const toRemove = options.removeOnLevelDown
    ? [...actual].filter((id) => managed.has(id) && !desired.has(id))
    : [];

  return {
    desired: [...desired],
    toAdd,
    toRemove,
    unchanged,
  };
}

/** Rewards a member has not yet reached, nearest first. Backs `/rank rewards`. */
export function upcomingRewards(
  level: number,
  rules: readonly RoleRewardRule[],
): { readonly level: number; readonly roleId: Snowflake }[] {
  return rules
    .filter((r) => !ruleQualifies(r, level))
    .map((r) => ({ level: ruleThreshold(r), roleId: r.roleId }))
    .sort((a, b) => a.level - b.level);
}
