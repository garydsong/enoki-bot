import {
  DiscordAPIError,
  EmbedBuilder,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildTextBasedChannel,
} from 'discord.js';
import type { Logger } from '../../../../platform/logging/logger.js';
import { getCurve } from '../../domain/curve/curve.js';
import { neutraliseMassMentions, renderTemplate } from '../../domain/notifications/template.js';
import type { XpAwardedEvent } from '../../application/awardXp.js';

/**
 * The level-up announcement (spec `03` §3, US-14).
 *
 * A level-up message is the single most visible thing this bot does, and also
 * the easiest to turn into a nuisance. The rules encoded here:
 *
 * - **Announce the DESTINATION level, once.** A member who crosses three levels
 *   in one award gets one message saying they reached the third, not three
 *   messages. Crossing three levels still grants all three rewards — that is
 *   the reward reconciler's job, not this one's.
 *
 * - **Never fail loudly.** A missing Send Messages permission must not produce
 *   an error per message forever. It is logged once per channel and dropped.
 *
 * - **@everyone can never fire.** The client sets `allowedMentions` to users
 *   only, which Discord enforces; the string filter here is cosmetic on top of
 *   it, so a previewed template matches what is actually sent.
 */

export interface LevelUpNotifierDeps {
  readonly client: Client;
  readonly log: Logger;
  /** Only called when the template actually uses {user.rank}. */
  readonly rankOf: (guildId: string, userId: string) => Promise<number | null>;
}

export interface LevelUpNotifier {
  announce(event: XpAwardedEvent, earnedRoleIds: readonly string[]): Promise<void>;
}

export function createLevelUpNotifier(deps: LevelUpNotifierDeps): LevelUpNotifier {
  // Remembers channels we already know we cannot post in, so a misconfigured
  // server produces one warning rather than one per message forever.
  const muted = new Set<string>();

  return {
    async announce(event, earnedRoleIds) {
      const notifications = event.config.notifications;

      if (!event.leveledUp || event.silent) return;
      if (notifications.mode === 'disabled') return;
      if (notifications.onlyOnRewardLevels && earnedRoleIds.length === 0) return;

      const guild = deps.client.guilds.cache.get(event.guildId);
      if (!guild) return;

      const channel = resolveChannel(guild, event, notifications.mode, notifications.channelId);
      if (!channel) return;
      if (muted.has(channel.id)) return;

      if (!canSpeak(channel)) {
        muted.add(channel.id);
        deps.log.warn(
          { guildId: event.guildId, channelId: channel.id },
          'cannot post level-up messages here (missing View Channel or Send Messages) — ' +
            'suppressing further attempts for this channel until restart',
        );
        return;
      }

      const member = await guild.members.fetch(event.userId).catch(() => null);
      const progress = getCurve(event.config.curve).progressFor(event.totalXpAfter);

      // The rank query is the only database read on this path, so it is skipped
      // entirely unless the template asks for it.
      const needsRank = notifications.template.includes('{user.rank}');
      const rank = needsRank ? await deps.rankOf(event.guildId, event.userId) : null;

      const roleNames = earnedRoleIds.map(
        (id) => guild.roles.cache.get(id)?.name ?? 'a new role',
      );

      const rendered = neutraliseMassMentions(
        renderTemplate(notifications.template, {
          userMention: `<@${event.userId}>`,
          userName: member?.displayName ?? member?.user.username ?? 'Someone',
          userId: event.userId,
          level: event.levelAfter,
          xpIntoLevel: progress.xpIntoLevel,
          xpForNextLevel: progress.xpForNextLevel,
          totalXp: event.totalXpAfter,
          rank,
          serverName: guild.name,
          earnedRoles: roleNames,
        }),
      );

      try {
        const sent = await channel.send(
          notifications.useEmbed
            ? { embeds: [buildEmbed(rendered, notifications.embedColor)] }
            : { content: rendered },
        );

        if (notifications.deleteAfterSeconds !== null) {
          const timer = setTimeout(() => {
            void sent.delete().catch(() => {
              /* already gone, or we lost the permission; nothing to do */
            });
          }, notifications.deleteAfterSeconds * 1000);
          // Never hold the process open for a pending cosmetic deletion.
          timer.unref?.();
        }
      } catch (error) {
        if (error instanceof DiscordAPIError && (error.code === 50013 || error.code === 50001)) {
          muted.add(channel.id);
          deps.log.warn(
            { guildId: event.guildId, channelId: channel.id, code: error.code },
            'level-up message refused by Discord — suppressing this channel',
          );
          return;
        }
        deps.log.error(
          { err: error, guildId: event.guildId, userId: event.userId },
          'failed to send level-up message',
        );
      }
    },
  };
}

function buildEmbed(description: string, color: number | null): EmbedBuilder {
  const embed = new EmbedBuilder().setDescription(description);
  if (color !== null) embed.setColor(color);
  return embed;
}

function resolveChannel(
  guild: Guild,
  event: XpAwardedEvent,
  mode: 'source_channel' | 'fixed_channel',
  fixedChannelId: string | null,
): GuildTextBasedChannel | null {
  const id = mode === 'fixed_channel' ? fixedChannelId : (event.channelId ?? null);
  if (!id) return null;

  // isTextBased() already excludes categories and forum roots — a forum's
  // POSTS are threads, and those are text-based, which is the behaviour we want.
  const channel = guild.channels.cache.get(id);
  if (!channel?.isTextBased()) return null;
  return channel;
}

function canSpeak(channel: GuildTextBasedChannel): boolean {
  const me = channel.guild.members.me;
  if (!me) return false;

  const permissions = channel.permissionsFor(me);
  if (!permissions) return false;

  // A thread needs SendMessagesInThreads; its parent's SendMessages is not it.
  const sendBit = channel.isThread()
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages;

  return permissions.has(PermissionFlagsBits.ViewChannel) && permissions.has(sendBit);
}
