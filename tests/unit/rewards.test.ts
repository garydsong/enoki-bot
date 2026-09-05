import { describe, expect, it } from 'vitest';
import {
  computeRewardDiff,
  desiredRewardRoles,
  managedRewardRoles,
  upcomingRewards,
} from '../../src/modules/leveling/domain/rewards/resolver.js';
import type { RoleRewardRule } from '../../src/modules/leveling/domain/types.js';

const exact = (level: number, roleId: string): RoleRewardRule => ({ type: 'exact', level, roleId });
const recurring = (everyN: number, startLevel: number, roleId: string): RoleRewardRule => ({
  type: 'recurring',
  everyN,
  startLevel,
  roleId,
});

const RULES = [exact(5, 'bronze'), exact(10, 'silver'), exact(20, 'gold')];

describe('desired role set — stack mode', () => {
  it('grants every reward whose threshold is met', () => {
    expect([...desiredRewardRoles(10, RULES, 'stack')].sort()).toEqual(['bronze', 'silver']);
  });

  it('grants nothing below the first threshold', () => {
    expect(desiredRewardRoles(4, RULES, 'stack').size).toBe(0);
  });

  it('grants everything at the top', () => {
    expect(desiredRewardRoles(50, RULES, 'stack').size).toBe(3);
  });

  it('grants exactly at the threshold, not one below', () => {
    expect(desiredRewardRoles(5, RULES, 'stack').has('bronze')).toBe(true);
    expect(desiredRewardRoles(4, RULES, 'stack').has('bronze')).toBe(false);
  });
});

describe('desired role set — highest mode', () => {
  it('keeps only the highest attained reward', () => {
    expect([...desiredRewardRoles(10, RULES, 'highest')]).toEqual(['silver']);
    expect([...desiredRewardRoles(25, RULES, 'highest')]).toEqual(['gold']);
  });

  it('keeps every role sharing the top threshold', () => {
    const rules = [exact(5, 'a'), exact(10, 'b'), exact(10, 'c')];
    expect([...desiredRewardRoles(12, rules, 'highest')].sort()).toEqual(['b', 'c']);
  });
});

describe('recurring rewards', () => {
  const rules = [recurring(5, 5, 'milestone')];

  it('qualifies from the start level onward', () => {
    expect(desiredRewardRoles(4, rules, 'stack').size).toBe(0);
    expect(desiredRewardRoles(5, rules, 'stack').has('milestone')).toBe(true);
    expect(desiredRewardRoles(7, rules, 'stack').has('milestone')).toBe(true);
    expect(desiredRewardRoles(100, rules, 'stack').has('milestone')).toBe(true);
  });

  it('reports the most recent iteration as its attained threshold', () => {
    const mixed = [exact(12, 'exact12'), recurring(5, 5, 'milestone')];
    // at level 17 the recurring rule has attained 15, which beats the exact 12
    expect([...desiredRewardRoles(17, mixed, 'highest')]).toEqual(['milestone']);
  });

  it('ignores a rule with a non-positive interval', () => {
    expect(desiredRewardRoles(50, [recurring(0, 5, 'broken')], 'stack').size).toBe(0);
  });
});

/**
 * THE CARDINAL RULE (ADR-007). Removing a role we do not manage would be the
 * most damaging bug in this module — a member's staff or colour role vanishing
 * because they lost a level. This is asserted, not assumed.
 */
describe('the diff never touches unmanaged roles', () => {
  it('leaves staff, colour and self-assigned roles alone', () => {
    const diff = computeRewardDiff(3, RULES, 'stack', ['staff', 'colour-blue', 'bronze']);
    expect(diff.toRemove).toEqual(['bronze']);
    expect(diff.toRemove).not.toContain('staff');
    expect(diff.toRemove).not.toContain('colour-blue');
  });

  it('removes nothing at all when no rewards are configured', () => {
    const diff = computeRewardDiff(50, [], 'stack', ['staff', 'anything', 'everything']);
    expect(diff.toRemove).toEqual([]);
    expect(diff.toAdd).toEqual([]);
  });

  it('managedRewardRoles is exactly the configured role set', () => {
    expect([...managedRewardRoles(RULES)].sort()).toEqual(['bronze', 'gold', 'silver']);
  });
});

describe('diff mechanics', () => {
  it('adds what is missing and leaves what is already held', () => {
    const diff = computeRewardDiff(10, RULES, 'stack', ['bronze']);
    expect(diff.toAdd).toEqual(['silver']);
    expect(diff.unchanged).toEqual(['bronze']);
    expect(diff.toRemove).toEqual([]);
  });

  it('is a no-op when the member is already correct', () => {
    const diff = computeRewardDiff(10, RULES, 'stack', ['bronze', 'silver']);
    expect(diff.toAdd).toEqual([]);
    expect(diff.toRemove).toEqual([]);
  });

  it('is idempotent — re-running on the result changes nothing', () => {
    const first = computeRewardDiff(20, RULES, 'stack', []);
    const second = computeRewardDiff(20, RULES, 'stack', first.desired);
    expect(second.toAdd).toEqual([]);
    expect(second.toRemove).toEqual([]);
  });

  it('highest mode removes the lower tier in the same operation', () => {
    const diff = computeRewardDiff(20, RULES, 'highest', ['bronze', 'silver']);
    expect(diff.toAdd).toEqual(['gold']);
    expect([...diff.toRemove].sort()).toEqual(['bronze', 'silver']);
  });
});

describe('level-down behaviour (decision C2)', () => {
  it('removes rewards below the new level when removeOnLevelDown is on', () => {
    const diff = computeRewardDiff(3, RULES, 'stack', ['bronze', 'silver'], {
      removeOnLevelDown: true,
    });
    expect([...diff.toRemove].sort()).toEqual(['bronze', 'silver']);
  });

  it('keeps them when the guild has chosen "once earned, always yours"', () => {
    const diff = computeRewardDiff(3, RULES, 'stack', ['bronze', 'silver'], {
      removeOnLevelDown: false,
    });
    expect(diff.toRemove).toEqual([]);
  });
});

describe('upcoming rewards (backs /rank rewards)', () => {
  it('lists unreached rewards nearest first', () => {
    expect(upcomingRewards(6, RULES)).toEqual([
      { level: 10, roleId: 'silver' },
      { level: 20, roleId: 'gold' },
    ]);
  });

  it('is empty once everything is earned', () => {
    expect(upcomingRewards(99, RULES)).toEqual([]);
  });
});
