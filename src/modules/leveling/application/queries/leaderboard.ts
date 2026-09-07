import type { Database } from '../../../../platform/db/pool.js';
import { getCurve } from '../../domain/curve/curve.js';
import { currentPeriodStart } from '../../domain/periods/calendar.js';
import type { GuildLevelingConfig } from '../../domain/types.js';

/**
 * Leaderboard queries (ADR-005: stored counters, read through indexes).
 *
 * Seven metrics, one query shape. The alternative — a bespoke query per metric
 * — is seven places to get the tie-break wrong.
 *
 * ORDERING IS ALWAYS `value DESC, user_id ASC`, matching the indexes and
 * matching `rankOf`. If those two ever disagree, a member's `/rank` number
 * stops matching their position on the board, which is the kind of bug people
 * report as "the bot is lying to me".
 */

export type LeaderboardMetric =
  | 'xp'
  | 'level'
  | 'weekly'
  | 'monthly'
  | 'voice'
  | 'reactions'
  | 'messages';

export interface LeaderboardEntry {
  readonly rank: number;
  readonly userId: string;
  readonly displayName: string | null;
  /** The snapshot from `member_xp`. Null means they never set one. */
  readonly avatarHash: string | null;
  readonly isDeparted: boolean;
  readonly value: number;
  /** Level, for metrics where showing it alongside is useful. */
  readonly level: number;
}

export interface LeaderboardPage {
  readonly metric: LeaderboardMetric;
  readonly entries: readonly LeaderboardEntry[];
  readonly page: number;
  readonly pageSize: number;
  readonly totalRanked: number;
  readonly totalPages: number;
}

interface MetricSpec {
  readonly table: string;
  readonly column: string;
  readonly label: string;
  readonly periodType?: 'week' | 'month';
}

const METRICS: Readonly<Record<LeaderboardMetric, MetricSpec>> = {
  xp: { table: 'member_xp', column: 'total_xp', label: 'Total XP' },
  level: { table: 'member_xp', column: 'level', label: 'Level' },
  weekly: { table: 'member_period_xp', column: 'xp', label: 'XP this week', periodType: 'week' },
  monthly: { table: 'member_period_xp', column: 'xp', label: 'XP this month', periodType: 'month' },
  voice: { table: 'member_stats', column: 'voice_seconds', label: 'Voice time' },
  reactions: { table: 'member_stats', column: 'reactions_received', label: 'Reactions received' },
  messages: { table: 'member_stats', column: 'messages_counted', label: 'Messages' },
};

export function metricLabel(metric: LeaderboardMetric): string {
  return METRICS[metric].label;
}

export interface LeaderboardQueryOptions {
  readonly guildId: string;
  readonly metric: LeaderboardMetric;
  readonly page?: number;
  readonly pageSize?: number;
  readonly config: GuildLevelingConfig;
  readonly now?: number;
}

export interface LeaderboardService {
  page(options: LeaderboardQueryOptions): Promise<LeaderboardPage>;
  /** Which page contains this member? Backs the "jump to me" control. */
  pageOf(options: LeaderboardQueryOptions & { userId: string }): Promise<number | null>;
}

