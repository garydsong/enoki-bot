/**
 * Cooldown storage (ADR-008).
 *
 * In process memory, not the database. A lost cooldown costs at most one extra
 * XP grant (~20 XP); persisting it would double the write volume on the hottest
 * path in the system for data that is worthless in sixty seconds.
 *
 * THE CRITICAL PROPERTY IS ATOMIC CHECK-AND-SET. Two messages from one member
 * in the same millisecond must not both pass. With a Map this is free *provided
 * no `await` sits between the read and the write* — Node is single-threaded per
 * event-loop turn, so a fully synchronous tryConsume cannot be interleaved.
 * That is why this returns synchronously and why the caller must consume the
 * cooldown BEFORE any asynchronous persistence.
 *
 * The interface is shaped for Redis (`SET key val NX PX ttl` is the same
 * operation) so the swap is a composition-root change when a second process
 * appears.
 */

import type { CooldownStore } from '../../ports/cooldowns.js';

export type { CooldownOutcome, CooldownStore } from '../../ports/cooldowns.js';
export { cooldownKey } from '../../ports/cooldowns.js';

export interface CooldownStoreOptions {
  readonly now?: () => number;
  readonly maxEntries?: number;
  /** How often to evict expired keys. Set 0 to disable (tests). */
  readonly sweepIntervalMs?: number;
}

export function createCooldownStore(options: CooldownStoreOptions = {}): CooldownStore & {
  sweep(): number;
  stopSweeping(): void;
} {
  const now = options.now ?? (() => Date.now());
  const maxEntries = options.maxEntries ?? 200_000;
  const expiries = new Map<string, number>();

  const sweep = (): number => {
    const t = now();
    let removed = 0;
    for (const [key, expiresAt] of expiries) {
      if (expiresAt <= t) {
        expiries.delete(key);
        removed++;
      }
    }
    return removed;
  };

  let timer: NodeJS.Timeout | null = null;
  const interval = options.sweepIntervalMs ?? 60_000;
  if (interval > 0) {
    timer = setInterval(sweep, interval);
    timer.unref();
  }

  return {
    // SYNCHRONOUS BY DESIGN — see the module comment. Making this async would
    // reintroduce the check-and-set race it exists to prevent.
    tryConsume(key, ttlMs) {
      const t = now();
      const expiresAt = expiries.get(key);

      if (expiresAt !== undefined && expiresAt > t) {
        return { consumed: false, remainingMs: expiresAt - t, expiresAt };
      }

      if (ttlMs > 0) {
        expiries.set(key, t + ttlMs);
        // Memory guard: evict the oldest insertion rather than growing forever.
        if (expiries.size > maxEntries) {
          const oldest = expiries.keys().next().value;
          if (oldest !== undefined) expiries.delete(oldest);
        }
      }
      return { consumed: true };
    },

    peek(key) {
      const expiresAt = expiries.get(key);
      return expiresAt !== undefined && expiresAt > now() ? expiresAt : null;
    },

    clear(key) {
      expiries.delete(key);
    },

    clearAll() {
      expiries.clear();
    },

    get size() {
      return expiries.size;
    },

    sweep,

    stopSweeping() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
