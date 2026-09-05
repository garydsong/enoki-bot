import pg from 'pg';
import type { Logger } from '../logging/logger.js';

const { Pool } = pg;

/**
 * Postgres access (ADR-012, Accepted).
 *
 * Two rules this module exists to enforce:
 *
 * 1. **A transaction never wraps a Discord API call.** `withTransaction` takes a
 *    callback that receives a client; if that callback awaits the network, the
 *    connection is held hostage and the pool starves. Side effects run AFTER
 *    commit, from the event bus (spec `07` §1.4).
 *
 * 2. **Snowflakes are BIGINT in the schema and strings in the application**
 *    (decision A9). node-postgres returns int8 as a string by default, which is
 *    exactly what we want — so we explicitly do NOT install a parser that would
 *    turn them into lossy JS numbers. A Discord snowflake exceeds
 *    Number.MAX_SAFE_INTEGER, so parsing them as numbers silently corrupts IDs.
 *    Counts and XP totals are parsed explicitly at their call sites instead.
 */

export type QueryParam =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  // Postgres array parameters (e.g. `unnest($1::bigint[])`), used for bulk
  // updates that would otherwise be one round trip per row.
  | readonly string[]
  | readonly number[];

export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: readonly QueryParam[],
  ): Promise<pg.QueryResult<R>>;
}

export interface Database extends Queryable {
  withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
  readonly pool: pg.Pool;
}

export interface DatabaseOptions {
  readonly connectionString: string;
  readonly log: Logger;
  readonly maxConnections?: number;
  /** Fail a connection attempt rather than queueing forever. */
  readonly connectionTimeoutMs?: number;
}

interface ErrorLike {
  readonly code?: string;
  readonly message?: string;
  readonly errors?: readonly unknown[];
}

/** One short line describing why a connection failed. */
function describeConnectionError(error: unknown): string {
  const e = error as ErrorLike;
  const code =
    e?.code ??
    (Array.isArray(e?.errors) ? (e.errors[0] as ErrorLike | undefined)?.code : undefined);

  switch (code) {
    case 'ECONNREFUSED':
      return 'ECONNREFUSED — nothing is listening on that host and port';
    case 'ENOTFOUND':
      return 'ENOTFOUND — the database host name does not resolve';
    case 'ETIMEDOUT':
      return 'ETIMEDOUT — the host is unreachable or a firewall is dropping the connection';
    case '28P01':
      return '28P01 — password authentication failed';
    case '3D000':
      return '3D000 — that database does not exist on the server';
    default:
      return code ? `${code}` : (e?.message ?? 'unknown error');
  }
}

export function createDatabase(options: DatabaseOptions): Database {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
    idleTimeoutMillis: 30_000,
    application_name: 'enoki',
  });

  // A pool-level error is an idle client dying (network blip, server restart).
  // It must be handled or Node treats it as an unhandled 'error' event and
  // crashes the process — turning a recoverable blip into an outage (NFR-11).
  pool.on('error', (err) => {
    options.log.error({ err }, 'idle postgres client error');
  });

  let closed = false;

  const db: Database = {
    pool,

    async query(text, params) {
      return pool.query(text, params as unknown[]);
    },

    async withTransaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: (text, params) => client.query(text, params as unknown[]),
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          options.log.error({ err: rollbackError }, 'rollback failed');
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async ping() {
      try {
        await pool.query('SELECT 1');
        return true;
      } catch (error) {
        // Log the CAUSE, not the whole AggregateError. A refused connection
        // produces one sub-error per resolved address (::1 and 127.0.0.1), each
        // with its own stack — forty lines of noise that bury the one useful
        // word. /readyz calls this on a timer, so verbosity here is expensive.
        options.log.warn({ reason: describeConnectionError(error) }, 'database ping failed');
        return false;
      }
    },

    // Idempotent on purpose: pg throws "Called end on pool more than once".
    // Shutdown can be reached from more than one path (SIGTERM, a boot failure
    // after the pool exists, a test helper), and a second close must be a
    // no-op rather than an exception thrown during shutdown.
    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };

  return db;
}
