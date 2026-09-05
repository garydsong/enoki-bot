import { describe, expect, it } from 'vitest';
import { computeLevelTransition, evaluateXp } from '../../src/modules/leveling/domain/engine/pipeline.js';
import { DEFAULT_LEVELING_CONFIG } from '../../src/modules/leveling/domain/support/defaults.js';
import type {
  Clock,
  GuildLevelingConfig,
  LocationChain,
  MemberContext,
  Rng,
  XpCandidate,
  XpRule,
} from '../../src/modules/leveling/domain/types.js';

const NOW = 1_800_000_000_000;
const clock: Clock = { now: () => NOW };
/** Deterministic RNG: always the midpoint, so amounts are predictable. */
const rng: Rng = { intBetween: (min, max) => Math.floor((min + max) / 2) };

const config = (over: Partial<GuildLevelingConfig> = {}): GuildLevelingConfig => ({
  ...DEFAULT_LEVELING_CONFIG,
  enabled: true,
  ...over,
});

const loc = (over: Partial<LocationChain> = {}): LocationChain => ({
  channelId: 'general',
  parentChannelId: null,
  categoryId: null,
  isThread: false,
  isForumPost: false,
  isVoiceText: false,
  ...over,
});

const member = (over: Partial<MemberContext> = {}): MemberContext => ({
  userId: 'u1',
  roleIds: [],
  isBot: false,
  isWebhook: false,
  isSelf: false,
  isIgnored: false,
  currentTotalXp: 0,
  currentLevel: 0,
  cooldownExpiresAt: null,
  ...over,
});

const messageCandidate = (over: Partial<XpCandidate> = {}): XpCandidate => ({
  source: 'message',
  occurredAt: NOW,
  idempotencyKey: 'msg:1',
  location: loc(),
  hasContent: true,
  messageLength: 40,
  ...over,
});

const evaluate = (
  c: Partial<XpCandidate> = {},
  m: Partial<MemberContext> = {},
  cfg: Partial<GuildLevelingConfig> = {},
  collectAll = false,
) => evaluateXp(messageCandidate(c), member(m), config(cfg), clock, rng, { collectAll });

const gate = (decision: ReturnType<typeof evaluate>, name: string) =>
  decision.trace.find((s) => s.gate === name);

// ===========================================================================
// THE WORKED EXAMPLE FROM THE BRIEF (spec `04` §3.3, ADR-011)
// ===========================================================================

describe('THE WORKED PRECEDENCE EXAMPLE (ADR-011)', () => {
  const rules: XpRule[] = [
    { kind: 'boost', targetType: 'role', targetId: 'vip', bonusBps: 10000 }, // +100%
    { kind: 'boost', targetType: 'channel', targetId: 'general', bonusBps: 5000 }, // +50%
    { kind: 'restrict_deny', targetType: 'role', targetId: 'muted' },
    { kind: 'restrict_deny', targetType: 'channel', targetId: 'general' },
  ];

  const decision = evaluate({}, { roleIds: ['vip', 'muted'] }, { rules });

  it('awards NO XP', () => {
    expect(decision.outcome).toBe('denied');
    expect(decision.finalXp).toBe(0);
  });

  it('denies with role_denied — gate 5 is reached before gate 6', () => {
    expect(decision.denyReason).toBe('role_denied');
  });

  it('consumes no cooldown', () => {
    expect(decision.consumesCooldown).toBe(false);
  });

  it('never evaluates the boosters — they live in the amount phase', () => {
    expect(gate(decision, 'multiplier_stack')?.verdict).toBe('skip');
    expect(gate(decision, 'base_xp_roll')?.verdict).toBe('skip');
  });

  it('still reports what the multiplier WOULD have been, for the admin', () => {
    // +100% and +50% stacked = x2.50. Shown, but not applied.
    expect(decision.multiplierBps).toBe(25000);
    expect(gate(decision, 'multiplier_stack')?.detail).toContain('x2.50');
  });

  it('collect-all mode reports BOTH restrictions, not just the first', () => {
    const all = evaluate({}, { roleIds: ['vip', 'muted'] }, { rules }, true);
    expect(all.allDenyReasons).toContain('role_denied');
    expect(all.allDenyReasons).toContain('channel_denied');
  });
});

// ===========================================================================
// Eligibility phase
// ===========================================================================

describe('gate 1-2: module and source', () => {
  it('denies when leveling is disabled', () => {
    expect(evaluate({}, {}, { enabled: false }).denyReason).toBe('module_disabled');
  });

  it('denies when the source is off', () => {
    const cfg = config();
    const d = evaluate(
      {},
      {},
      { sources: { ...cfg.sources, message: { ...cfg.sources.message, enabled: false } } },
    );
    expect(d.denyReason).toBe('source_disabled');
  });
});

