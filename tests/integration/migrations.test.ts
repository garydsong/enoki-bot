import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checksumOf,
  loadMigrations,
  MigrationError,
  runMigrations,
} from '../../src/platform/db/migrator.js';
import { createTempDatabase, postgresAvailable, silentLogger, type TempDatabase } from './helpers/db.js';

const CORE = join(import.meta.dirname, '..', '..', 'migrations');

let available = false;
beforeAll(async () => {
  available = await postgresAvailable();
  if (!available) {
    console.warn('\n  Postgres unreachable — integration tests skipped.\n  Run: docker compose up -d postgres\n');
  }
});

let temp: TempDatabase | null = null;
afterEach(async () => {
  await temp?.drop();
  temp = null;
});

const withDb = async (): Promise<TempDatabase> => {
  temp = await createTempDatabase();
  return temp;
};

describe.runIf(await postgresAvailable())('migrations', () => {
  it('runs up from a completely empty database', async () => {
    const { db } = await withDb();
    const result = await runMigrations(db, [CORE], silentLogger);

    expect(result.applied.length).toBeGreaterThan(0);
    expect(result.skipped).toEqual([]);

    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const tables = rows.map((r) => r.table_name);
    expect(tables).toContain('guild');
    expect(tables).toContain('job_run');
    expect(tables).toContain('platform_kv');
    expect(tables).toContain('schema_migrations');
  });

  it('is idempotent — a second run applies nothing', async () => {
    const { db } = await withDb();
    const first = await runMigrations(db, [CORE], silentLogger);
    const second = await runMigrations(db, [CORE], silentLogger);

    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(first.applied);
  });

  it('records a checksum and refuses a migration edited after the fact', async () => {
    const { db } = await withDb();
    const dir = await mkdtemp(join(tmpdir(), 'enoki-mig-'));
    await writeFile(join(dir, '0001_thing.sql'), 'CREATE TABLE thing (id int);');

    await runMigrations(db, [dir], silentLogger);

    // Someone edits an already-applied migration — every other environment
    // still has the old version, so this is virtually always a mistake.
    await writeFile(join(dir, '0001_thing.sql'), 'CREATE TABLE thing (id bigint);');

    await expect(runMigrations(db, [dir], silentLogger)).rejects.toThrow(MigrationError);
    await expect(runMigrations(db, [dir], silentLogger)).rejects.toThrow(/has changed since/);
  });

  it('rolls back a failing migration entirely, leaving no partial schema', async () => {
    const { db } = await withDb();
    const dir = await mkdtemp(join(tmpdir(), 'enoki-mig-'));
    await writeFile(
      join(dir, '0001_broken.sql'),
      'CREATE TABLE good (id int); CREATE TABLE bad (id nonsense_type);',
    );

    await expect(runMigrations(db, [dir], silentLogger)).rejects.toThrow(MigrationError);

    // The first statement must NOT have survived — a half-applied migration
    // leaves the schema in a state no migration describes.
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'good'`,
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('does not record a failed migration as applied', async () => {
    const { db } = await withDb();
    const dir = await mkdtemp(join(tmpdir(), 'enoki-mig-'));
    await writeFile(join(dir, '0001_broken.sql'), 'THIS IS NOT SQL;');

    await expect(runMigrations(db, [dir], silentLogger)).rejects.toThrow();

    const { rows } = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM schema_migrations',
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('merges module-owned migration directories without id collisions', async () => {
    const { db } = await withDb();
    const base = await mkdtemp(join(tmpdir(), 'enoki-mods-'));
    const modA = join(base, 'alpha');
    const modB = join(base, 'beta');
    await mkdir(modA);
    await mkdir(modB);
    // Both modules number their first migration 0001 — namespacing must keep
    // them distinct, or the second module's schema silently never applies.
    await writeFile(join(modA, '0001_init.sql'), 'CREATE TABLE alpha_thing (id int);');
    await writeFile(join(modB, '0001_init.sql'), 'CREATE TABLE beta_thing (id int);');

    const result = await runMigrations(db, [modA, modB], silentLogger);
    expect(result.applied).toHaveLength(2);
    expect(new Set(result.applied).size).toBe(2);

    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`,
    );
    const tables = rows.map((r) => r.table_name);
    expect(tables).toContain('alpha_thing');
    expect(tables).toContain('beta_thing');
  });

  it('tolerates a module declaring a migrations dir that does not exist yet', async () => {
    const { db } = await withDb();
    await expect(
      runMigrations(db, [CORE, '/nonexistent/module/migrations'], silentLogger),
    ).resolves.toBeDefined();
  });
});

