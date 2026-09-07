/**
 * PORT: durable reaction dedup (spec `04` §7.2, ADR-010).
 *
 * The one piece of idempotency in this system that is PERSISTED rather than
 * held in memory. Message and voice dedup guard against a redelivered gateway
 * event, where the cost of being wrong is one extra award; reaction dedup
 * guards against a person clicking the same reaction off and on, where the cost
 * of being wrong is unlimited XP.
 */

export interface ReactionKey {
  readonly guildId: string;
  readonly messageId: string;
  readonly reactorId: string;
  /** Unicode sequence, or `name:id` for a custom emoji. */
  readonly emoji: string;
}

export interface ReactionAwardRepository {
  /**
   * Claim a reaction. Returns false when it has been awarded before — EVER.
   *
   * A single INSERT ... ON CONFLICT DO NOTHING, because a check-then-insert
   * loses exactly the race that matters here: the same person double-clicking,
   * or two shards delivering the same event.
   */
  claim(key: ReactionKey, messageAuthorId: string | null): Promise<boolean>;
  /** Distinct reactors already credited on this message. Backs the cap. */
  countReactors(guildId: string, messageId: string): Promise<number>;
  /** Test/administrative helper. */
  forget(key: ReactionKey): Promise<void>;
}
