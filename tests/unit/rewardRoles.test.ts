import { describe, expect, it } from 'vitest';
import {
  createRewardReconciler,
  whyUngrantable,
} from '../../src/modules/leveling/adapters/effects/rewardReconciler.js';
import { DEFAULT_LEVELING_CONFIG } from '../../src/modules/leveling/domain/support/defaults.js';
import type { GuildLevelingConfig } from '../../src/modules/leveling/domain/types.js';
import type { RuleRepository } from '../../src/modules/leveling/ports/config.js';

/**
 * Checked BEFORE calling Discord, because Discord answers "Missing Permissions"
 * for a role above the bot AND for a genuinely missing permission, so the two
 * cannot be told apart afterwards — and the admin's fix is different for each.
 */

const GUILD = '111111111111111111';
/** The bot's own top role sits at position 10 throughout. */
const me = { roles: { highest: { position: 10 } } } as never;

describe('deciding whether a reward role can be granted', () => {
  it('accepts an ordinary role below the bot', () => {
    expect(whyUngrantable({ id: '222', managed: false, position: 5 }, me, GUILD)).toBeNull();
  });

  it('rejects @everyone, whose id is the guild id', () => {
    // The one that shipped broken: @everyone sits at position 0, so the
    // hierarchy check waves it straight through, and it is not "managed" — yet
    // Discord will never grant or remove it.
    expect(whyUngrantable({ id: GUILD, managed: false, position: 0 }, me, GUILD)).toBe(
      'unassignable',
    );
  });

  it('rejects a role above the bot', () => {
    expect(whyUngrantable({ id: '222', managed: false, position: 10 }, me, GUILD)).toBe(
      'hierarchy',
    );
    expect(whyUngrantable({ id: '222', managed: false, position: 99 }, me, GUILD)).toBe(
      'hierarchy',
    );
  });

  it('rejects an integration role — a bot role, Nitro Booster, a subscriber role', () => {
    expect(whyUngrantable({ id: '222', managed: true, position: 3 }, me, GUILD)).toBe('managed');
  });

  it('reports a deleted role as deleted rather than crashing', () => {
    expect(whyUngrantable(undefined, me, GUILD)).toBe('role_deleted');
  });

  it('checks @everyone before the hierarchy, so the reason is the useful one', () => {
    // Ordering matters: at position 0 the hierarchy check passes, so if
    // @everyone were checked second it would be reported as grantable.
    expect(whyUngrantable({ id: GUILD, managed: true, position: 0 }, me, GUILD)).toBe(
      'unassignable',
    );
  });
});

// ---------------------------------------------------------------------------

const REWARD = '555555555555555555';
const OLD_REWARD = '666666666666666666';

/**
 * A guild where the bot can manage roles, and one member who currently holds
 * `held`. Every role write is recorded rather than performed.
 */
function fakeWorld(held: string[]) {
  const roleWrites: { operation: 'add' | 'remove'; roleIds: string[] }[] = [];
  const brokenMarks: string[] = [];

  const member = {
    roles: {
      cache: new Map(held.map((id) => [id, { id }])),
      add: (roleIds: string[]) => {
        roleWrites.push({ operation: 'add', roleIds: [...roleIds] });
        return Promise.resolve(member);
      },
      remove: (roleIds: string[]) => {
        roleWrites.push({ operation: 'remove', roleIds: [...roleIds] });
        return Promise.resolve(member);
      },
    },
  };

  const guild = {
    id: GUILD,
    members: {
      me: { permissions: { has: () => true }, roles: { highest: { position: 10 } } },
      fetch: () => Promise.resolve(member),
    },
    roles: {
      cache: new Map([
        [REWARD, { id: REWARD, managed: false, position: 3 }],
        [OLD_REWARD, { id: OLD_REWARD, managed: false, position: 2 }],
      ]),
    },
  };

  const rules = {
    markRewardBroken: (_g: string, roleId: string) => {
      brokenMarks.push(roleId);
      return Promise.resolve({ notify: false, firstSeen: false });
    },
  } as unknown as RuleRepository;

  const reconciler = createRewardReconciler({
    client: { guilds: { cache: new Map([[GUILD, guild]]) } } as never,
    rules,
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as never,
  });

  return { reconciler, roleWrites, brokenMarks, guild };
}

const config = (over: Partial<GuildLevelingConfig> = {}): GuildLevelingConfig => ({
  ...DEFAULT_LEVELING_CONFIG,
  enabled: true,
  rewards: [
    { type: 'exact', level: 5, roleId: REWARD },
    { type: 'exact', level: 1, roleId: OLD_REWARD },
  ],
  rewardStacking: 'highest',
  ...over,
});

describe('reconciling, for real and as a preview', () => {
  it('adds what is missing and removes what is no longer earned', async () => {
    const { reconciler, roleWrites } = fakeWorld([OLD_REWARD]);

    const result = await reconciler.reconcile(GUILD, '1', 5, config());

    expect(result.added).toEqual([REWARD]);
    expect(result.removed).toEqual([OLD_REWARD]);
    expect(roleWrites).toEqual([
      { operation: 'add', roleIds: [REWARD] },
      { operation: 'remove', roleIds: [OLD_REWARD] },
    ]);
  });

  it('A DRY RUN REPORTS THE SAME DIFF AND WRITES NOTHING', async () => {
    // The backfill's entire safety story: what the preview shows is what the
    // real run will do, because it is the same code with the writes skipped.
    const real = fakeWorld([OLD_REWARD]);
    const preview = fakeWorld([OLD_REWARD]);

    const applied = await real.reconciler.reconcile(GUILD, '1', 5, config());
    const previewed = await preview.reconciler.reconcile(GUILD, '1', 5, config(), {
      dryRun: true,
    });

    expect(previewed.added).toEqual(applied.added);
    expect(previewed.removed).toEqual(applied.removed);
    expect(preview.roleWrites).toEqual([]);
  });

  it('a dry run does not record breakage either', async () => {
    // A preview that alters configuration is not a preview — and the same
    // breakage will be found by the real run anyway.
    const { reconciler, brokenMarks, roleWrites } = fakeWorld([]);

    const result = await reconciler.reconcile(
      GUILD,
      '1',
      5,
      // A rule naming a role that does not exist in the guild.
      config({ rewards: [{ type: 'exact', level: 1, roleId: '777777777777777777' }] }),
      { dryRun: true },
    );

    expect(result.broken).toEqual([{ roleId: '777777777777777777', reason: 'role_deleted' }]);
    expect(brokenMarks).toEqual([]);
    expect(roleWrites).toEqual([]);
  });

  it('does nothing at all when the member is already correct', async () => {
    const { reconciler, roleWrites } = fakeWorld([REWARD]);

    const result = await reconciler.reconcile(GUILD, '1', 5, config());

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(roleWrites).toEqual([]);
  });

  it('never removes a role it does not manage', async () => {
    // THE CARDINAL RULE (ADR-007). A member's staff role must survive a level
    // change, whatever else happens.
    const staff = '888888888888888888';
    const { reconciler, roleWrites } = fakeWorld([staff, OLD_REWARD]);

    await reconciler.reconcile(GUILD, '1', 5, config());

    for (const write of roleWrites) {
      expect(write.roleIds).not.toContain(staff);
    }
  });

  it('reports missing Manage Roles once, rather than failing per role', async () => {
    const { reconciler, guild, roleWrites } = fakeWorld([]);
    guild.members.me.permissions.has = () => false;

    const result = await reconciler.reconcile(GUILD, '1', 5, config());

    expect(result.skipped).toBe('no_permission');
    expect(roleWrites).toEqual([]);
  });
});
