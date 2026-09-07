import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Database } from './pool.js';
import type { Logger } from '../logging/logger.js';

/**
 * Forward-only migration runner (spec NFR-38, NFR-39).
 *
 * Deliberately small and deliberately dumb: numbered `.sql` files, applied in
 * order, recorded in `schema_migrations`, never re-applied. No down-migrations —
 * a down-migration that drops a column loses XP, so destructive changes get a
 * documented manual rollback plan instead of an automated one that will
 * eventually be run by accident at 2am.
 *
 * Two properties that matter:
 *
 * - **Runs before the gateway connects, and aborts boot on failure.** A bot that
 *   starts against a mismatched schema writes corrupt data quietly. Failing to
 *   start is loud and harmless by comparison.
 * - **Each migration runs inside a transaction**, so a partially-applied file
 *   cannot leave the schema in a state no migration describes.
 *
 * A checksum is stored per migration. Editing an already-applied file is almost
 * always a mistake (every other environment has the old version), so it is
 * detected and refused rather than silently ignored.
 */

export class MigrationError extends Error {}

/**
 * Where a set of migrations comes from, and WHO OWNS IT.
 *
 * The namespace must be the owning module's name, not the directory's name.
 * Every module's migrations live in a folder called `migrations`, so deriving
 * the namespace from the path gives every module the same one — and the second
 * module to ship a `0001_init.sql` would find its migration already recorded
 * and silently skipped, leaving the bot running against a schema that does not
 * exist. Passing a bare string keeps the legacy behaviour for tests and
 * single-source callers.
 */
export type MigrationSource = string | { readonly namespace: string; readonly dir: string };

function normaliseSource(source: MigrationSource): { namespace: string; dir: string } {
  if (typeof source !== 'string') return source;
  const name = basename(source);
  return { namespace: name === 'migrations' ? 'core' : name, dir: source };
}

export interface MigrationFile {
  readonly id: string;
  readonly source: string;
  readonly sql: string;
  readonly checksum: string;
}

const MIGRATION_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;

/**
 * Checksum of a migration's CONTENT, not its bytes.
 *
 * Line endings are normalised first, and this is not a stylistic nicety — it is
 * a correctness requirement. Git for Windows checks out CRLF by default, so the
 * same committed file hashes differently on a Windows dev machine and inside the
 * Linux container. Without normalisation: migrate from Windows, then start the
 * Docker image against that same database, and every migration reports
 * "has changed since it was applied" and boot aborts.
 *
 * A trailing-newline difference is likewise not a schema change.
 */
export function checksumOf(sql: string): string {
  const normalised = sql.replace(/\r\n/g, '\n').replace(/\s+$/, '\n');
  return createHash('sha256').update(normalised).digest('hex').slice(0, 16);
}

const BOOTSTRAP = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id          TEXT PRIMARY KEY,
    source      TEXT NOT NULL,
    checksum    TEXT NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

export async function loadMigrations(
  sources: readonly MigrationSource[],
): Promise<MigrationFile[]> {
  const files: MigrationFile[] = [];

  for (const source of sources) {
    const { namespace, dir } = normaliseSource(source);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (error) {
      // A DECLARED-BUT-MISSING directory is a build problem, not an empty
      // module, and swallowing it is how a production image ends up running
      // with half a schema: `tsc` does not copy .sql files, so a build that
      // forgets to would silently apply no module migrations at all and then
      // fail every query with "relation does not exist".
      //
      // An EMPTY directory is still fine — that is the "no migrations yet" case.
      throw new MigrationError(
        `migrations directory not found: ${dir}\n` +
          `Namespace "${namespace}" declared it, but nothing is there. ` +
          `In a built image this usually means the .sql files were not copied ` +
          `into dist/ — check that \`npm run build\` ran scripts/copy-assets.mjs. ` +
          `(${error instanceof Error ? error.message : String(error)})`,
      );
    }

    for (const entry of entries.filter((e) => e.endsWith('.sql')).sort()) {
      if (!MIGRATION_PATTERN.test(entry)) {
        throw new MigrationError(
          `migration "${entry}" in ${dir} must be named NNNN_snake_case.sql`,
        );
      }
      const sql = await readFile(join(dir, entry), 'utf8');
      files.push({
        // Namespaced by OWNER, so two modules can both own a 0001_.
        id: `${namespace}:${entry}`,
        source: join(dir, entry),
        sql,
        checksum: checksumOf(sql),
      });
    }
  }

  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.id)) {
      throw new MigrationError(
        `duplicate migration id: ${f.id}. Two sources share a namespace — ` +
          `each module's migrations must be registered under its own module name.`,
      );
    }
    seen.add(f.id);
  }

  return files;
}

export interface MigrationResult {
  readonly applied: string[];
  readonly skipped: string[];
}

export async function runMigrations(
  db: Database,
  sources: readonly MigrationSource[],
  log: Logger,
): Promise<MigrationResult> {
  await db.query(BOOTSTRAP);

  const files = await loadMigrations(sources);
  const { rows } = await db.query<{ id: string; checksum: string }>(
    'SELECT id, checksum FROM schema_migrations',
  );
  const alreadyApplied = new Map(rows.map((r) => [r.id, r.checksum]));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const existing = alreadyApplied.get(file.id);

    if (existing !== undefined) {
      if (existing !== file.checksum) {
        throw new MigrationError(
          `migration ${file.id} has changed since it was applied ` +
            `(recorded ${existing}, found ${file.checksum}). ` +
            `Applied migrations are immutable — add a new migration instead.`,
        );
      }
      skipped.push(file.id);
      continue;
    }

    log.info({ migration: file.id }, 'applying migration');
    try {
      await db.withTransaction(async (tx) => {
        await tx.query(file.sql);
        await tx.query(
          'INSERT INTO schema_migrations (id, source, checksum) VALUES ($1, $2, $3)',
          [file.id, file.source, file.checksum],
        );
      });
    } catch (error) {
      throw new MigrationError(
        `migration ${file.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    applied.push(file.id);
  }

  log.info({ applied: applied.length, skipped: skipped.length }, 'migrations up to date');
  return { applied, skipped };
}
