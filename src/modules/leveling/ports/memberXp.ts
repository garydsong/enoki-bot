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

export interface BulkXpEntry {
  readonly userId: string;
  readonly xp: number;
}

/**
 * What a `forget` actually deleted.
 *
 * Per-table rather than a single total because "we deleted your data" is a
 * claim, and a member exercising a deletion right deserves to see it itemised.
 */
export interface ForgetResult {
  readonly xpRows: number;
  readonly statRows: number;
  readonly periodRows: number;
  readonly cardRows: number;
  readonly voiceRows: number;
  /** The total XP that was erased, for the audit entry. */
  readonly totalXpErased: number;
}

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

  /**
   * Write many members' totals in ONE round trip (backs `/xp import`).
   *
   * `mode: 'set'` replaces the total, `'add'` adds to it. Levels are computed
   * by the caller and passed alongside, because the curve lives in guild
   * configuration rather than in SQL.
   *
   * Takes a transaction handle rather than opening its own, so a caller can put
   * a whole batch in one transaction and have a bad row roll the batch back.
   */
  bulkUpsertXp(
    tx: Queryable,
    guildId: string,
    entries: readonly BulkXpEntry[],
    mode: 'set' | 'add',
    levelFor: (totalXp: number) => number,
  ): Promise<number>;

  get(guildId: string, userId: string): Promise<MemberXpRow | null>;
  /** Every member with a row, oldest id first, for keyset pagination. */
  pageMembers(
    guildId: string,
    options: { readonly afterUserId?: string | null; readonly limit: number; readonly includeDeparted: boolean },
  ): Promise<MemberXpRow[]>;
  /** Rank among members with XP. 1-based. Null when the member has no XP. */
  rankOf(guildId: string, userId: string): Promise<number | null>;
  countRanked(guildId: string): Promise<number>;
  markDeparted(guildId: string, userId: string, departed: boolean): Promise<void>;
  reset(guildId: string, userId: string): Promise<void>;
  resetGuild(guildId: string): Promise<number>;
  /**
   * ERASE a member: XP, statistics, period buckets, card settings and voice
   * sessions, all of it, in one transaction. Backs `/xp forget` and
   * `auto_reset_on_leave`.
   *
   * Distinct from `reset`, which zeroes the score and KEEPS the record. This is
   * the deletion path, and it returns per-table counts so the caller can tell
   * the member exactly what was removed rather than "done".
   */
  forget(guildId: string, userId: string): Promise<ForgetResult>;
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
