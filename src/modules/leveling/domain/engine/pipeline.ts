import { getCurve } from '../curve/curve.js';
import { NEUTRAL_BPS, resolveMultiplier } from '../boosters/resolver.js';
import { findDeniedRole, resolveLocation } from '../restrictions/resolver.js';
import { antiAfkMultiplier, tickEligibilityFraction } from '../voice/eligibility.js';
import type {
  Clock,
  DenyCode,
  GuildLevelingConfig,
  MemberContext,
  Rng,
  TraceStep,
  Verdict,
  XpCandidate,
  XpDecision,
} from '../types.js';

/**
 * THE XP EVALUATION PIPELINE (spec `04` §2, ADR-011).
 *
 * Fourteen gates in a fixed order, split into two phases:
 *
 *   ELIGIBILITY (gates 1-9)  boolean. "May this member earn here, now?"
 *   AMOUNT      (gates 10-14) arithmetic. "How much?"
 *
 * No amount-phase step can resurrect an eligibility denial. That single rule is
 * what makes configuration deterministic and explainable — a member with a no-XP
 * role and a 2x booster earns nothing, and the trace shows exactly why.
 *
 * A TRACE IS PRODUCED ON EVERY EVALUATION, awarded or not. It is not a debug
 * mode. `/level debug why` is just this function run with collectAll and the
 * result rendered. The cost is a small array that is discarded unless requested.
 *
 * This module is PURE. Clock and Rng are injected. No I/O, no Discord, no DB.
 */

export interface EvaluateOptions {
  /**
   * Continue past the first denial and report every failing gate.
   * Used by `/level debug why` so an admin fixing one problem is not ambushed
   * by a second. Awarding paths use the default (short-circuit).
   */
  readonly collectAll?: boolean;
}

interface Ctx {
  readonly candidate: XpCandidate;
  readonly member: MemberContext;
  readonly config: GuildLevelingConfig;
  readonly clock: Clock;
  readonly rng: Rng;
  readonly collectAll: boolean;
  readonly trace: TraceStep[];
  readonly denials: DenyCode[];
}

const push = (ctx: Ctx, gate: string, verdict: Verdict, detail: string, data?: Record<string, unknown>) => {
  ctx.trace.push(data === undefined ? { gate, verdict, detail } : { gate, verdict, detail, data });
};

const deny = (ctx: Ctx, gate: string, code: DenyCode, detail: string, data?: Record<string, unknown>) => {
  push(ctx, gate, 'deny', detail, data);
  ctx.denials.push(code);
};

const skip = (ctx: Ctx, gate: string, detail = 'skipped — an earlier gate denied') => {
  push(ctx, gate, 'skip', detail);
};

/** True when evaluation should stop here. */
const halted = (ctx: Ctx): boolean => ctx.denials.length > 0 && !ctx.collectAll;