describe('gate 3: bots and webhooks are hard-rejected (not configurable)', () => {
  it('denies a bot', () => {
    expect(evaluate({}, { isBot: true }).denyReason).toBe('actor_is_bot');
  });

  it('denies a webhook — checked before the bot flag', () => {
    expect(evaluate({}, { isWebhook: true, isBot: true }).denyReason).toBe('actor_is_webhook');
  });

  it('denies the bot itself', () => {
    expect(evaluate({}, { isSelf: true }).denyReason).toBe('actor_is_self');
  });
});

describe('gate 4: actor eligibility', () => {
  it('denies an ignored user', () => {
    expect(evaluate({}, { isIgnored: true }).denyReason).toBe('user_ignored');
  });

  it('denies an account younger than the configured minimum', () => {
    const d = evaluate(
      {},
      { accountCreatedAt: NOW - 2 * 86_400_000 },
      { minAccountAgeDays: 7 },
    );
    expect(d.denyReason).toBe('account_too_new');
  });

  it('allows an account older than the minimum', () => {
    const d = evaluate({}, { accountCreatedAt: NOW - 30 * 86_400_000 }, { minAccountAgeDays: 7 });
    expect(d.outcome).toBe('awarded');
  });

  it('denies a member who joined too recently', () => {
    const d = evaluate({}, { joinedGuildAt: NOW - 3_600_000 }, { minMemberAgeHours: 24 });
    expect(d.denyReason).toBe('member_too_new');
  });

  it('the levers are off by default', () => {
    expect(evaluate({}, { accountCreatedAt: NOW - 1000 }).outcome).toBe('awarded');
  });
});

describe('gate 8: cooldown', () => {
  it('denies while a cooldown is active', () => {
    const d = evaluate({}, { cooldownExpiresAt: NOW + 30_000 });
    expect(d.denyReason).toBe('on_cooldown');
    expect(gate(d, 'cooldown')?.data?.remainingMs).toBe(30_000);
  });

  it('a denial never consumes the cooldown', () => {
    expect(evaluate({}, { cooldownExpiresAt: NOW + 30_000 }).consumesCooldown).toBe(false);
  });

  it('allows once the cooldown has expired', () => {
    expect(evaluate({}, { cooldownExpiresAt: NOW - 1 }).outcome).toBe('awarded');
  });

  it('an award consumes the cooldown', () => {
    expect(evaluate().consumesCooldown).toBe(true);
  });

  it('the trace says what the cooldown WOULD have done on an earlier denial', () => {
    const d = evaluate({}, { isBot: true, cooldownExpiresAt: NOW + 5_000 });
    expect(gate(d, 'cooldown')?.detail).toContain('would have DENIED');
  });
});

describe('gate 9: max level (decision C9)', () => {
  it('by default XP keeps accruing at the cap', () => {
    const d = evaluate({}, { currentLevel: 10 }, { curve: { ...DEFAULT_LEVELING_CONFIG.curve, maxLevel: 10 } });
    expect(d.outcome).toBe('awarded');
  });

  it('hardCapXp stops awarding entirely', () => {
    const d = evaluate(
      {},
      { currentLevel: 10 },
      { curve: { ...DEFAULT_LEVELING_CONFIG.curve, maxLevel: 10, hardCapXp: true } },
    );
    expect(d.denyReason).toBe('max_level');
  });
});

// ===========================================================================
// Amount phase
// ===========================================================================

describe('gate 10: base roll', () => {
  it('awards the rolled amount with no boosters', () => {
    const d = evaluate();
    expect(d.baseXp).toBe(20); // midpoint of 15..25
    expect(d.finalXp).toBe(20);
    expect(d.multiplierBps).toBe(10000);
  });
});

describe('gate 12-13: multiplier and rounding', () => {
  it('applies a stacked multiplier and rounds once at the end', () => {
    const rules: XpRule[] = [{ kind: 'boost', targetType: 'guild', targetId: null, bonusBps: 5000 }];
    const d = evaluate({}, {}, { rules });
    expect(d.finalXp).toBe(30); // 20 * 1.5
  });

  it('rounds half-up (decision C8) — a tiny boost can be invisible', () => {
    const rules: XpRule[] = [{ kind: 'boost', targetType: 'guild', targetId: null, bonusBps: 100 }];
    const d = evaluate({}, {}, { rules });
    expect(d.finalXp).toBe(20); // 20 * 1.01 = 20.2 -> 20
  });

  it('clamps to the per-event cap', () => {
    const cfg = config();
    const d = evaluate(
      {},
      {},
      {
        sources: { ...cfg.sources, message: { ...cfg.sources.message, perEventCap: 25 } },
        rules: [{ kind: 'boost', targetType: 'guild', targetId: null, bonusBps: 90000 }],
        maxMultiplierBps: 1_000_000,
      },
    );
    expect(d.finalXp).toBe(25);
  });

  it('a -100% nerf produces zero and is reported as computed_zero', () => {
    const rules: XpRule[] = [{ kind: 'boost', targetType: 'guild', targetId: null, bonusBps: -10000 }];
    const d = evaluate({}, {}, { rules });
    expect(d.outcome).toBe('denied');
    expect(d.denyReason).toBe('computed_zero');
    expect(d.consumesCooldown).toBe(false);
  });
});

