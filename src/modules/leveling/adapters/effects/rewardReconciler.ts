import { DiscordAPIError, PermissionFlagsBits, type Client, type GuildMember } from 'discord.js';
import type { Logger } from '../../../../platform/logging/logger.js';
import { computeRewardDiff, managedRewardRoles } from '../../domain/rewards/resolver.js';
import type { Snowflake } from '../../domain/types.js';
import type { RuleRepository } from '../../ports/config.js';
import type {
  BrokenReason,
  ReconcileResult,
  RewardReconciler,
} from '../../ports/rewards.js';

/**
 * Reward role reconciliation — the Discord half of ADR-007.
 *
 * The domain computed a desired set; this applies it. Three properties matter
 * more than anything else here:
 *
 * 1. **We never remove a role we do not manage.** The diff already guarantees
 *    it, and the assertion is repeated at the boundary because the cost of
 *    being wrong is stripping someone's staff role.
 *
 * 2. **A role we cannot grant is reported, not retried forever.** Discord
 *    refuses a role above the bot in the hierarchy, a managed (integration)
 *    role, and a deleted one. Each is a CONFIGURATION problem the admin must
 *    fix, so the rule is marked broken and excluded from future evaluation
 *    rather than generating an error on every message.
 *
 * 3. **Failure never touches the XP.** This runs after commit as an isolated
 *    effect; a member who levelled up keeps their level even if the role fails.
 */

export type {
  BrokenReason,
  ReconcileOptions,
  ReconcileResult,
  RewardReconciler,
} from '../../ports/rewards.js';

export interface RewardReconcilerDeps {
  readonly client: Client;
  readonly rules: RuleRepository;
  readonly log: Logger;
}

const EMPTY: ReconcileResult = { added: [], removed: [], broken: [] };

export function createRewardReconciler(deps: RewardReconcilerDeps): RewardReconciler {
  return {
    async reconcile(guildId, userId, level, config, options) {
      const dryRun = options?.dryRun ?? false;
      if (config.rewards.length === 0) return { ...EMPTY, skipped: 'no_rules' };

      const guild = deps.client.guilds.cache.get(guildId);
      if (!guild) return EMPTY;

      const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
      if (!me) return EMPTY;

      // Checked ONCE up front rather than discovered per role: without Manage
      // Roles every single call fails, and a log line per member is noise.
      if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
        deps.log.warn(
          { guildId },
          'reward roles are configured but the bot lacks Manage Roles — skipping reconciliation',
        );
        return { ...EMPTY, skipped: 'no_permission' };
      }

      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) return EMPTY; // left the server between the award and here

      const diff = computeRewardDiff(level, config.rewards, config.rewardStacking, [
        ...member.roles.cache.keys(),
      ], { removeOnLevelDown: config.removeOnLevelDown });

      // Belt-and-braces: the diff already intersects with the managed set, and
      // this asserts it at the boundary where the damage would be done.
      const managed = managedRewardRoles(config.rewards);
      const toRemove = diff.toRemove.filter((id) => managed.has(id));

      const broken: { roleId: Snowflake; reason: BrokenReason }[] = [];
      const grantable: Snowflake[] = [];

      for (const roleId of diff.toAdd) {
        const problem = whyUngrantable(guild.roles.cache.get(roleId), me, guild.id);
        if (problem) broken.push({ roleId, reason: problem });
        else grantable.push(roleId);
      }

      const added: Snowflake[] = [];
      const removed: Snowflake[] = [];

      if (dryRun) {
        // Report what WOULD change and stop. No role writes, and no breakage
        // recorded either: a preview that alters configuration is not a
        // preview, and the same breakage will be found by the real run.
        return { added: grantable, removed: toRemove, broken };
      }

      if (grantable.length > 0) {
        const ok = await apply(member, 'add', grantable, deps.log, broken);
        if (ok) added.push(...grantable);
      }
      if (toRemove.length > 0) {
        const ok = await apply(member, 'remove', toRemove, deps.log, broken);
        if (ok) removed.push(...toRemove);
      }

      // Persist the breakage so the engine stops offering these roles and
      // `/level reward list` can show the admin exactly what to fix.
      //
      // The WARNING is throttled to once a day per role, because a broken
      // reward is rediscovered on every level-up in the guild — unthrottled,
      // the alerting is worse than the fault it reports.
      for (const entry of broken) {
        try {
          const record = await deps.rules.markRewardBroken(guildId, entry.roleId, entry.reason);
          if (record.notify) {
            deps.log.warn(
              { guildId, roleId: entry.roleId, reason: entry.reason },
              'a reward role cannot be granted; the rule is kept but skipped until fixed',
            );
          }
        } catch (err: unknown) {
          deps.log.error({ err, guildId, roleId: entry.roleId }, 'failed to mark reward broken');
        }
      }

      if (added.length > 0 || removed.length > 0) {
        deps.log.info({ guildId, userId, level, added, removed }, 'reward roles reconciled');
      }

      return { added, removed, broken };
    },
  };
}

/**
 * Why Discord would refuse this role, checked BEFORE calling the API.
 *
 * Discord returns a bare "Missing Permissions" for both the hierarchy case and
 * the genuinely-missing-permission case, so distinguishing them afterwards is
 * impossible. Checking first is what lets the admin be told which of the two
 * they actually have.
 */
export function whyUngrantable(
  role: { id: string; managed: boolean; position: number } | undefined,
  me: GuildMember,
  guildId: string,
): BrokenReason | null {
  if (!role) return 'role_deleted';

  // @everyone. Its id IS the guild id, and every member already has it —
  // Discord rejects any attempt to add or remove it. It also sits at position
  // 0, so the hierarchy check below would wave it straight through.
  if (role.id === guildId) return 'unassignable';

  // A managed role belongs to an integration (a bot's own role, a Twitch
  // subscriber role, Nitro Booster). Discord refuses to assign these to anyone.
  if (role.managed) return 'managed';
  if (role.position >= me.roles.highest.position) return 'hierarchy';
  return null;
}

async function apply(
  member: GuildMember,
  operation: 'add' | 'remove',
  roleIds: readonly Snowflake[],
  log: Logger,
  broken: { roleId: Snowflake; reason: BrokenReason }[],
): Promise<boolean> {
  try {
    // One call for the whole set: discord.js sends a single PATCH, so a member
    // crossing five reward levels at once costs one request, not five.
    if (operation === 'add') await member.roles.add([...roleIds], 'level reward');
    else await member.roles.remove([...roleIds], 'level reward no longer earned');
    return true;
  } catch (error) {
    if (error instanceof DiscordAPIError) {
      if (error.code === 10011) {
        for (const roleId of roleIds) broken.push({ roleId, reason: 'role_deleted' });
        return false;
      }
      if (error.code === 50013) {
        for (const roleId of roleIds) broken.push({ roleId, reason: 'missing_permission' });
        return false;
      }
    }
    log.error({ err: error, operation, roleIds }, 'reward role update failed');
    return false;
  }
}