export function evaluateXp(
  candidate: XpCandidate,
  member: MemberContext,
  config: GuildLevelingConfig,
  clock: Clock,
  rng: Rng,
  options: EvaluateOptions = {},
): XpDecision {
  const ctx: Ctx = {
    candidate,
    member,
    config,
    clock,
    rng,
    collectAll: options.collectAll ?? false,
    trace: [],
    denials: [],
  };

  const now = clock.now();
  const source = config.sources[candidate.source];

  // ======================= ELIGIBILITY PHASE ===============================

  // 1. module_enabled
  if (config.enabled) {
    push(ctx, 'module_enabled', 'pass', 'leveling is enabled');
  } else {
    deny(ctx, 'module_enabled', 'module_disabled', 'leveling is disabled in this server');
  }

  // 2. source_enabled
  if (!halted(ctx)) {
    if (source?.enabled) {
      push(ctx, 'source_enabled', 'pass', `${candidate.source} XP is on`, {
        min: source.minXp,
        max: source.maxXp,
        cooldownSeconds: source.cooldownSeconds,
      });
    } else {
      deny(ctx, 'source_enabled', 'source_disabled', `${candidate.source} XP is disabled`);
    }
  } else skip(ctx, 'source_enabled');

  // 3. actor_is_human — NOT configurable. Spec `04` §7.1.
  if (!halted(ctx)) {
    if (member.isWebhook) {
      deny(ctx, 'actor_is_human', 'actor_is_webhook', 'webhook messages never earn XP');
    } else if (member.isBot) {
      deny(ctx, 'actor_is_human', 'actor_is_bot', 'bots never earn XP');
    } else if (member.isSelf) {
      deny(ctx, 'actor_is_human', 'actor_is_self', 'the bot does not earn XP from itself');
    } else {
      push(ctx, 'actor_is_human', 'pass', 'not a bot or webhook');
    }
  } else skip(ctx, 'actor_is_human');

  // 4. actor_eligible — ignore list plus the optional alt-account levers.
  if (!halted(ctx)) {
    const accountAgeDays =
      member.accountCreatedAt === undefined ? null : (now - member.accountCreatedAt) / 86_400_000;
    const memberAgeHours =
      member.joinedGuildAt === undefined ? null : (now - member.joinedGuildAt) / 3_600_000;

    if (member.isIgnored) {
      deny(ctx, 'actor_eligible', 'user_ignored', 'this member is on the ignore list');
    } else if (
      config.minAccountAgeDays > 0 &&
      accountAgeDays !== null &&
      accountAgeDays < config.minAccountAgeDays
    ) {
      deny(ctx, 'actor_eligible', 'account_too_new', `account is younger than ${config.minAccountAgeDays}d`);
    } else if (
      config.minMemberAgeHours > 0 &&
      memberAgeHours !== null &&
      memberAgeHours < config.minMemberAgeHours
    ) {
      deny(ctx, 'actor_eligible', 'member_too_new', `joined less than ${config.minMemberAgeHours}h ago`);
    } else {
      push(ctx, 'actor_eligible', 'pass', 'not ignored; account and member age OK');
    }
  } else skip(ctx, 'actor_eligible');

  // 5. role_denied — beats every booster (ADR-011).
  if (!halted(ctx)) {
    const deniedRole = findDeniedRole(member.roleIds, config.rules);
    if (deniedRole !== null) {
      deny(ctx, 'role_denied', 'role_denied', `holds role ${deniedRole}, which is a no-XP role`, {
        roleId: deniedRole,
      });
    } else {
      push(ctx, 'role_denied', 'pass', 'holds no no-XP role');
    }
  } else skip(ctx, 'role_denied');

  // 6. location_allowed
  if (!halted(ctx)) {
    const verdict = resolveLocation(candidate.location, config.rules, config.context);
    if (verdict.allowed) {
      push(ctx, 'location_allowed', 'pass', 'location permits XP');
    } else {
      deny(ctx, 'location_allowed', verdict.reason, verdict.detail);
    }
  } else skip(ctx, 'location_allowed');

  // 7. source_specific_gate
  if (!halted(ctx)) {
    const specific = evaluateSourceGate(ctx, now);
    if (specific) {
      deny(ctx, 'source_specific_gate', specific.code, specific.detail);
    } else {
      push(ctx, 'source_specific_gate', 'pass', 'source preconditions met');
    }
  } else skip(ctx, 'source_specific_gate');

  // 8. cooldown — a denial never consumes or refreshes it.
  if (!halted(ctx)) {
    const expiresAt = member.cooldownExpiresAt;
    if (expiresAt != null && expiresAt > now) {
      deny(ctx, 'cooldown', 'on_cooldown', `on cooldown for another ${Math.ceil((expiresAt - now) / 1000)}s`, {
        expiresAt,
        remainingMs: expiresAt - now,
      });
    } else {
      push(ctx, 'cooldown', 'pass', 'no active cooldown');
    }
  } else {
    const expiresAt = member.cooldownExpiresAt;
    const active = expiresAt != null && expiresAt > now;
    skip(
      ctx,
      'cooldown',
      active
        ? `skipped (would have DENIED: ${Math.ceil((expiresAt - now) / 1000)}s remaining)`
        : 'skipped (would have passed: no active cooldown)',
    );
  }

  // 9. max_level — by default caps the LEVEL, not the XP (decision C9).
  if (!halted(ctx)) {
    const cap = config.curve.maxLevel;
    if (cap !== null && member.currentLevel >= cap && config.curve.hardCapXp) {
      deny(ctx, 'max_level', 'max_level', `at max level ${cap} and hard XP cap is on`);
    } else if (cap !== null && member.currentLevel >= cap) {
      push(ctx, 'max_level', 'pass', `at max level ${cap}; XP still accrues for leaderboard order`);
    } else {
      push(ctx, 'max_level', 'pass', 'below max level');
    }
  } else skip(ctx, 'max_level');

  // ========================= AMOUNT PHASE ==================================

  const eligible = ctx.denials.length === 0;

  if (!eligible) {
    // Report what WOULD have happened — this is what makes the debug output
    // actionable rather than a dead end.
    const preview = eligible ? NEUTRAL_BPS : previewMultiplier(ctx, now);
    skip(ctx, 'base_xp_roll');
    skip(ctx, 'effort_bonus');
    skip(
      ctx,
      'multiplier_stack',
      preview === NEUTRAL_BPS
        ? 'skipped (no boosters would apply)'
        : `skipped (would have been x${(preview / NEUTRAL_BPS).toFixed(2)})`,
    );
    skip(ctx, 'clamp_and_round');
    skip(ctx, 'zero_check');

    return {
      outcome: 'denied',
      baseXp: 0,
      effortBonus: 0,
      multiplierBps: preview,
      finalXp: 0,
      denyReason: ctx.denials[0] ?? null,
      allDenyReasons: [...ctx.denials],
      consumesCooldown: false,
      trace: ctx.trace,
    };
  }

  // 10. base_xp_roll
  const baseXp = rollBaseXp(ctx);
  push(ctx, 'base_xp_roll', 'modify', `base roll: ${baseXp} XP`, { baseXp });

  // 11. effort_bonus (needs the MessageContent intent; zero without it)
  const effortBonus = computeEffortBonus(ctx);
  if (effortBonus > 0) {
    push(ctx, 'effort_bonus', 'modify', `effort bonus: +${effortBonus} XP`, { effortBonus });
  } else {
    push(ctx, 'effort_bonus', 'pass', 'no effort bonus');
  }

  // 12. multiplier_stack
  const booster = resolveMultiplier(
    config.rules,
    {
      roleIds: member.roleIds,
      userId: member.userId,
      source: candidate.source,
      location: candidate.location,
      now,
    },
    config.boosterStacking,
    config.maxMultiplierBps,
  );
  push(
    ctx,
    'multiplier_stack',
    'modify',
    `x${(booster.multiplierBps / NEUTRAL_BPS).toFixed(2)} from ${booster.applicable.length} booster(s), mode=${config.boosterStacking}`,
    {
      multiplierBps: booster.multiplierBps,
      applicable: booster.applicable,
      clamped: booster.clamped,
    },
  );

  // Anti-AFK is a PENALTY applied multiplicatively and separately, so a large
  // booster cannot cancel it out (spec `04` §8.5).
  let antiAfk = 1;
  if (candidate.source === 'voice' && candidate.sessionEligibleSeconds !== undefined) {
    antiAfk = antiAfkMultiplier(candidate.sessionEligibleSeconds, config.voice);
    if (antiAfk < 1) {
      push(ctx, 'anti_afk', 'modify', `anti-AFK decay x${antiAfk.toFixed(3)}`, { antiAfk });
    }
  }

  // 13. clamp_and_round — round ONCE, at the end (decision C8).
  const subtotal = baseXp + effortBonus;
  const cap = source?.perEventCap ?? Number.MAX_SAFE_INTEGER;
  const rawFinal = Math.round((subtotal * booster.multiplierBps * antiAfk) / NEUTRAL_BPS);
  const finalXp = Math.min(Math.max(rawFinal, 0), cap);
  push(ctx, 'clamp_and_round', 'modify', `final: ${finalXp} XP`, {
    subtotal,
    rawFinal,
    cap,
    finalXp,
  });

  // 14. zero_check — a zero award writes nothing and burns no cooldown.
  if (finalXp <= 0) {
    deny(ctx, 'zero_check', 'computed_zero', 'computed 0 XP; nothing awarded');
    return {
      outcome: 'denied',
      baseXp,
      effortBonus,
      multiplierBps: booster.multiplierBps,
      finalXp: 0,
      denyReason: 'computed_zero',
      allDenyReasons: ['computed_zero'],
      consumesCooldown: false,
      trace: ctx.trace,
    };
  }
  push(ctx, 'zero_check', 'pass', 'award is positive');

  return {
    outcome: 'awarded',
    baseXp,
    effortBonus,
    multiplierBps: booster.multiplierBps,
    finalXp,
    denyReason: null,
    allDenyReasons: [],
    consumesCooldown: true,
    trace: ctx.trace,
  };
}

