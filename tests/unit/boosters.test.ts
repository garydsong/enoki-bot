import { describe, expect, it } from 'vitest';
import {
  NEUTRAL_BPS,
  findApplicableBoosters,
  resolveMultiplier,
} from '../../src/modules/leveling/domain/boosters/resolver.js';
import type { LocationChain, XpRule } from '../../src/modules/leveling/domain/types.js';

const NOW = 1_800_000_000_000;
const MAX = 100000;

const input = (over: Partial<Parameters<typeof resolveMultiplier>[1]> = {}) => ({
  roleIds: [] as string[],
  userId: 'u1',
  source: 'message' as const,
  location: undefined as LocationChain | undefined,
  now: NOW,
  ...over,
});

const roleBoost = (id: string, bps: number): XpRule => ({
  kind: 'boost',
  targetType: 'role',
  targetId: id,
  bonusBps: bps,
});
const channelBoost = (id: string, bps: number): XpRule => ({
  kind: 'boost',
  targetType: 'channel',
  targetId: id,
  bonusBps: bps,
});
const guildBoost = (bps: number): XpRule => ({
  kind: 'boost',
  targetType: 'guild',
  targetId: null,
  bonusBps: bps,
});

const loc = (over: Partial<LocationChain> = {}): LocationChain => ({
  channelId: 'c1',
  parentChannelId: null,
  categoryId: null,
  isThread: false,
  isForumPost: false,
  isVoiceText: false,
  ...over,
});

/**
 * Arcane's own documented worked example: Vote 10% + Role 25% is 35% stacked and
 * 25% unstacked. That confirms boosts are additive bonuses over a 1.0 base, not
 * multiplied factors — this test pins that reading.
 */
describe("stacking matches Arcane's documented example", () => {
  const rules = [guildBoost(1000), roleBoost('booster', 2500)];
  const ctx = input({ roleIds: ['booster'] });

  it('stack: 10% + 25% = 35%', () => {
    const r = resolveMultiplier(rules, ctx, 'stack', MAX);
    expect(r.totalBonusBps).toBe(3500);
    expect(r.multiplierBps).toBe(13500);
  });

  it('highest: only 25% applies', () => {
    const r = resolveMultiplier(rules, ctx, 'highest', MAX);
    expect(r.totalBonusBps).toBe(2500);
    expect(r.multiplierBps).toBe(12500);
  });
});

describe('applicability', () => {
  it('a role boost applies only to holders', () => {
    expect(findApplicableBoosters([roleBoost('vip', 5000)], input({ roleIds: ['vip'] }))).toHaveLength(1);
    expect(findApplicableBoosters([roleBoost('vip', 5000)], input({ roleIds: ['other'] }))).toHaveLength(0);
  });

  it('a channel boost applies anywhere on the location chain', () => {
    const rules = [channelBoost('parent', 5000)];
    expect(
      findApplicableBoosters(
        rules,
        input({ location: loc({ channelId: 'thread', parentChannelId: 'parent' }) }),
      ),
    ).toHaveLength(1);
  });

  it('a guild boost always applies', () => {
    expect(findApplicableBoosters([guildBoost(1000)], input())).toHaveLength(1);
  });

  it('a user boost applies only to that member', () => {
    const rule: XpRule = { kind: 'boost', targetType: 'user', targetId: 'u1', bonusBps: 5000 };
    expect(findApplicableBoosters([rule], input({ userId: 'u1' }))).toHaveLength(1);
    expect(findApplicableBoosters([rule], input({ userId: 'u2' }))).toHaveLength(0);
  });

  it('a source-scoped boost applies only to that source', () => {
    const rule: XpRule = {
      kind: 'boost',
      targetType: 'guild',
      targetId: null,
      bonusBps: 5000,
      sourceScope: 'voice',
    };
    expect(findApplicableBoosters([rule], input({ source: 'voice' }))).toHaveLength(1);
    expect(findApplicableBoosters([rule], input({ source: 'message' }))).toHaveLength(0);
  });

  it('restriction rules are never treated as boosts', () => {
    const rules: XpRule[] = [
      { kind: 'restrict_deny', targetType: 'role', targetId: 'muted' },
      { kind: 'restrict_only', targetType: 'channel', targetId: 'c1' },
    ];
    expect(findApplicableBoosters(rules, input({ roleIds: ['muted'] }))).toHaveLength(0);
  });

  it('a zero-bonus rule is ignored', () => {
    expect(findApplicableBoosters([guildBoost(0)], input())).toHaveLength(0);
  });
});

describe('temporary boosters expire at read time', () => {
  const temp = (expiresAt: number | null): XpRule => ({
    kind: 'boost',
    targetType: 'guild',
    targetId: null,
    bonusBps: 1000,
    expiresAt,
  });

  it('applies while active', () => {
    expect(findApplicableBoosters([temp(NOW + 1000)], input())).toHaveLength(1);
  });

  it('does not apply once expired', () => {
    expect(findApplicableBoosters([temp(NOW - 1)], input())).toHaveLength(0);
  });

  it('a null expiry is permanent', () => {
    expect(findApplicableBoosters([temp(null)], input())).toHaveLength(1);
  });
});

describe('clamping', () => {
  it('a -100% nerf floors at zero, not negative', () => {
    const r = resolveMultiplier([guildBoost(-10000)], input(), 'stack', MAX);
    expect(r.multiplierBps).toBe(0);
  });

  it('nerfs below -100% still floor at zero', () => {
    const r = resolveMultiplier([guildBoost(-50000)], input(), 'stack', MAX);
    expect(r.multiplierBps).toBe(0);
    expect(r.clamped).toBe(true);
  });

  it('respects the guild multiplier ceiling', () => {
    const r = resolveMultiplier([guildBoost(999_999)], input(), 'stack', MAX);
    expect(r.multiplierBps).toBe(MAX);
    expect(r.clamped).toBe(true);
  });

  it('is not marked clamped when within bounds', () => {
    expect(resolveMultiplier([guildBoost(2500)], input(), 'stack', MAX).clamped).toBe(false);
  });
});

describe('no boosters', () => {
  it('yields a neutral 1.0x multiplier', () => {
    const r = resolveMultiplier([], input(), 'stack', MAX);
    expect(r.multiplierBps).toBe(NEUTRAL_BPS);
    expect(r.applicable).toEqual([]);
  });
});

describe('stacking a channel boost with its category boost', () => {
  it('both apply in stack mode — surprising, so /rank boosters shows the maths', () => {
    const rules: XpRule[] = [
      channelBoost('c1', 1000),
      { kind: 'boost', targetType: 'category', targetId: 'cat', bonusBps: 2000 },
    ];
    const r = resolveMultiplier(
      rules,
      input({ location: loc({ channelId: 'c1', categoryId: 'cat' }) }),
      'stack',
      MAX,
    );
    expect(r.totalBonusBps).toBe(3000);
  });
});
