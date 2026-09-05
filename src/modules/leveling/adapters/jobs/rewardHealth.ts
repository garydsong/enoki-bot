import { PermissionFlagsBits } from 'discord.js';
import type { JobDefinition, ModuleContext } from '../../../../platform/plugin/types.js';
import type { ConfigCache, RuleRepository } from '../../ports/config.js';
import { whyUngrantable } from '../effects/rewardReconciler.js';

/**
 * Hourly re-check of broken reward rules (roadmap M7).
 *
 * WHY THIS EXISTS AT ALL. A broken reward is excluded from the engine's view of
 * the configuration, which is what stops it generating a failed API call on
 * every level-up. But that exclusion is also a trap: the admin fixes the
 * problem — moves the bot's role up, recreates the deleted role — and nothing
 * ever re-examines it, so the reward stays dead until they notice and re-add it.
 *
 * Reconciliation cannot do this itself: it only ever sees the rules the engine
 * offers, and a broken one is by definition not among them. So the recovery
 * path has to live outside the hot path, and an hourly sweep over the handful of
 * guilds that actually have a breakage is the cheapest place for it.
 */
export function createRewardHealthJob(deps: {
  readonly rules: RuleRepository;
  readonly configs: ConfigCache;
}): JobDefinition {
  return {
    name: 'leveling:reward-health',
    intervalMs: 3_600_000,
    // Nothing is broken at boot that was not broken a moment before, and the
    // first tick would otherwise land in the middle of startup.
    skipInitialRun: true,

    async run(ctx: ModuleContext) {
      const guildIds = await deps.rules.guildsWithBrokenRewards();
      if (guildIds.length === 0) return;

      let healed = 0;

      for (const guildId of guildIds) {
        const guild = ctx.client.guilds.cache.get(guildId);
        // Not in this guild any more, or a Discord outage. Either way there is
        // nothing to check and nothing to conclude — leave the rule alone.
        if (!guild) continue;

        const me = guild.members.me;
        if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) continue;

        for (const reward of await deps.rules.listRewards(guildId)) {
          if (reward.brokenReason === null) continue;

          const problem = whyUngrantable(guild.roles.cache.get(reward.roleId), me, guild.id);
          if (problem !== null) continue;

          const cleared = await deps.rules.clearRewardBroken(guildId, reward.roleId);
          if (cleared > 0) {
            healed += cleared;
            deps.configs.invalidate(guildId);
            ctx.log.info(
              { guildId, roleId: reward.roleId, level: reward.level, was: reward.brokenReason },
              'a previously broken reward role works again and is active once more',
            );
          }
        }
      }

      if (healed > 0) ctx.log.info({ healed }, 'reward health check repaired rules');
    },
  };
}