// ---------------------------------------------------------------------------
// Gate 7 — per-source preconditions
// ---------------------------------------------------------------------------

function evaluateSourceGate(ctx: Ctx, _now: number): { code: DenyCode; detail: string } | null {
  const { candidate, config, member } = ctx;

  switch (candidate.source) {
    case 'message': {
      const min = config.context.minMessageLength;
      if (min > 0 && candidate.hasContent === true && (candidate.messageLength ?? 0) < min) {
        return { code: 'message_too_short', detail: `message shorter than ${min} characters` };
      }
      if (config.sources.message.messageMode === 'per_word' && candidate.hasContent === true) {
        const words = candidate.wordCount ?? 0;
        const whitespace = candidate.whitespaceRuns ?? 0;
        if (words <= whitespace) {
          return {
            code: 'per_word_padding',
            detail: 'per-word mode requires more words than whitespace runs',
          };
        }
      }
      return null;
    }

    case 'voice': {
      const eligibleSeconds = candidate.voiceEligibleSeconds ?? 0;
      if (eligibleSeconds <= 0) {
        return { code: 'voice_inactive', detail: 'no eligible voice time in this tick' };
      }
      return null;
    }

    case 'reaction_add':
    case 'reaction_receive': {
      if (candidate.alreadyCounted === true) {
        return {
          code: 'reaction_already_counted',
          detail: 'this reaction has already been counted',
        };
      }
      const self =
        candidate.reactorId !== undefined &&
        candidate.messageAuthorId !== undefined &&
        candidate.reactorId === candidate.messageAuthorId;
      if (self && !config.allowSelfReactions) {
        return { code: 'self_reaction', detail: 'self-reactions do not earn XP' };
      }
      void member;
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Gates 10-11 — amount computation
// ---------------------------------------------------------------------------

function rollBaseXp(ctx: Ctx): number {
  const { candidate, config, rng } = ctx;
  const source = config.sources[candidate.source];

  if (candidate.source === 'message' && source.messageMode === 'per_word' && candidate.hasContent === true) {
    const words = candidate.wordCount ?? 0;
    return Math.min(words * source.maxXp, source.perEventCap);
  }

  const rolled = rng.intBetween(source.minXp, source.maxXp);

  if (candidate.source === 'voice') {
    const fraction = tickEligibilityFraction(
      candidate.voiceEligibleSeconds ?? 0,
      candidate.voiceTickSeconds ?? config.voice.tickSeconds,
    );
    return Math.round(rolled * fraction);
  }

  return rolled;
}

function computeEffortBonus(ctx: Ctx): number {
  const { candidate, config } = ctx;
  if (!config.effort.enabled) return 0;
  if (candidate.source !== 'message') return 0;
  // Requires the MessageContent intent; without it we simply award no bonus.
  if (candidate.hasContent !== true) return 0;

  const lengthBonus = Math.min(
    Math.floor((candidate.messageLength ?? 0) / config.effort.charsPerXp),
    config.effort.lengthCap,
  );
  const attachmentBonus = (candidate.attachmentCount ?? 0) > 0 ? config.effort.attachmentXp : 0;

  return lengthBonus + attachmentBonus;
}

/** What the multiplier WOULD have been, for the debug trace on a denied event. */
function previewMultiplier(ctx: Ctx, now: number): number {
  return resolveMultiplier(
    ctx.config.rules,
    {
      roleIds: ctx.member.roleIds,
      userId: ctx.member.userId,
      source: ctx.candidate.source,
      location: ctx.candidate.location,
      now,
    },
    ctx.config.boosterStacking,
    ctx.config.maxMultiplierBps,
  ).multiplierBps;
}

// ---------------------------------------------------------------------------
// Level transition — computed from an atomic before/after pair (spec `06` §4)
// ---------------------------------------------------------------------------

export interface LevelTransition {
  readonly levelBefore: number;
  readonly levelAfter: number;
  readonly leveledUp: boolean;
  readonly leveledDown: boolean;
  /** Every level crossed, for reward resolution. Announcement uses the last. */
  readonly levelsCrossed: readonly number[];
}

export function computeLevelTransition(
  totalXpBefore: number,
  totalXpAfter: number,
  config: GuildLevelingConfig,
): LevelTransition {
  const curve = getCurve(config.curve);
  const levelBefore = curve.levelFromTotalXp(totalXpBefore);
  const levelAfter = curve.levelFromTotalXp(totalXpAfter);

  const crossed: number[] = [];
  if (levelAfter > levelBefore) {
    for (let l = levelBefore + 1; l <= levelAfter; l++) crossed.push(l);
  }

  return {
    levelBefore,
    levelAfter,
    leveledUp: levelAfter > levelBefore,
    leveledDown: levelAfter < levelBefore,
    levelsCrossed: crossed,
  };
}
