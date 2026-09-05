import { describe, expect, it } from 'vitest';
import {
  antiAfkMultiplier,
  countableOthers,
  evaluateVoiceEligibility,
  isCountableMember,
  tickEligibilityFraction,
  type VoiceChannelState,
  type VoiceMemberState,
} from '../../src/modules/leveling/domain/voice/eligibility.js';
import { DEFAULT_LEVELING_CONFIG } from '../../src/modules/leveling/domain/support/defaults.js';
import type { VoiceConfig } from '../../src/modules/leveling/domain/types.js';

const cfg = (over: Partial<VoiceConfig> = {}): VoiceConfig => ({
  ...DEFAULT_LEVELING_CONFIG.voice,
  ...over,
});

const m = (over: Partial<VoiceMemberState> = {}): VoiceMemberState => ({
  userId: 'u1',
  isBot: false,
  selfMute: false,
  selfDeaf: false,
  serverMute: false,
  serverDeaf: false,
  ...over,
});

const channel = (members: VoiceMemberState[], isAfk = false): VoiceChannelState => ({
  channelId: 'vc1',
  isAfkChannel: isAfk,
  members,
});

describe('eligibility predicate', () => {
  it('a normal member with company earns', () => {
    const me = m();
    expect(evaluateVoiceEligibility(me, channel([me, m({ userId: 'u2' })]), cfg()).eligible).toBe(true);
  });

  it('a bot never earns', () => {
    const bot = m({ isBot: true });
    expect(evaluateVoiceEligibility(bot, channel([bot, m({ userId: 'u2' })]), cfg()).eligible).toBe(false);
  });

  it('the AFK channel earns nothing', () => {
    const me = m();
    const v = evaluateVoiceEligibility(me, channel([me, m({ userId: 'u2' })], true), cfg());
    expect(v).toMatchObject({ eligible: false, reason: 'in the AFK channel' });
  });

  it('self-deafened earns nothing', () => {
    const me = m({ selfDeaf: true });
    expect(evaluateVoiceEligibility(me, channel([me, m({ userId: 'u2' })]), cfg()).eligible).toBe(false);
  });

  it('self-muted earns nothing', () => {
    const me = m({ selfMute: true });
    expect(evaluateVoiceEligibility(me, channel([me, m({ userId: 'u2' })]), cfg()).eligible).toBe(false);
  });

  it('server-muted earns nothing when configured', () => {
    const me = m({ serverMute: true });
    expect(evaluateVoiceEligibility(me, channel([me, m({ userId: 'u2' })]), cfg()).eligible).toBe(false);
  });

  it('server mute can be ignored by configuration', () => {
    const me = m({ serverMute: true });
    const v = evaluateVoiceEligibility(
      me,
      channel([me, m({ userId: 'u2' })]),
      cfg({ countServerMuteAsInactive: false }),
    );
    expect(v.eligible).toBe(true);
  });

  it('each requirement can be relaxed independently', () => {
    const me = m({ selfMute: true });
    expect(
      evaluateVoiceEligibility(me, channel([me, m({ userId: 'u2' })]), cfg({ requireUnmuted: false }))
        .eligible,
    ).toBe(true);
  });
});

describe('minimum members (decision C7)', () => {
  it('alone in a channel earns nothing', () => {
    const me = m();
    const v = evaluateVoiceEligibility(me, channel([me]), cfg());
    expect(v).toMatchObject({ eligible: false });
    expect((v as { reason: string }).reason).toContain('found 0');
  });

  it('a bot does not count as company by default', () => {
    const me = m();
    const bot = m({ userId: 'bot', isBot: true });
    expect(evaluateVoiceEligibility(me, channel([me, bot]), cfg()).eligible).toBe(false);
  });

  it('a bot can be made to count', () => {
    const me = m();
    const bot = m({ userId: 'bot', isBot: true });
    expect(
      evaluateVoiceEligibility(me, channel([me, bot]), cfg({ ignoreBotsInMemberCount: false }))
        .eligible,
    ).toBe(true);
  });

  /**
   * The deadlock this rule exists to avoid: if counting required full
   * eligibility, two muted friends would never enable each other.
   */
  it('a MUTED other still counts toward the threshold', () => {
    const me = m();
    const other = m({ userId: 'u2', selfMute: true });
    expect(evaluateVoiceEligibility(me, channel([me, other]), cfg()).eligible).toBe(true);
  });

  it('a DEAFENED other does not count', () => {
    const me = m();
    const other = m({ userId: 'u2', selfDeaf: true });
    expect(evaluateVoiceEligibility(me, channel([me, other]), cfg()).eligible).toBe(false);
  });

  it('honours a higher threshold', () => {
    const me = m();
    const two = [m({ userId: 'a' }), m({ userId: 'b' })];
    expect(evaluateVoiceEligibility(me, channel([me, ...two]), cfg({ minMembers: 3 })).eligible).toBe(false);
    expect(evaluateVoiceEligibility(me, channel([me, ...two]), cfg({ minMembers: 2 })).eligible).toBe(true);
  });

  it('minMembers 0 permits earning alone', () => {
    const me = m();
    expect(evaluateVoiceEligibility(me, channel([me]), cfg({ minMembers: 0 })).eligible).toBe(true);
  });

  it('counting helpers exclude self', () => {
    const me = m();
    expect(countableOthers(channel([me, m({ userId: 'u2' })]), 'u1', cfg())).toBe(1);
    expect(isCountableMember(m({ selfDeaf: true }), cfg())).toBe(false);
  });
});

describe('anti-AFK decay (decision B2)', () => {
  const c = cfg();

  it('is neutral before the threshold', () => {
    expect(antiAfkMultiplier(0, c)).toBe(1);
    expect(antiAfkMultiplier(119 * 60, c)).toBe(1);
    expect(antiAfkMultiplier(120 * 60, c)).toBe(1);
  });

  it('decays 25% per hour beyond the threshold', () => {
    expect(antiAfkMultiplier(180 * 60, c)).toBeCloseTo(0.75, 5);
    expect(antiAfkMultiplier(240 * 60, c)).toBeCloseTo(0.5625, 5);
    expect(antiAfkMultiplier(360 * 60, c)).toBeCloseTo(0.31640625, 5);
  });

  it('never falls below the floor', () => {
    expect(antiAfkMultiplier(48 * 3600, c)).toBe(c.antiAfkFloorMultiplier);
  });

  it('decreases monotonically', () => {
    let previous = 1.1;
    for (let hours = 2; hours <= 24; hours++) {
      const value = antiAfkMultiplier(hours * 3600, c);
      expect(value).toBeLessThanOrEqual(previous);
      previous = value;
    }
  });

  it('can be turned off entirely', () => {
    expect(antiAfkMultiplier(100 * 3600, cfg({ antiAfkEnabled: false }))).toBe(1);
  });
});

describe('partial tick crediting', () => {
  it('credits the eligible fraction', () => {
    expect(tickEligibilityFraction(60, 180)).toBeCloseTo(1 / 3, 10);
    expect(tickEligibilityFraction(180, 180)).toBe(1);
    expect(tickEligibilityFraction(0, 180)).toBe(0);
  });

  it('clamps out-of-range input rather than over-crediting', () => {
    expect(tickEligibilityFraction(500, 180)).toBe(1);
    expect(tickEligibilityFraction(-50, 180)).toBe(0);
    expect(tickEligibilityFraction(60, 0)).toBe(0);
  });
});
