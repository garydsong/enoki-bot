/**
 * PORT: voice session persistence (spec `04` §8.2).
 *
 * Sessions are the only state this system keeps that a crash can lose, so the
 * shape of this interface is driven by recovery rather than by convenience:
 * every mutation is expressible as "advance the watermark", and every query the
 * reconciler needs is answerable in one round trip.
 */

export interface VoiceSession {
  readonly id: string;
  readonly guildId: string;
  readonly userId: string;
  readonly channelId: string;
  readonly startedAt: Date;
  readonly lastCreditedAt: Date;
  readonly accruedEligibleSeconds: number;
  readonly creditedXp: number;
  readonly isEligible: boolean;
  readonly ineligibleSince: Date | null;
  readonly lastHeartbeatAt: Date;
  readonly endedAt: Date | null;
}

export interface OpenSessionInput {
  readonly guildId: string;
  readonly userId: string;
  readonly channelId: string;
  readonly eligible: boolean;
}

/** What a tick credited, so the caller can award and report it. */
export interface CreditedInterval {
  readonly session: VoiceSession;
  readonly eligibleSeconds: number;
}

export interface VoiceSessionRepository {
  /**
   * Open a session, or return the existing one. Relies on the partial unique
   * index rather than a check-then-insert, which is the race a rapid
   * leave/join actually produces.
   */
  open(input: OpenSessionInput): Promise<VoiceSession>;
  find(guildId: string, userId: string): Promise<VoiceSession | null>;
  openInChannel(guildId: string, channelId: string): Promise<VoiceSession[]>;
  openInGuild(guildId: string): Promise<VoiceSession[]>;
  allOpen(): Promise<VoiceSession[]>;

  /** Move without closing, so anti-AFK aging survives channel hopping. */
  moveTo(sessionId: string, channelId: string): Promise<void>;

  /**
   * Take the un-credited eligible interval and advance the watermark, in one
   * statement. Returns null when nothing was owed, so the caller does no work.
   */
  claimInterval(sessionId: string, maxSeconds?: number): Promise<CreditedInterval | null>;

  setEligibility(sessionId: string, eligible: boolean): Promise<void>;
  /**
   * Resume a session after downtime: correct the channel and eligibility, and
   * move the watermark to NOW so the outage is never credited. Distinct from
   * `setEligibility` because the watermark reset is unconditional here — an
   * already-eligible session must forget the gap too.
   */
  resume(sessionId: string, channelId: string, eligible: boolean): Promise<void>;
  recordAward(sessionId: string, xp: number): Promise<void>;
  heartbeat(sessionIds: readonly string[]): Promise<void>;
  close(sessionId: string, endedAt?: Date): Promise<void>;
  /** Close everything whose heartbeat stopped — the crash residue. */
  closeOrphans(olderThanMs: number): Promise<number>;
  countOpen(): Promise<number>;
}
