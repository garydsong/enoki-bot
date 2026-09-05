import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type User,
} from 'discord.js';
import type { CommandDefinition } from '../../../../platform/plugin/types.js';
import type { Database } from '../../../../platform/db/pool.js';
import { getRankSnapshot } from '../../application/queries/leaderboard.js';
import { desiredRewardRoles, upcomingRewards } from '../../domain/rewards/resolver.js';
import type { GuildLevelingConfig } from '../../domain/types.js';
import type { ConfigCache } from '../../ports/config.js';
import type { RewardReconciler } from '../effects/rewardReconciler.js';
import { escapeMarkdown, formatNumber, ordinal, progressBar } from './format.js';

/**
 * `/rank` — the single most-used command in a leveling bot (US-05).
 *
 * Everything shown comes from `getRankSnapshot`, which the image card (M12)
 * will consume unchanged. This file only decides what an embed looks like.
 */

export interface RankCommandDeps {
  readonly db: Database;
  readonly configs: ConfigCache;
  readonly reconciler: RewardReconciler;
}

export function createRankCommand(deps: RankCommandDeps): CommandDefinition {
  return {
    name: 'rank',
    // Deferred: a database round-trip plus a member fetch can exceed Discord's
    // three seconds on a cold cache, and a timed-out interaction cannot be
    // recovered.
    defer: true,
    data: new SlashCommandBuilder()
      .setName('rank')
      .setDescription('Show your level and rank in this server')
      .addUserOption((option) =>
        option.setName('user').setDescription('Whose rank to show (defaults to you)'),
      )
      .addStringOption((option) =>
        option
          .setName('view')
          .setDescription('What to show')
          .addChoices(
            { name: 'Progress (default)', value: 'progress' },
            { name: 'Reward roles', value: 'rewards' },
          ),
      )
      .setDMPermission(false)
      .toJSON(),

    async execute(interaction: ChatInputCommandInteraction, ctx) {
      if (!interaction.inGuild() || !interaction.guildId) {
        await interaction.editReply('This command only works inside a server.');
        return;
      }

      const target: User = interaction.options.getUser('user') ?? interaction.user;
      const config = await deps.configs.get(interaction.guildId);

      if (!config.enabled) {
        await interaction.editReply(
          'Leveling is turned off in this server. An admin can enable it with `/level config set enabled on`.',
        );
        return;
      }

      if (target.bot) {
        await interaction.editReply('Bots do not earn XP.');
        return;
      }

      const snapshot = await getRankSnapshot(deps.db, interaction.guildId, target.id, config);

      if (!snapshot || snapshot.totalXp === 0) {
        await interaction.editReply(
          target.id === interaction.user.id
            ? 'You have not earned any XP yet. Send a message to get started.'
            : `${target.username} has not earned any XP yet.`,
        );
        return;
      }

      // Opportunistic reconciliation: a member whose reward role failed to
      // apply (bot was offline, hierarchy since fixed) gets it back simply by
      // looking at their own rank. Off by default because it costs an API call.
      if (config.reconcileOnRankCommand) {
        await deps.reconciler
          .reconcile(interaction.guildId, target.id, snapshot.level, config)
          .catch((err: unknown) => ctx.log.warn({ err }, 'opportunistic reconcile failed'));
      }

      const member = await interaction.guild?.members.fetch(target.id).catch(() => null);
      const displayName = member?.displayName ?? snapshot.displayName ?? target.username;

      if (interaction.options.getString('view') === 'rewards') {
        await interaction.editReply({
          embeds: [rewardsEmbed(displayName, target, snapshot.level, config)],
        });
        return;
      }

      const next = upcomingRewards(snapshot.level, config.rewards)[0];

      const embed = new EmbedBuilder()
        .setAuthor({
          name: escapeMarkdown(displayName),
          iconURL: target.displayAvatarURL({ size: 128 }),
        })
        .setThumbnail(target.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: 'Level', value: formatNumber(snapshot.level), inline: true },
          {
            name: 'Rank',
            value:
              snapshot.rank === null
                ? 'unranked'
                : `${ordinal(snapshot.rank)} of ${formatNumber(snapshot.rankTotal)}`,
            inline: true,
          },
          { name: 'Total XP', value: formatNumber(snapshot.totalXp), inline: true },
          {
            name: snapshot.isMaxLevel ? 'Progress' : `Progress to level ${snapshot.level + 1}`,
            value: snapshot.isMaxLevel
              ? `${progressBar(1)}\nMax level reached.`
              : `${progressBar(snapshot.progressRatio)}\n` +
                `${formatNumber(snapshot.xpIntoLevel)} / ${formatNumber(snapshot.xpForNextLevel)} XP ` +
                `(${formatNumber(snapshot.xpForNextLevel - snapshot.xpIntoLevel)} to go)`,
          },
        );

      if (member?.displayColor) embed.setColor(member.displayColor);
      if (next) {
        embed.setFooter({ text: `Next reward role at level ${next.level}` });
      }
      if (snapshot.isDeparted) {
        embed.setFooter({ text: 'This member has left the server.' });
      }

      await interaction.editReply({ embeds: [embed] });
    },
  };
}

/**
 * `/rank view:rewards` — what this member has earned and what is next.
 *
 * Computed from the SAME pure resolver the reconciler uses, so what a member is
 * told they should have and what the bot actually grants them cannot drift.
 * Deliberately shows the desired set rather than the roles they hold: if those
 * disagree, that is a reconciliation problem the member should be able to see.
 */
function rewardsEmbed(
  displayName: string,
  target: User,
  level: number,
  config: GuildLevelingConfig,
): EmbedBuilder {
  const earned = [...desiredRewardRoles(level, config.rewards, config.rewardStacking)];
  const upcoming = upcomingRewards(level, config.rewards).slice(0, 10);

  const embed = new EmbedBuilder()
    .setAuthor({
      name: escapeMarkdown(displayName),
      iconURL: target.displayAvatarURL({ size: 128 }),
    })
    .setTitle(`Reward roles at level ${formatNumber(level)}`);

  if (config.rewards.length === 0) {
    return embed.setDescription('This server has no reward roles configured.');
  }

  embed.addFields(
    {
      name: `Earned (${earned.length})`,
      value:
        earned.length === 0
          ? '*none yet*'
          : earned.map((id) => `<@&${id}>`).join('\n').slice(0, 1024),
    },
    {
      name: 'Next up',
      value:
        upcoming.length === 0
          ? '*every reward has been earned*'
          : upcoming
              .map((r) => `Level ${formatNumber(r.level)} → <@&${r.roleId}>`)
              .join('\n')
              .slice(0, 1024),
    },
  );

  if (config.rewardStacking === 'highest') {
    embed.setFooter({
      text: 'This server keeps only the highest earned reward role.',
    });
  }

  return embed;
}

/** Shared by `/rank` and `/leaderboard` when leveling is off. */
export async function replyDisabled(interaction: ChatInputCommandInteraction): Promise<void> {
  const content = 'Leveling is turned off in this server.';
  if (interaction.deferred) await interaction.editReply(content);
  else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}