describe('gate 11: effort booster', () => {
  const effort = { enabled: true, charsPerXp: 50, lengthCap: 10, attachmentXp: 5 };

  it('adds a length bonus', () => {
    const d = evaluate({ messageLength: 200 }, {}, { effort });
    expect(d.effortBonus).toBe(4); // floor(200/50)
  });

  it('caps the length bonus', () => {
    const d = evaluate({ messageLength: 100_000 }, {}, { effort });
    expect(d.effortBonus).toBe(10);
  });

  it('counts attachments once, not per attachment', () => {
    const a = evaluate({ messageLength: 0, attachmentCount: 1 }, {}, { effort });
    const b = evaluate({ messageLength: 0, attachmentCount: 10 }, {}, { effort });
    expect(a.effortBonus).toBe(5);
    expect(b.effortBonus).toBe(5);
  });

  it('awards nothing without the MessageContent intent', () => {
    const d = evaluate({ hasContent: false }, {}, { effort });
    expect(d.effortBonus).toBe(0);
    expect(d.outcome).toBe('awarded');
  });
});

describe('per-word mode', () => {
  const perWord = (cfg = config()) => ({
    sources: { ...cfg.sources, message: { ...cfg.sources.message, messageMode: 'per_word' as const } },
  });

  it('awards max XP per qualifying word', () => {
    const d = evaluate({ wordCount: 4, whitespaceRuns: 3 }, {}, perWord());
    expect(d.baseXp).toBe(100); // 4 * 25
  });

  it('rejects padding: words must exceed whitespace runs', () => {
    const d = evaluate({ wordCount: 3, whitespaceRuns: 8 }, {}, perWord());
    expect(d.denyReason).toBe('per_word_padding');
  });

  it('falls back to a random roll without message content', () => {
    const d = evaluate({ hasContent: false }, {}, perWord());
    expect(d.baseXp).toBe(20);
  });
});

describe('minimum message length', () => {
  it('denies a message below the configured minimum', () => {
    const d = evaluate({ messageLength: 2 }, {}, { context: { ...DEFAULT_LEVELING_CONFIG.context, minMessageLength: 10 } });
    expect(d.denyReason).toBe('message_too_short');
  });

  it('cannot be enforced without message content, so it does not deny', () => {
    const d = evaluate(
      { hasContent: false },
      {},
      { context: { ...DEFAULT_LEVELING_CONFIG.context, minMessageLength: 10 } },
    );
    expect(d.outcome).toBe('awarded');
  });
});

describe('reaction sources', () => {
  const reaction = (over: Partial<XpCandidate> = {}) =>
    evaluateXp(
      {
        source: 'reaction_add',
        occurredAt: NOW,
        idempotencyKey: 'radd:1',
        location: loc(),
        reactorId: 'u1',
        messageAuthorId: 'u2',
        ...over,
      },
      member(),
      config({
        sources: {
          ...DEFAULT_LEVELING_CONFIG.sources,
          reaction_add: { ...DEFAULT_LEVELING_CONFIG.sources.reaction_add, enabled: true },
        },
      }),
      clock,
      rng,
    );

  it('awards for reacting to someone else', () => {
    expect(reaction().outcome).toBe('awarded');
  });

  it('denies a self-reaction by default (decision C11)', () => {
    expect(reaction({ messageAuthorId: 'u1' }).denyReason).toBe('self_reaction');
  });

  it('denies a reaction already counted — the anti-farming guard', () => {
    expect(reaction({ alreadyCounted: true }).denyReason).toBe('reaction_already_counted');
  });
});

