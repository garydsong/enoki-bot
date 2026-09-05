import type { ConfigCache, ConfigRepository } from '../../ports/config.js';
import type { GuildLevelingConfig } from '../../domain/types.js';

export type { ConfigCache } from '../../ports/config.js';

/**
 * In-process guild configuration cache (ADR-009).
 *
 * The hot path reads the whole config on every message. At 50 guilds the entire
 * cacheable set is a few dozen objects — a Map is not merely adequate here, it
 * is BETTER than Redis: no serialisation, no network hop, and no invalidation
 * race, because with one process there is exactly one source of truth.
 *
 * Invalidation is a version comparison rather than a protocol: every config
 * write bumps `config_version`, and `invalidate()` is called on the same path.
 * The periodic revalidation exists only as a safety net for a version bumped by
 * something that forgot to call it (a manual SQL edit, a future second process).
 *
 * Redis becomes necessary the moment a SECOND PROCESS exists — that is the
 * documented trigger, not guild count.
 */

export interface ConfigCacheOptions {
  readonly repository: ConfigRepository;
  /** How long before a cached entry is re-checked against the database. */
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

interface Entry {
  readonly config: GuildLevelingConfig;
  readonly version: number;
  loadedAt: number;
}

export function createConfigCache(options: ConfigCacheOptions): ConfigCache {
  const ttlMs = options.ttlMs ?? 600_000;
  const maxEntries = options.maxEntries ?? 1000;
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, Entry>();
  const stats = { hits: 0, misses: 0, revalidations: 0 };

  const load = async (guildId: string): Promise<GuildLevelingConfig> => {
    const loaded = await options.repository.load(guildId);
    entries.delete(guildId); // re-insert to refresh LRU position
    entries.set(guildId, { config: loaded.config, version: loaded.version, loadedAt: now() });

    // Bounded, so a bot in many guilds cannot grow this without limit.
    if (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
    return loaded.config;
  };

  return {
    stats,

    async get(guildId) {
      const cached = entries.get(guildId);

      if (!cached) {
        stats.misses++;
        return load(guildId);
      }

      if (now() - cached.loadedAt < ttlMs) {
        stats.hits++;
        return cached.config;
      }

      // Past the TTL: one cheap version read rather than a full reload. An
      // unchanged config is the overwhelmingly common case.
      stats.revalidations++;
      const version = await options.repository.version(guildId);
      if (version === cached.version) {
        cached.loadedAt = now();
        return cached.config;
      }
      return load(guildId);
    },

    invalidate(guildId) {
      entries.delete(guildId);
    },

    clear() {
      entries.clear();
    },
  };
}