describe('migration file naming', () => {
  it('rejects a file that is not NNNN_snake_case.sql', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'enoki-bad-'));
    await writeFile(join(dir, 'add-stuff.sql'), 'SELECT 1;');
    await expect(loadMigrations([dir])).rejects.toThrow(MigrationError);
  });

  it('loads and orders well-named files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'enoki-ok-'));
    await writeFile(join(dir, '0002_second.sql'), 'SELECT 2;');
    await writeFile(join(dir, '0001_first.sql'), 'SELECT 1;');
    const files = await loadMigrations([dir]);
    expect(files.map((f) => f.id.split(':')[1])).toEqual(['0001_first.sql', '0002_second.sql']);
  });

  /**
   * Git for Windows checks out CRLF by default. If the checksum were
   * byte-literal, migrating from a Windows dev shell and then starting the
   * Linux container against that same database would report every migration as
   * "changed since it was applied" and abort boot. The checksum is therefore
   * over normalised CONTENT, not bytes.
   */
  it('is line-ending agnostic, so a Windows checkout matches a Linux one', () => {
    const lf = 'CREATE TABLE x (id int);\nCREATE INDEX y ON x (id);\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(checksumOf(crlf)).toBe(checksumOf(lf));
  });

  it('ignores a trailing-newline difference, which is not a schema change', () => {
    expect(checksumOf('SELECT 1;\n')).toBe(checksumOf('SELECT 1;\n\n\n'));
  });

  it('still detects a real content change', () => {
    expect(checksumOf('SELECT 1;')).not.toBe(checksumOf('SELECT 2;'));
  });

  it('produces a stable checksum for identical content', async () => {
    const a = await mkdtemp(join(tmpdir(), 'enoki-a-'));
    const b = await mkdtemp(join(tmpdir(), 'enoki-b-'));
    await writeFile(join(a, '0001_x.sql'), 'SELECT 1;');
    await writeFile(join(b, '0001_x.sql'), 'SELECT 1;');
    const [fa] = await loadMigrations([a]);
    const [fb] = await loadMigrations([b]);
    expect(fa!.checksum).toBe(fb!.checksum);
  });
});

/** A throwaway migrations directory containing one file. */
async function makeMigrationDir(name: string, sql: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'enoki-ns-'));
  const inner = join(dir, 'migrations');
  await mkdir(inner);
  await writeFile(join(inner, name), sql);
  return inner;
}

describe.runIf(await postgresAvailable())('namespacing by owner', () => {
  it('applies two modules’ 0001_ migrations independently', async () => {
    // THE REGRESSION THIS EXISTS FOR: with a path-derived namespace both files
    // become `core:0001_init.sql`, the second is treated as already applied,
    // and the bot runs against a table that was never created.
    temp = await createTempDatabase();
    const a = await makeMigrationDir('0001_init.sql', 'CREATE TABLE alpha (id INT);');
    const b = await makeMigrationDir('0001_init.sql', 'CREATE TABLE beta (id INT);');

    const result = await runMigrations(
      temp.db,
      [
        { namespace: 'alpha', dir: a },
        { namespace: 'beta', dir: b },
      ],
      silentLogger,
    );

    expect(result.applied).toEqual(['alpha:0001_init.sql', 'beta:0001_init.sql']);
    const { rows } = await temp.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('alpha', 'beta')`,
    );
    expect(rows[0]?.count).toBe('2');
  });

  it('refuses two sources sharing a namespace rather than skipping one', async () => {
    temp = await createTempDatabase();
    const a = await makeMigrationDir('0001_init.sql', 'CREATE TABLE alpha (id INT);');
    const b = await makeMigrationDir('0001_init.sql', 'CREATE TABLE beta (id INT);');

    await expect(
      runMigrations(
        temp.db,
        [
          { namespace: 'same', dir: a },
          { namespace: 'same', dir: b },
        ],
        silentLogger,
      ),
    ).rejects.toThrow(/duplicate migration id/);
  });
});