describe('voice source', () => {
  const voiceCfg = config({
    sources: {
      ...DEFAULT_LEVELING_CONFIG.sources,
      voice: { ...DEFAULT_LEVELING_CONFIG.sources.voice, enabled: true },
    },
  });

  const voice = (over: Partial<XpCandidate> = {}) =>
    evaluateXp(
      {
        source: 'voice',
        occurredAt: NOW,
        idempotencyKey: 'voice:1:1',
        voiceEligibleSeconds: 180,
        voiceTickSeconds: 180,
        sessionEligibleSeconds: 600,
        ...over,
      },
      member(),
      voiceCfg,
      clock,
      rng,
    );

  it('awards a full tick', () => {
    expect(voice().finalXp).toBe(12); // midpoint of 10..15
  });

  it('prorates a partial tick', () => {
    expect(voice({ voiceEligibleSeconds: 60 }).finalXp).toBe(4); // 12 * 1/3
  });

  it('denies a tick with no eligible time', () => {
    expect(voice({ voiceEligibleSeconds: 0 }).denyReason).toBe('voice_inactive');
  });

  it('is not location-restricted', () => {
    expect(voice().outcome).toBe('awarded');
  });

  it('applies anti-AFK decay as a separate multiplicative penalty', () => {
    const long = voice({ sessionEligibleSeconds: 6 * 3600 });
    expect(long.finalXp).toBeLessThan(12);
    expect(long.trace.some((s) => s.gate === 'anti_afk')).toBe(true);
  });

  it('a large booster cannot cancel out the anti-AFK penalty', () => {
    const boosted = evaluateXp(
      {
        source: 'voice',
        occurredAt: NOW,
        idempotencyKey: 'v',
        voiceEligibleSeconds: 180,
        voiceTickSeconds: 180,
        sessionEligibleSeconds: 12 * 3600,
      },
      member(),
      { ...voiceCfg, rules: [{ kind: 'boost', targetType: 'guild', targetId: null, bonusBps: 10000 }] },
      clock,
      rng,
    );
    // x2 booster on a x0.1-floored session: 12 * 2 * 0.1 = 2.4 -> 2
    expect(boosted.finalXp).toBe(2);
  });
});

// ===========================================================================
// Trace contract — this is what /level debug why renders
// ===========================================================================

describe('the trace is always produced', () => {
  it('on an award', () => {
    expect(evaluate().trace.length).toBeGreaterThan(10);
  });

  it('on a denial', () => {
    expect(evaluate({}, { isBot: true }).trace.length).toBeGreaterThan(10);
  });

  it('runs gates in the documented order', () => {
    const order = evaluate().trace.map((s) => s.gate);
    expect(order.slice(0, 9)).toEqual([
      'module_enabled',
      'source_enabled',
      'actor_is_human',
      'actor_eligible',
      'role_denied',
      'location_allowed',
      'source_specific_gate',
      'cooldown',
      'max_level',
    ]);
  });

  it('marks every gate after a denial as skipped, never passed', () => {
    const d = evaluate({}, { isIgnored: true });
    const after = d.trace.slice(d.trace.findIndex((s) => s.gate === 'actor_eligible') + 1);
    expect(after.every((s) => s.verdict === 'skip')).toBe(true);
  });

  it('short-circuits by default but collects everything in debug mode', () => {
    const rules: XpRule[] = [
      { kind: 'restrict_deny', targetType: 'role', targetId: 'muted' },
      { kind: 'restrict_deny', targetType: 'channel', targetId: 'general' },
    ];
    expect(evaluate({}, { roleIds: ['muted'] }, { rules }).allDenyReasons).toHaveLength(1);
    expect(evaluate({}, { roleIds: ['muted'] }, { rules }, true).allDenyReasons).toHaveLength(2);
  });
});

// ===========================================================================
// Level transitions
// ===========================================================================

describe('level transitions from an atomic before/after pair', () => {
  const cfg = config();

  it('detects a single level up', () => {
    const t = computeLevelTransition(0, 80, cfg);
    expect(t).toMatchObject({ levelBefore: 0, levelAfter: 1, leveledUp: true, leveledDown: false });
    expect(t.levelsCrossed).toEqual([1]);
  });

  it('detects no change', () => {
    const t = computeLevelTransition(10, 20, cfg);
    expect(t.leveledUp).toBe(false);
    expect(t.levelsCrossed).toEqual([]);
  });

  it('reports every level crossed on a big manual grant', () => {
    const t = computeLevelTransition(0, 21_000, cfg);
    expect(t.levelBefore).toBe(0);
    expect(t.levelAfter).toBe(20);
    expect(t.levelsCrossed).toHaveLength(20);
    // The announcement uses the LAST level, once — spec FR-5.4.
    expect(t.levelsCrossed.at(-1)).toBe(20);
  });

  it('detects a multi-level drop from XP removal', () => {
    const t = computeLevelTransition(21_000, 0, cfg);
    expect(t.leveledDown).toBe(true);
    expect(t.levelAfter).toBe(0);
    expect(t.levelsCrossed).toEqual([]);
  });

  it('two consecutive awards cannot observe the same "before"', () => {
    const first = computeLevelTransition(0, 75, cfg);
    const second = computeLevelTransition(75, 260, cfg);
    expect(first.levelAfter).toBe(1);
    expect(second.levelBefore).toBe(1);
    expect(second.levelAfter).toBe(2);
  });
});
