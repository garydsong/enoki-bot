import { ChannelType, Events, type VoiceBasedChannel, type VoiceState } from 'discord.js';
import type {
  JobDefinition,
  ListenerDefinition,
  ModuleContext,
} from '../../../../platform/plugin/types.js';
import type {
  VoiceChannelSnapshot,
  VoiceService,
} from '../../application/voiceService.js';
import type { VoiceMemberState } from '../../domain/voice/eligibility.js';

/**
 * The voiceStateUpdate ADAPTER (spec `04` §8.3).
 *
 * Discord sends ONE event shape for every voice transition, and the difference
 * between join, leave, move and a mute toggle is entirely in comparing the old
 * and new channel ids. Getting that comparison wrong is the classic voice bug:
 * treating a move as leave-plus-join resets the session, and with it the
 * anti-AFK timer — so hopping channels every two hours would defeat it, which
 * is the obvious exploit.
 *
 * This file translates and nothing else. Every decision lives in the service.
 */

export function createVoiceStateListener(deps: {
  readonly voice: VoiceService;
}): ListenerDefinition {
  return {
    event: Events.VoiceStateUpdate,
    handle: async (ctx: ModuleContext, ...args: unknown[]) => {
      const before = args[0] as VoiceState;
      const after = args[1] as VoiceState;

      const guildId = after.guild.id;
      const userId = after.id;

      const from = before.channelId;
      const to = after.channelId;

      // A bot's own voice state produces the same events; it never earns.
      if (after.member?.user.bot) return;

      try {
        if (from === null && to !== null) {
          const channel = snapshot(after.channel);
          if (channel) await deps.voice.onJoin(guildId, memberState(after), channel);
          return;
        }

        if (from !== null && to === null) {
          await deps.voice.onLeave(guildId, userId);
          // The channel they left changed population: someone may now be alone
          // and must stop earning.
          const left = snapshot(before.channel);
          if (left) await deps.voice.reevaluateChannel(left);
          return;
        }

        if (from !== null && to !== null && from !== to) {
          const channel = snapshot(after.channel);
          if (channel) await deps.voice.onMove(guildId, memberState(after), channel, from);
          const left = snapshot(before.channel);
          if (left) await deps.voice.reevaluateChannel(left);
          return;
        }

        // Same channel: a mute, deafen, or a state change we do not care about.
        // Re-evaluating the whole channel covers it, because a server-mute
        // changes whether this member counts toward everyone else's threshold.
        const channel = snapshot(after.channel);
        if (channel) await deps.voice.reevaluateChannel(channel);
      } catch (error) {
        ctx.log.error({ err: error, guildId, userId }, 'voice state handling failed');
      }
    },
  };
}

function memberState(state: VoiceState): VoiceMemberState {
  return {
    userId: state.id,
    isBot: state.member?.user.bot ?? false,
    selfMute: state.selfMute ?? false,
    selfDeaf: state.selfDeaf ?? false,
    serverMute: state.serverMute ?? false,
    serverDeaf: state.serverDeaf ?? false,
  };
}

/**
 * The channel as it is RIGHT NOW, including everyone else in it.
 *
 * Eligibility depends on other members' states, so this has to be the live
 * membership rather than anything derived from the event — the event describes
 * one member, and the answer depends on all of them.
 */
export function snapshot(channel: VoiceBasedChannel | null): VoiceChannelSnapshot | null {
  if (!channel) return null;

  return {
    guildId: channel.guild.id,
    channelId: channel.id,
    isAfkChannel: channel.guild.afkChannelId === channel.id,
    members: channel.members.map((member) => ({
      userId: member.id,
      isBot: member.user.bot,
      selfMute: member.voice.selfMute ?? false,
      selfDeaf: member.voice.selfDeaf ?? false,
      serverMute: member.voice.serverMute ?? false,
      serverDeaf: member.voice.serverDeaf ?? false,
    })),
  };
}

/** Every voice channel in every connected guild that currently has someone in it. */
export function currentVoiceSnapshots(ctx: ModuleContext): VoiceChannelSnapshot[] {
  const snapshots: VoiceChannelSnapshot[] = [];

  for (const guild of ctx.client.guilds.cache.values()) {
    for (const channel of guild.channels.cache.values()) {
      if (
        channel.type !== ChannelType.GuildVoice &&
        channel.type !== ChannelType.GuildStageVoice
      ) {
        continue;
      }
      if (channel.members.size === 0) continue;
      const state = snapshot(channel);
      if (state) snapshots.push(state);
    }
  }

  return snapshots;
}

/**
 * The tick job (ADR-004).
 *
 * Runs on a FIXED 30-second cadence rather than at each guild's configured
 * `voice_tick_seconds`, because the interval is per-guild and one timer cannot
 * serve fifty different periods. The service decides per session whether a full
 * tick is owed, so a guild configured for 180 seconds is credited every 180
 * seconds regardless of how often this fires — the cadence bounds crash loss,
 * it does not set the XP rate.
 */
export function createVoiceTickJob(deps: { readonly voice: VoiceService }): JobDefinition {
  return {
    name: 'leveling:voice-tick',
    intervalMs: 30_000,
    skipInitialRun: true,

    async run(ctx: ModuleContext) {
      const result = await deps.voice.tick();
      if (result.credited > 0) {
        ctx.log.debug(result, 'voice tick credited sessions');
      }
    },
  };
}
