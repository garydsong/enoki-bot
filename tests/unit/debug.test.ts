import { describe, expect, it } from 'vitest';
import {
  dryRun,
  findConfigContradictions,
  findDanglingTargets,
} from '../../src/modules/leveling/application/queries/debug.js';
import { DEFAULT_LEVELING_CONFIG } from '../../src/modules/leveling/domain/support/defaults.js';
import type {
  Clock,
  GuildLevelingConfig,
  LocationChain,
  MemberContext,
  Rng,
  XpCandidate,
} from '../../src/modules/leveling/domain/types.js';

const NOW = Date.UTC(2026, 4, 20, 12, 0, 0);
const clock: Clock = { now: () => NOW };
const rng: Rng = { intBetween: (min, max) => Math.floor((min + max) / 2) };

const config = (over: Partial<GuildLevelingConfig> = {}): GuildLevelingConfig => ({
  ...DEFAULT_LEVELING_CONFIG,
  enabled: true,
  ...over,
});

const location: LocationChain = {
  channelId: 'chan',
  parentChannelId: null,
  categoryId: 'cat',
  isThread: false,
  isForumPost: false,
  isVoiceText: false,
};

const candidate: XpCandidate = {
  source: 'message',
  occurredAt: NOW,
  idempotencyKey: 'debug:1',
  location,
  hasContent: true,
  messageLength: 50,
  wordCount: 10,
  whitespaceRuns: 9,
};

const member = (over: Partial<MemberContext> = {}): MemberContext => ({
  userId: 'u1',
  roleIds: [],
  isBot: false,
  isWebhook: false,
  isSelf: false,
  isIgnored: false,
  currentTotalXp: 0,
  currentLevel: 0,
  ...over,
});

describe('the dry run', () => {
  it('reports a pass with the amount that would be awarded', () => {
    const result = dryRun({ candidate, member: member(), config: config() }, clock, rng);
    expect(result.decision.outcome).toBe('awarded');
    expect(result.decision.finalXp).toBeGreaterThan(0);
    expect(result.failing).toEqual([]);
  });

  it('reports EVERY failing gate, not just the first', () => {
    // The whole point of collect-all mode: an admin who fixes one problem
    // should not be ambushed by a second on the next round trip.
    const result = dryRun(
      {
        candidate,
        member: member({ isIgnored: true }),
        config: config({
          enabled: false,
          sources: {
            ...DEFAULT_LEVELING_CONFIG.sources,
            message: { ...DEFAULT_LEVELING_CONFIG.sources.message, enabled: false },
          },
        }),
      },
      clock,
      rng,
    );

    const reasons = result.decision.allDenyReasons;
    expect(reasons).toContain('module_disabled');
    expect(reasons).toContain('source_disabled');
    expect(reasons).toContain('user_ignored');
    expect(result.failing.length).toBeGreaterThanOrEqual(3);
  });

  it('explains a cooldown without consuming one', () => {
    // The cooldown is PEEKED and passed in. A debug command that consumed it
    // would change the answer by asking the question.
    const result = dryRun(
      { candidate, member: member({ cooldownExpiresAt: NOW + 30_000 }), config: config() },
      clock,
      rng,
    );
    expect(result.decision.allDenyReasons).toContain('on_cooldown');
  });

  it('keeps the passing steps too, so the whole path is visible', () => {
    const result = dryRun({ candidate, member: member(), config: config() }, clock, rng);
    expect(result.trace.length).toBeGreaterThan(result.failing.length);
    expect(result.trace.some((s) => s.verdict === 'pass')).toBe(true);
  });
});

describe('dangling configuration', () => {
  const exists = (channels: string[], roles: string[]) => ({
    channel: (id: string) => channels.includes(id),
    role: (id: string) => roles.includes(id),
  });

  it('finds a level-up channel that was deleted', () => {
    // The quiet failure: nothing errors, announcements just stop.
    const found = findDanglingTargets(
      config({
        notifications: {
          ...DEFAULT_LEVELING_CONFIG.notifications,
          mode: 'fixed_channel',
          channelId: 'gone',
        },
      }),
      exists([], []),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe('levelup_channel');
  });

  it('finds a restriction pointing at a deleted channel or role', () => {
    const found = findDanglingTargets(
      config({
        rules: [
          { kind: 'restrict_deny', targetType: 'channel', targetId: 'gone' },
          { kind: 'boost', targetType: 'role', targetId: 'alsogone', bonusBps: 5000 },
        ],
      }),
      exists([], []),
    );
    expect(found.map((f) => f.kind)).toEqual(['rule_channel', 'rule_role']);
  });

  it('finds a reward granting a deleted role', () => {
    const found = findDanglingTargets(
      config({ rewards: [{ type: 'exact', level: 5, roleId: 'gone' }] }),
      exists([], []),
    );
    expect(found[0]?.kind).toBe('reward_role');
  });

  it('says nothing when everything resolves', () => {
    const found = findDanglingTargets(
      config({
        rules: [{ kind: 'restrict_deny', targetType: 'channel', targetId: 'c1' }],
        rewards: [{ type: 'exact', level: 5, roleId: 'r1' }],
      }),
      exists(['c1'], ['r1']),
    );
    expect(found).toEqual([]);
  });
});

describe('configuration contradictions', () => {
  it('flags an inverted XP range as an error', () => {
    const findings = findConfigContradictions(
      config({
        sources: {
          ...DEFAULT_LEVELING_CONFIG.sources,
          message: { ...DEFAULT_LEVELING_CONFIG.sources.message, minXp: 50, maxXp: 10 },
        },
      }),
    );
    expect(findings.some((f) => f.severity === 'error' && /inverted/.test(f.title))).toBe(true);
  });

  it('flags a booster that a restriction makes unreachable', () => {
    // Legal, and almost never intended: restrictions always beat boosters.
    const findings = findConfigContradictions(
      config({
        rules: [
          { kind: 'restrict_deny', targetType: 'role', targetId: 'r1' },
          { kind: 'boost', targetType: 'role', targetId: 'r1', bonusBps: 5000 },
        ],
      }),
    );
    expect(findings.some((f) => /never apply/.test(f.title))).toBe(true);
  });

  it('flags fixed_channel mode with no channel chosen', () => {
    const findings = findConfigContradictions(
      config({
        notifications: {
          ...DEFAULT_LEVELING_CONFIG.notifications,
          mode: 'fixed_channel',
          channelId: null,
        },
      }),
    );
    expect(findings.some((f) => f.severity === 'error')).toBe(true);
  });

  it('mentions that an "only" rule turns everywhere else off', () => {
    const findings = findConfigContradictions(
      config({ rules: [{ kind: 'restrict_only', targetType: 'channel', targetId: 'c1' }] }),
    );
    expect(findings.some((f) => /restricted to/.test(f.title))).toBe(true);
  });

  it('says leveling is off before anything else', () => {
    const findings = findConfigContradictions(config({ enabled: false }));
    expect(findings[0]?.title).toBe('Leveling is off');
  });

  it('is silent on a sensible default configuration', () => {
    expect(findConfigContradictions(config())).toEqual([]);
  });
});
