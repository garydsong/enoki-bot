import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '../../../src/platform/db/pool.js';
import type { Logger } from '../../../src/platform/logging/logger.js';

/**
 * Integration test harness.
 *
 * Each test gets its OWN database, created and dropped around it. That is
 * slower than truncating tables, and worth it: migration tests need a genuinely
 * empty database, and shared state between tests is how integration suites
 * become flaky and then ignored.
 *
 * Set TEST_DATABASE_URL to point at any Postgres. `docker compose up -d postgres`
 * then `postgres://enoki:enoki@localhost:5432/enoki` works locally.
 */

export const ADMIN_DSN =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres@127.0.0.1:5432/postgres';

export const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => silentLogger,
} as unknown as Logger;

function dsnFor(dbName: string): string {
  const url = new URL(ADMIN_DSN);
  url.pathname = `/${dbName}`;
  return url.toString();
}

export interface TempDatabase {
  readonly db: Database;
  readonly name: string;
  readonly dsn: string;
  drop(): Promise<void>;
}

export async function createTempDatabase(): Promise<TempDatabase> {
  const name = `enoki_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  const admin = new pg.Client({ connectionString: ADMIN_DSN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const dsn = dsnFor(name);
  const db = createDatabase({ connectionString: dsn, log: silentLogger });

  return {
    db,
    name,
    dsn,
    async drop() {
      await db.close();
      const cleanup = new pg.Client({ connectionString: ADMIN_DSN });
      await cleanup.connect();
      await cleanup.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
        [name],
      );
      await cleanup.query(`DROP DATABASE IF EXISTS ${name}`);
      await cleanup.end();
    },
  };
}

/** True when a Postgres is reachable, so suites can skip rather than fail. */
export async function postgresAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: ADMIN_DSN, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}
