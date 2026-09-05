import type { VoiceConfig } from '../types.js';

/**
 * Voice eligibility and anti-AFK (spec `04` §8.4–8.5).
 *
 * Arcane documents that a member is only "active" when unmuted and not deaf, and
 * that a "Minimum Members" threshold exists — but not the counting rule. Ours is
 * recorded as decision C7: a member COUNTS toward the threshold if they are a
 * non-bot human who is not deafened; mute is ignored for counting. Requiring
 * full eligibility to count would deadlock — two muted friends would never
 * enable each other.
 */

export interface VoiceMemberState {
  readonly userId: string;
  readonly isBot: boolean;
  readonly selfMute: boolean;
  readonly selfDeaf: boolean;
  readonly serverMute: boolean;
  readonly serverDeaf: boolean;
}

export interface VoiceChannelState {
  readonly channelId: string;
  readonly isAfkChannel: boolean;
  readonly members: readonly VoiceMemberState[];
}

export type VoiceEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: string };

/** Countable toward `minMembers` — looser than "eligible". See C7. */
export function isCountableMember(member: VoiceMemberState, config: VoiceConfig): boolean {
  if (member.isBot && config.ignoreBotsInMemberCount) return false;
  if (member.selfDeaf || member.serverDeaf) return false;
  return true;
}

export function countableOthers(
  channel: VoiceChannelState,
  selfUserId: string,
  config: VoiceConfig,
): number {
  return channel.members.filter((m) => m.userId !== selfUserId && isCountableMember(m, config))
    .length;
}

export function evaluateVoiceEligibility(
  member: VoiceMemberState,
  channel: VoiceChannelState,
  config: VoiceConfig,
): VoiceEligibility {
  if (member.isBot) {
    return { eligible: false, reason: 'bots never earn XP' };
  }
  if (config.ignoreAfkChannel && channel.isAfkChannel) {
    return { eligible: false, reason: 'in the AFK channel' };
  }
  if (config.requireUndeafened && member.selfDeaf) {
    return { eligible: false, reason: 'self-deafened' };
  }
  if (config.requireUnmuted && member.selfMute) {
    return { eligible: false, reason: 'self-muted' };
  }
  if (config.countServerMuteAsInactive && (member.serverMute || member.serverDeaf)) {
    return { eligible: false, reason: 'server-muted or server-deafened' };
  }

  const others = countableOthers(channel, member.userId, config);
  if (others < config.minMembers) {
    return {
      eligible: false,
      reason: `needs ${config.minMembers} other active member(s), found ${others}`,
    };
  }

  return { eligible: true };
}

/**
 * Anti-AFK decay multiplier.
 *
 * Arcane documents only that XP "starts to lower after multiple hours in one
 * session". The curve below is ours (decision B2):
 *   decay = (1 - decayPerHour) ^ hoursBeyondThreshold, floored.
 *
 * `sessionEligibleSeconds` is ELIGIBLE time, not wall-clock, and it survives a
 * channel move — otherwise hopping channels every two hours defeats it, which is
 * the obvious exploit.
 */
export function antiAfkMultiplier(sessionEligibleSeconds: number, config: VoiceConfig): number {
  if (!config.antiAfkEnabled) return 1;

  const thresholdSeconds = config.antiAfkAfterMinutes * 60;
  if (sessionEligibleSeconds <= thresholdSeconds) return 1;

  const hoursOver = (sessionEligibleSeconds - thresholdSeconds) / 3600;
  const decay = Math.pow(1 - config.antiAfkDecayPerHour, hoursOver);

  return Math.max(config.antiAfkFloorMultiplier, decay);
}

/**
 * Fraction of a tick that was actually eligible. A member who mutes 60s into a
 * 180s tick is credited one third.
 */
export function tickEligibilityFraction(eligibleSeconds: number, tickSeconds: number): number {
  if (tickSeconds <= 0) return 0;
  return Math.min(1, Math.max(0, eligibleSeconds / tickSeconds));
}
