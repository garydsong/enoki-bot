import type { Database } from '../../../platform/db/pool.js';
import type { Logger } from '../../../platform/logging/logger.js';
import { getCurve } from '../domain/curve/curve.js';
import { parseXpCsv, type ParsedXpRow, type XpImportError } from '../domain/import/csv.js';
import type { GuildLevelingConfig } from '../domain/types.js';
import type { MemberXpRepository } from '../ports/memberXp.js';

/**
 * `/xp import` — bulk XP from a CSV (roadmap M15).
 *
 * The point of this feature is a server LEAVING another bot: a year of members'
 * levels arrives as a file, and the import either reproduces it faithfully or
 * is worse than not migrating at all. Three decisions follow from that.
 *
 * **Dry run is the default.** The report an admin sees before applying is the
 * whole safety mechanism, so it is produced by parsing and diffing the real
 * file against the real database — not by a separate estimate.
 *
 * **A batch is a transaction.** Ten thousand rows in one transaction holds a
 * connection for minutes and rolls back the whole migration over one bad row;
 * ten thousand separate writes leave a half-imported guild with no way to tell
 * where it stopped. Batches of `BATCH_SIZE` give a bounded blast radius and a
 * precise "committed N of M" when something fails.
 *
 * **Validation happens before ANY write.** The file is parsed in full and
 * refused as a whole if it contains errors, unless the caller explicitly says
 * to skip bad rows. Partially importing a file whose columns were misread is
 * the failure this exists to prevent.
 */

/** Rows per transaction. Small enough to hold no lock for long. */
const BATCH_SIZE = 500;

export interface ImportPlan {
  readonly rows: readonly ParsedXpRow[];
  readonly errors: readonly XpImportError[];
  readonly hadHeader: boolean;
  /** Members in the file who already have XP here. */
  readonly existing: number;
  /** Members in the file who are new to this guild. */
  readonly fresh: number;
  /** Total XP the guild holds now, across the members named in the file. */
  readonly currentXp: number;
  /** Total XP those members would hold after the import. */
  readonly resultingXp: number;
  /** The highest level anyone in the file would reach. */
  readonly topLevel: number;
}

export interface ImportResult {
  readonly applied: number;
  readonly batches: number;
  readonly failedAtBatch: number | null;
  readonly error: string | null;
}

export type ImportMode = 'set' | 'add';

export interface XpImportDeps {
  readonly db: Database;
  readonly memberXp: MemberXpRepository;
  readonly log: Logger;
}

export interface XpImporter {
  plan(guildId: string, text: string, mode: ImportMode, config: GuildLevelingConfig): Promise<ImportPlan>;
  apply(
    guildId: string,
    rows: readonly ParsedXpRow[],
    mode: ImportMode,
    config: GuildLevelingConfig,
  ): Promise<ImportResult>;
}

export function createXpImporter(deps: XpImportDeps): XpImporter {
  return {
    /**
     * Parse, then ask the database what the file would actually do.
     *
     * The "would" numbers are computed against the members' CURRENT totals in
     * one query rather than estimated, because the difference between "imports
     * 4,812 members" and "overwrites 4,812 members' existing XP" is the whole
     * decision the admin is making.
     */
    async plan(guildId, text, mode, config) {
      const parsed = parseXpCsv(text);
      const curve = getCurve(config.curve);

      if (parsed.rows.length === 0) {
        return {
          rows: parsed.rows,
          errors: parsed.errors,
          hadHeader: parsed.hadHeader,
          existing: 0,
          fresh: 0,
          currentXp: 0,
          resultingXp: 0,
          topLevel: 0,
        };
      }

      const { rows } = await deps.db.query<{ user_id: string; total_xp: string }>(
        `SELECT user_id, total_xp FROM member_xp
         WHERE guild_id = $1 AND user_id = ANY($2::bigint[])`,
        [guildId, parsed.rows.map((r) => r.userId)],
      );
      const current = new Map(rows.map((r) => [r.user_id, Number(r.total_xp)]));

      let currentXp = 0;
      let resultingXp = 0;
      let topLevel = 0;

      for (const row of parsed.rows) {
        const before = current.get(row.userId) ?? 0;
        const after = mode === 'set' ? row.xp : before + row.xp;
        currentXp += before;
        resultingXp += after;
        topLevel = Math.max(topLevel, curve.levelFromTotalXp(after));
      }

      return {
        rows: parsed.rows,
        errors: parsed.errors,
        hadHeader: parsed.hadHeader,
        existing: current.size,
        fresh: parsed.rows.length - current.size,
        currentXp,
        resultingXp,
        topLevel,
      };
    },

    /**
     * Write the rows, batch by batch.
     *
     * A failing batch rolls itself back and STOPS the import rather than
     * carrying on: whatever made row 3,412 fail will very likely make row
     * 3,413 fail too, and an admin needs "3,000 committed, stopped here,
     * because X" rather than a scattering of successes.
     */
    async apply(guildId, rows, mode, config) {
      const levelFor = (totalXp: number): number => getCurve(config.curve).levelFromTotalXp(totalXp);

      let applied = 0;
      let batches = 0;

      for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
        const batch = rows.slice(offset, offset + BATCH_SIZE);
        batches += 1;
        try {
          await deps.db.withTransaction(async (tx) => {
            await deps.memberXp.bulkUpsertXp(
              tx,
              guildId,
              batch.map((r) => ({ userId: r.userId, xp: r.xp })),
              mode,
              levelFor,
            );
          });
          applied += batch.length;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          deps.log.error({ err: error, guildId, batch: batches, applied }, 'xp import batch failed');
          return {
            applied,
            batches,
            failedAtBatch: batches,
            error: message.slice(0, 300),
          };
        }
      }

      deps.log.info({ guildId, applied, batches, mode }, 'xp import applied');
      return { applied, batches, failedAtBatch: null, error: null };
    },
  };
}
