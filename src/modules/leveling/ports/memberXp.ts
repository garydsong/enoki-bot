import type { Queryable } from '../../../platform/db/pool.js';

/**
 * PORT: member XP persistence.
 *
 * The interface lives here, apart from the Postgres implementation, because
 * `application/` and `adapters/` are forbidden from importing `infrastructure/`
 * (enforced by ESLint, spec `07` §1.2). That is not ceremony: it is what makes
 * the award use case testable with a fake, and what would let a different store
 * be dropped in without touching a single caller.
 *
 * `Queryable` is the one concession — a transaction handle has to cross this
 * boundary for the "XP, statistics and period buckets commit together" property
 * to be expressible at all.
 */

export interface XpMutationResult {
  readonly totalXpBefore: number;
  readonly totalXpAfter: number;
  /** What actually changed, after clamping at zero. */
  readonly appliedDelta: number;
  readonly isNewMember: boolean;
}

export interface MemberIdentity {
  readonly displayName?: string | null;
  readonly avatarHash?: string | null;
}

export interface MemberXpRow {
  readonly guildId: string;
  readonly userId: string;
  readonly totalXp: number;
  readonly level: number;
  readonly displayName: string | null;
  readonly avatarHash: string | null;
  readonly isDeparted: boolean;
  readonly lastXpAt: Date | null;
}

export interface StatDelta {
  readonly messagesCounted?: number;
  readonly voiceSeconds?: number;
  readonly reactionsGiven?: number;
  readonly reactionsReceived?: number;
  readonly levelups?: number;
}

export type PeriodBucket = 'week' | 'month';

export interface MemberXpRepository {
  /**
   * Atomically add `delta` (which may be negative) and report before/after.
   * Never goes below zero. `level` is supplied by the caller because the curve
   * lives in guild configuration, not in SQL.
   */
  addXp(
    tx: Queryable,
    guildId: string,
    userId: string,
    delta: number,
    levelFor: (totalXp: number) => number,
    identity?: MemberIdentity,
  ): Promise<XpMutationResult>;

  /** Set an absolute total (backs `/xp set`). Also reports before/after. */
  setTotalXp(
    tx: Queryable,
    guildId: string,
    userId: string,
    totalXp: number,
    levelFor: (totalXp: number) => number,
  ): Promise<XpMutationResult>;

  get(guildId: string, userId: string): Promise<MemberXpRow | null>;
  /** Rank among members with XP. 1-based. Null when the member has no XP. */
  rankOf(guildId: string, userId: string): Promise<number | null>;
  countRanked(guildId: string): Promise<number>;
  markDeparted(guildId: string, userId: string, departed: boolean): Promise<void>;
  reset(guildId: string, userId: string): Promise<void>;
  resetGuild(guildId: string): Promise<number>;
  /** Recompute the denormalised level column after a curve change. */
  relevelGuild(guildId: string, levelFor: (totalXp: number) => number): Promise<number>;

  /** Activity counters. Same transaction as the XP, so they cannot disagree. */
  bumpStats(tx: Queryable, guildId: string, userId: string, delta: StatDelta): Promise<void>;

  /**
   * Add to a period bucket. The "reset" is the caller passing a different
   * `periodStart` once the clock crosses the boundary — no job, no deletion.
   */
  bumpPeriodXp(
    tx: Queryable,
    guildId: string,
    userId: string,
    periodType: PeriodBucket,
    periodStart: Date,
    xp: number,
  ): Promise<void>;
}
