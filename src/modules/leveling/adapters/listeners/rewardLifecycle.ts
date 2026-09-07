import { Events, type GuildMember, type Role } from 'discord.js';
import type { ListenerDefinition, ModuleContext } from '../../../../platform/plugin/types.js';
import type { AuditRepository, ConfigCache, RuleRepository } from '../../ports/config.js';
import type { MemberXpRepository } from '../../ports/memberXp.js';
import type { RewardReconciler } from '../effects/rewardReconciler.js';

/**
 * The two reward events that are not level-ups (spec `05` §2.4, roadmap M7).
 *
 * Reward roles are RECONCILED, never incrementally granted (ADR-007), which is
 * what makes both of these a few lines rather than a bespoke code path: each
 * one just triggers the same convergence from a different direction.
 */

export interface RewardLifecycleDeps {
  readonly reconciler: RewardReconciler;
  readonly configs: ConfigCache;
  readonly memberXp: MemberXpRepository;
  readonly rules: RuleRepository;
  readonly audit: AuditRepository;
}

/**
 * A member rejoining gets their roles back.
 *
 * Discord does not preserve roles across a leave, and their XP is still here
 * (removal is a soft delete), so without this a member who leaves and returns
 * silently loses every reward they earned — and, because reconciliation is
 * level-triggered, does not get them back until they level up AGAIN. For
 * someone at max level that is never.
 */
export function createMemberRejoinListener(deps: RewardLifecycleDeps): ListenerDefinition {
  return {
    event: Events.GuildMemberAdd,
    handle: async (ctx: ModuleContext, ...args: unknown[]) => {
      const member = args[0] as GuildMember;
      if (member.user.bot) return;

      const config = await deps.configs.get(member.guild.id);
      if (!config.enabled || config.rewards.length === 0) return;

      const row = await deps.memberXp.get(member.guild.id, member.id);
      if (!row || row.totalXp === 0) return;

      // They are back: undo the departure flag so they reappear on boards that
      // hide departed members.
      await deps.memberXp.markDeparted(member.guild.id, member.id, false);

      const result = await deps.reconciler.reconcile(
        member.guild.id,
        member.id,
        row.level,
        config,
      );

      if (result.added.length > 0) {
        ctx.log.info(
          { guildId: member.guild.id, userId: member.id, level: row.level, roles: result.added },
          'restored reward roles on rejoin',
        );
      }
    },
  };
}

/**
 * A reward role being deleted.
 *
 * Without this the rule survives, the engine keeps offering the role, and every
 * level-up produces a failed API call — discovered as noise in the logs rather
 * than as the configuration problem it is. The rule is KEPT and marked, because
 * an admin who deletes a role by accident and recreates it should not also have
 * lost their reward configuration.
 */
export function createRoleDeleteListener(deps: RewardLifecycleDeps): ListenerDefinition {
  return {
    event: Events.GuildRoleDelete,
    handle: async (ctx: ModuleContext, ...args: unknown[]) => {
      const role = args[0] as Role;

      const record = await deps.rules.markRewardBroken(role.guild.id, role.id, 'role_deleted');
      if (!record.firstSeen && !record.notify) return;

      deps.configs.invalidate(role.guild.id);
      ctx.log.warn(
        { guildId: role.guild.id, roleId: role.id, roleName: role.name },
        'a reward role was deleted — the reward rule is kept but will be skipped ' +
          'until the role is recreated or the rule removed (/level reward list)',
      );
    },
  };
}

/**
 * A member leaving.
 *
 * The default is to MARK them, never delete: XP survives a leave (ADR-014), so
 * a rejoin restores everything, and `hideDepartedMembers` decides whether the
 * boards show them meanwhile.
 *
 * `auto_reset_on_leave` is the opt-out, for servers that treat leaving as
 * starting over. It is off by default because the surprising behaviour is the
 * destructive one — someone who leaves by accident and comes straight back
 * expects their level to still be there — and it is AUDITED, because
 * "everything I earned is gone" is a support question that needs an answer.
 */
export function createMemberLeaveListener(deps: RewardLifecycleDeps): ListenerDefinition {
  return {
    event: Events.GuildMemberRemove,
    handle: async (ctx: ModuleContext, ...args: unknown[]) => {
      const member = args[0] as GuildMember;
      if (member.user?.bot) return;

      const config = await deps.configs.get(member.guild.id);

      if (!config.autoResetOnLeave) {
        await deps.memberXp.markDeparted(member.guild.id, member.id, true);
        return;
      }

      const result = await deps.memberXp.forget(member.guild.id, member.id);
      if (result.xpRows === 0 && result.statRows === 0) return;

      // The record of the deletion outlives the data, which is the point: the
      // audit entry holds the member's id and the total erased, and nothing
      // else — no name, no content.
      await deps.audit.record(member.guild.id, {
        actorId: null,
        action: 'xp.auto_reset_on_leave',
        targetUserId: member.id,
        before: { totalXp: result.totalXpErased },
        after: { deleted: true },
      });

      ctx.log.info(
        { guildId: member.guild.id, userId: member.id, totalXp: result.totalXpErased },
        'member left and auto_reset_on_leave erased their data',
      );
    },
  };
}
