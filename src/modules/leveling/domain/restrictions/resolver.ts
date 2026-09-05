import type { LocationChain, Snowflake, XpRule } from '../types.js';

/**
 * Location eligibility (ADR-011, Accepted; spec `04` §3.2).
 *
 * Order is fixed and deliberate:
 *   1. context toggles (threads / forum posts / voice text)
 *   2. WHITELIST gate  — if any restrict_only channel/category rules exist,
 *                        some element of the chain must match one
 *   3. BLACKLIST gate  — any chain element matching restrict_deny denies
 *
 * Blacklist is evaluated last and therefore WINS over the whitelist. This is the
 * only self-consistent reading: "only these channels" is a scope statement,
 * "never this channel" is a prohibition, and a prohibition must be able to carve
 * an exception out of a scope. A channel listed in both denies.
 */

export type LocationVerdict =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: 'channel_denied' | 'channel_not_whitelisted' | 'context_disabled';
      readonly detail: string;
    };

export interface ContextToggles {
  readonly xpInThreads: boolean;
  readonly xpInForumPosts: boolean;
  readonly xpInVoiceText: boolean;
}

/** Chain elements, innermost first: thread -> parent channel -> category. */
export function locationChainIds(location: LocationChain): Snowflake[] {
  const ids: Snowflake[] = [location.channelId];
  if (location.parentChannelId) ids.push(location.parentChannelId);
  if (location.categoryId) ids.push(location.categoryId);
  return ids;
}

const isLocationRule = (rule: XpRule): boolean =>
  rule.targetType === 'channel' || rule.targetType === 'category';

export function resolveLocation(
  location: LocationChain | undefined,
  rules: readonly XpRule[],
  context: ContextToggles,
): LocationVerdict {
  // Voice ticks and other locationless events are not location-restricted.
  if (!location) return { allowed: true };

  // 1. Context toggles — cheapest and most specific.
  if (location.isForumPost && !context.xpInForumPosts) {
    return { allowed: false, reason: 'context_disabled', detail: 'XP in forum posts is disabled' };
  }
  if (location.isThread && !location.isForumPost && !context.xpInThreads) {
    return { allowed: false, reason: 'context_disabled', detail: 'XP in threads is disabled' };
  }
  if (location.isVoiceText && !context.xpInVoiceText) {
    return {
      allowed: false,
      reason: 'context_disabled',
      detail: 'XP in voice channel text is disabled',
    };
  }

  const chain = locationChainIds(location);
  const chainSet = new Set(chain);

  // 2. Whitelist gate.
  const whitelist = rules.filter((r) => r.kind === 'restrict_only' && isLocationRule(r));
  if (whitelist.length > 0) {
    const matched = whitelist.some((r) => r.targetId !== null && chainSet.has(r.targetId));
    if (!matched) {
      return {
        allowed: false,
        reason: 'channel_not_whitelisted',
        detail: 'an XP-only channel list is configured and this location is not on it',
      };
    }
  }

  // 3. Blacklist gate — wins over the whitelist.
  const denied = rules.find(
    (r) => r.kind === 'restrict_deny' && isLocationRule(r) && r.targetId !== null && chainSet.has(r.targetId),
  );
  if (denied) {
    return {
      allowed: false,
      reason: 'channel_denied',
      detail: `${denied.targetType} ${String(denied.targetId)} is a no-XP location`,
    };
  }

  return { allowed: true };
}

/**
 * Role denial. Holding ANY no-XP role denies, regardless of other roles held —
 * and this beats every booster, because it is evaluated in the eligibility phase
 * (gate 5) and boosters live in the amount phase (gate 12).
 */
export function findDeniedRole(
  roleIds: readonly Snowflake[],
  rules: readonly XpRule[],
): Snowflake | null {
  const held = new Set(roleIds);
  const rule = rules.find(
    (r) => r.kind === 'restrict_deny' && r.targetType === 'role' && r.targetId !== null && held.has(r.targetId),
  );
  return rule?.targetId ?? null;
}

/** True when the guild has a channel/category whitelist configured. */
export function hasLocationWhitelist(rules: readonly XpRule[]): boolean {
  return rules.some((r) => r.kind === 'restrict_only' && isLocationRule(r));
}

/**
 * Configuration contradictions worth warning an admin about at write time.
 * Spec AR-6: the config command should surface these, not the support channel.
 */
export function findRuleContradictions(rules: readonly XpRule[]): string[] {
  const warnings: string[] = [];

  for (const rule of rules) {
    if (rule.targetId === null) continue;

    if (rule.kind === 'restrict_deny') {
      const alsoWhitelisted = rules.some(
        (r) => r.kind === 'restrict_only' && r.targetType === rule.targetType && r.targetId === rule.targetId,
      );
      if (alsoWhitelisted) {
        warnings.push(
          `${rule.targetType} ${rule.targetId} is both an XP-only location and a no-XP location — the no-XP rule wins.`,
        );
      }

      const alsoBoosted = rules.some(
        (r) => r.kind === 'boost' && r.targetType === rule.targetType && r.targetId === rule.targetId,
      );
      if (alsoBoosted) {
        warnings.push(
          `${rule.targetType} ${rule.targetId} has an XP booster but also earns no XP — the booster can never apply.`,
        );
      }
    }
  }

  return [...new Set(warnings)];
}
