/**
 * PORT: cooldown storage (ADR-008).
 *
 * THE CRITICAL PROPERTY IS THAT `tryConsume` IS SYNCHRONOUS. It is a
 * check-and-set, and with a Map that is atomic only while no `await` sits
 * between the read and the write. Making this method async — for a Redis
 * implementation, say — would reintroduce the race it exists to prevent, so a
 * Redis version must use a single round-trip primitive (`SET key val NX PX`)
 * behind a different, explicitly async port rather than widening this one.
 */

export type CooldownOutcome =
  | { readonly consumed: true }
  | { readonly consumed: false; readonly remainingMs: number; readonly expiresAt: number };

export interface CooldownStore {
  /** Atomically: if not on cooldown, start one and report success. */
  tryConsume(key: string, ttlMs: number): CooldownOutcome;
  /** Read without consuming — for `/level debug why`, which must not mutate. */
  peek(key: string): number | null;
  clear(key: string): void;
  clearAll(): void;
  readonly size: number;
}

/** Cooldowns are per (guild, member, source) — one source never blocks another. */
export function cooldownKey(guildId: string, userId: string, source: string): string {
  return `${guildId}:${userId}:${source}`;
}