export function createLeaderboardService(db: Database): LeaderboardService {
  return {
    async page(options) {
      const spec = METRICS[options.metric];
      const pageSize = clampPageSize(options.pageSize ?? options.config.leaderboardPageSize);
      const page = Math.max(1, Math.floor(options.page ?? 1));
      const offset = (page - 1) * pageSize;

      const { sql, params, countSql } = buildQuery(spec, options, options.metric);

      const [rowsResult, countResult] = await Promise.all([
        db.query<RawEntry>(`${sql} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [
          ...params,
          pageSize,
          offset,
        ]),
        db.query<{ count: string }>(countSql, params),
      ]);

      const totalRanked = Number(countResult.rows[0]?.count ?? 0);

      return {
        metric: options.metric,
        pageSize,
        page,
        totalRanked,
        totalPages: Math.max(1, Math.ceil(totalRanked / pageSize)),
        entries: rowsResult.rows.map((row, index) => ({
          rank: offset + index + 1,
          userId: row.user_id,
          displayName: row.display_name,
          avatarHash: row.avatar_hash,
          isDeparted: row.is_departed ?? false,
          value: Number(row.value),
          level: row.level ?? 0,
        })),
      };
    },

    async pageOf(options) {
      const spec = METRICS[options.metric];
      const pageSize = clampPageSize(options.pageSize ?? options.config.leaderboardPageSize);
      const { rankSql, params } = buildRankQuery(spec, options, options.userId);

      const { rows } = await db.query<{ ahead: string | null }>(rankSql, params);
      const ahead = rows[0]?.ahead;
      if (ahead == null) return null;
      return Math.floor(Number(ahead) / pageSize) + 1;
    },
  };
}

interface RawEntry {
  user_id: string;
  display_name: string | null;
  avatar_hash: string | null;
  is_departed: boolean | null;
  value: string;
  level: number | null;
}

function clampPageSize(size: number): number {
  return Math.min(25, Math.max(1, Math.floor(size)));
}

/**
 * All three source tables join back to member_xp so every board can show a
 * display name and a level — including for members who have LEFT, whose names
 * would otherwise render as raw snowflakes.
 */
function buildQuery(
  spec: MetricSpec,
  options: LeaderboardQueryOptions,
  metric: LeaderboardMetric,
): { sql: string; params: (string | number | Date)[]; countSql: string } {
  const params: (string | number | Date)[] = [options.guildId];
  const filters = [`t.guild_id = $1`, `t.${spec.column} > 0`];

  // `member_xp` carries is_departed and display_name itself; the other two
  // tables reach them through a join. Resolving that FIRST matters: writing the
  // filter against the joined alias when there is no join is a runtime SQL
  // error that only appears for guilds with the setting turned on.
  const join =
    spec.table === 'member_xp'
      ? ''
      : `LEFT JOIN member_xp AS m ON m.guild_id = t.guild_id AND m.user_id = t.user_id`;
  const nameSource = spec.table === 'member_xp' ? 't' : 'm';

  if (spec.periodType) {
    const start = currentPeriodStart(
      options.now ?? Date.now(),
      spec.periodType,
      options.config.timezone,
      options.config.weekStartDay,
    );
    params.push(spec.periodType, new Date(start));
    filters.push(`t.period_type = $${params.length - 1}`, `t.period_start = $${params.length}`);
  }

  if (options.config.hideDepartedMembers) {
    filters.push(`COALESCE(${nameSource}.is_departed, false) = false`);
  }

  const where = filters.join(' AND ');

  const sql = `
    SELECT t.user_id,
           ${nameSource}.display_name AS display_name,
           ${nameSource}.avatar_hash  AS avatar_hash,
           ${nameSource}.is_departed  AS is_departed,
           t.${spec.column}           AS value,
           ${spec.table === 'member_xp' ? 't.level' : 'COALESCE(m.level, 0)'} AS level
    FROM ${spec.table} AS t
    ${spec.table === 'member_xp' ? '' : join}
    WHERE ${where}
    ORDER BY t.${spec.column} DESC, t.user_id ASC`;

  const countSql = `
    SELECT count(*)::text AS count
    FROM ${spec.table} AS t
    ${spec.table === 'member_xp' ? '' : join}
    WHERE ${where}`;

  void metric;
  return { sql, params, countSql };
}

function buildRankQuery(
  spec: MetricSpec,
  options: LeaderboardQueryOptions,
  userId: string,
): { rankSql: string; params: (string | number | Date)[] } {
  const params: (string | number | Date)[] = [options.guildId, userId];
  let periodFilter = '';

  if (spec.periodType) {
    const start = currentPeriodStart(
      options.now ?? Date.now(),
      spec.periodType,
      options.config.timezone,
      options.config.weekStartDay,
    );
    params.push(spec.periodType, new Date(start));
    periodFilter = ` AND me.period_type = $3 AND me.period_start = $4`;
  }

  const otherPeriodFilter = spec.periodType
    ? ` AND o.period_type = $3 AND o.period_start = $4`
    : '';

  /**
   * The departed filter has to be applied here TOO, and identically.
   *
   * If the page query excludes departed members and this one does not, the
   * count of members ahead includes people who are not on the board, and "jump
   * to me" sends the member to a page they are not on — the exact failure the
   * shared tie-break exists to prevent.
   */
  const onOwn = spec.table === 'member_xp';
  const joinFor = (alias: string, joined: string): string =>
    onOwn || !options.config.hideDepartedMembers
      ? ''
      : `LEFT JOIN member_xp AS ${joined} ` +
        `ON ${joined}.guild_id = ${alias}.guild_id AND ${joined}.user_id = ${alias}.user_id`;
  const departedFilter = (alias: string, joined: string): string =>
    options.config.hideDepartedMembers
      ? ` AND COALESCE(${onOwn ? alias : joined}.is_departed, false) = false`
      : '';

  // Counts how many members are AHEAD, using exactly the ordering the page
  // query uses — same tie-break, so "jump to me" always lands on the page the
  // member is actually on.
  const rankSql = `
    SELECT (
      SELECT count(*)
      FROM ${spec.table} AS o
      ${joinFor('o', 'mo')}
      WHERE o.guild_id = me.guild_id
        AND o.${spec.column} > 0
        ${otherPeriodFilter}${departedFilter('o', 'mo')}
        AND (o.${spec.column} > me.${spec.column}
             OR (o.${spec.column} = me.${spec.column} AND o.user_id < me.user_id))
    ) AS ahead
    FROM ${spec.table} AS me
    ${joinFor('me', 'mme')}
    WHERE me.guild_id = $1 AND me.user_id = $2
      AND me.${spec.column} > 0${periodFilter}${departedFilter('me', 'mme')}`;

  return { rankSql, params };
}

// ---------------------------------------------------------------------------

export interface RankSnapshot {
  readonly userId: string;
  readonly displayName: string | null;
  readonly totalXp: number;
  readonly level: number;
  readonly xpIntoLevel: number;
  readonly xpForNextLevel: number;
  readonly progressRatio: number;
  readonly rank: number | null;
  readonly rankTotal: number;
  readonly isMaxLevel: boolean;
  readonly isDeparted: boolean;
}

/**
 * Everything `/rank` needs, in one place. Deliberately returns plain data with
 * no Discord types so the embed formatter and (later) the card renderer consume
 * the same object and cannot drift apart.
 */
export async function getRankSnapshot(
  db: Database,
  guildId: string,
  userId: string,
  config: GuildLevelingConfig,
): Promise<RankSnapshot | null> {
  const { rows } = await db.query<{
    total_xp: string;
    level: number;
    display_name: string | null;
    is_departed: boolean;
    rank: string | null;
    total_ranked: string;
  }>(
    `SELECT me.total_xp,
            me.level,
            me.display_name,
            me.is_departed,
            CASE WHEN me.total_xp > 0 THEN (
              SELECT count(*) + 1 FROM member_xp o
              WHERE o.guild_id = me.guild_id AND o.total_xp > 0
                AND (o.total_xp > me.total_xp
                     OR (o.total_xp = me.total_xp AND o.user_id < me.user_id))
            ) END AS rank,
            (SELECT count(*)::text FROM member_xp c
             WHERE c.guild_id = me.guild_id AND c.total_xp > 0) AS total_ranked
     FROM member_xp AS me
     WHERE me.guild_id = $1 AND me.user_id = $2`,
    [guildId, userId],
  );

  const row = rows[0];
  if (!row) return null;

  const totalXp = Number(row.total_xp);
  const progress = getCurve(config.curve).progressFor(totalXp);

  return {
    userId,
    displayName: row.display_name,
    totalXp,
    level: progress.level,
    xpIntoLevel: progress.xpIntoLevel,
    xpForNextLevel: progress.xpForNextLevel,
    progressRatio: progress.progressRatio,
    rank: row.rank == null ? null : Number(row.rank),
    rankTotal: Number(row.total_ranked),
    isMaxLevel: progress.isMaxLevel,
    isDeparted: row.is_departed,
  };
}
