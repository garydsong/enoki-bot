import type { Database } from '../db/pool.js';

/**
 * Tiny key/value store for platform bookkeeping that does not deserve a table.
 *
 * Currently one user: the registered command-set hash, so a restart does not
 * re-upload an unchanged command set and burn the 200/day global command
 * rate bucket (see commands/registrar.ts).
 *
 * Deliberately NOT a general-purpose config store — guild configuration is a
 * wide typed row (spec `06` §2.2), for reasons documented there.
 */
export interface KvRepository {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export function createKvRepository(db: Database): KvRepository {
  return {
    async get(key) {
      const { rows } = await db.query<{ value: string }>(
        'SELECT value FROM platform_kv WHERE key = $1',
        [key],
      );
      return rows[0]?.value ?? null;
    },
    async set(key, value) {
      await db.query(
        `INSERT INTO platform_kv (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, value],
      );
    },
  };
}
