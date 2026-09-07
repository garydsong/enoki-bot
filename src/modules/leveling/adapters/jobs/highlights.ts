import { EmbedBuilder, PermissionFlagsBits, type Guild } from 'discord.js';
import type { Database } from '../../../../platform/db/pool.js';
import type { JobDefinition, ModuleContext } from '../../../../platform/plugin/types.js';
import {
  currentPeriodStart,
  previousPeriodStart,
  type PeriodType,
} from '../../domain/periods/calendar.js';
import type { GuildLevelingConfig } from '../../domain/types.js';
import type { LeaderboardService } from '../../application/queries/leaderboard.js';
import type { ConfigCache } from '../../ports/config.js';
import { escapeMarkdown, formatNumber, rankBadge } from '../commands/format.js';

/**
 * Weekly / monthly Highlights (spec `05` §4, roadmap M13).
 *
 * THE ENTIRE PROBLEM IS POSTING EXACTLY ONCE.
 *
 * The job runs hourly, every guild has its own timezone and week-start, and the
 * process restarts whenever it is deployed — so "post when the period ends"
 * cannot be a timer. Instead the job asks, every hour, "is there a finished
 * period I have not posted?", and CLAIMS it in the database before posting.
 * `job_run`'s primary key is `(job_name, scope_key)`, so an insert keyed on
 * (guild, period type, period start) either succeeds — this process owns the
 * post — or conflicts, meaning someone already has it. A crash between the
 * claim and the post loses that one announcement, which is the right trade
 * against the alternative of double-posting.
 *
 * The grace window is the other half. Coming back from a fortnight of downtime
 * there are two finished weeks in the backlog; announcing a stale board is
 * noise and announcing both at once is worse. Anything older than the grace
 * window is marked done WITHOUT posting.
 */

export interface HighlightsDeps {
  readonly db: Database;
  readonly configs: ConfigCache;
  readonly boards: LeaderboardService;
}

const JOB = 'leveling:highlights';

export function createHighlightsJob(deps: HighlightsDeps): JobDefinition {
  return {
    name: JOB,
    intervalMs: 3_600_000,
    // Deliberately runs at boot: a restart that happens to span a period
    // boundary should still post, and the claim makes that safe.
    skipInitialRun: false,

    async run(ctx: ModuleContext) {
      for (const guild of ctx.client.guilds.cache.values()) {
        try {
          await postFor(guild, deps, ctx);
        } catch (error) {
          ctx.log.error({ err: error, guildId: guild.id }, 'highlights failed for a guild');
        }
      }
    },
  };
}

async function postFor(guild: Guild, deps: HighlightsDeps, ctx: ModuleContext): Promise<void> {
  const config = await deps.configs.get(guild.id);
  if (!config.enabled || !config.highlights.enabled) return;

  const periods: PeriodType[] = [
    ...(config.highlights.weekly ? (['week'] as const) : []),
    ...(config.highlights.monthly ? (['month'] as const) : []),
  ];

  for (const periodType of periods) {
    const now = Date.now();
    // The period that just ENDED is the one before the current one. Its start
    // is the scope key, so the claim is stable no matter when the job runs.
    const currentStart = currentPeriodStart(now, periodType, config.timezone, config.weekStartDay);
    const finishedStart = previousPeriodStart(
      currentStart,
      periodType,
      config.timezone,
      config.weekStartDay,
    );

    const scopeKey = `${guild.id}:${periodType}:${new Date(finishedStart).toISOString()}`;
    if (!(await claim(deps.db, scopeKey))) continue;

    const endedHoursAgo = (now - currentStart) / 3_600_000;
    if (endedHoursAgo > config.highlights.graceHours) {
      // Claimed and deliberately not posted. Marking it done is the point:
      // otherwise every hour reconsiders the same stale period forever.
      await finish(deps.db, scopeKey, 'skipped: past the grace window');
      ctx.log.info(
        { guildId: guild.id, periodType, endedHoursAgo: Math.round(endedHoursAgo) },
        'highlights period is stale; marked done without posting',
      );
      continue;
    }

    await announce(guild, deps, ctx, config, periodType, finishedStart);
    await finish(deps.db, scopeKey, null);
  }
}

/**
 * Claim a (guild, period) for posting.
 *
 * `ON CONFLICT DO NOTHING` on a primary key is the whole mechanism — one row
 * exists per period per guild, forever, and only the process that inserted it
 * posts.
 */
async function claim(db: Database, scopeKey: string): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO job_run (job_name, scope_key, status, started_at)
     VALUES ($1, $2, 'running', now())
     ON CONFLICT (job_name, scope_key) DO NOTHING`,
    [JOB, scopeKey],
  );
  return (result.rowCount ?? 0) > 0;
}

async function finish(db: Database, scopeKey: string, note: string | null): Promise<void> {
  await db.query(
    `UPDATE job_run SET status = 'succeeded', finished_at = now(), error = $3
     WHERE job_name = $1 AND scope_key = $2`,
    [JOB, scopeKey, note],
  );
}

async function announce(
  guild: Guild,
  deps: HighlightsDeps,
  ctx: ModuleContext,
  config: GuildLevelingConfig,
  periodType: PeriodType,
  finishedStart: number,
): Promise<void> {
  // Read the FINISHED period, not the current one: `now` is what selects the
  // bucket, so it has to be an instant inside the period being reported.
  const insideFinishedPeriod = finishedStart + 1000;

  const page = await deps.boards.page({
    guildId: guild.id,
    metric: periodType === 'week' ? 'weekly' : 'monthly',
    page: 1,
    pageSize: config.highlights.size,
    config,
    now: insideFinishedPeriod,
  });

  if (page.entries.length === 0) {
    ctx.log.debug({ guildId: guild.id, periodType }, 'nothing to highlight');
    return;
  }

  const channelId = config.highlights.channelId;
  const channel = channelId ? guild.channels.cache.get(channelId) : null;

  if (channel?.isTextBased()) {
    const permissions = guild.members.me ? channel.permissionsFor(guild.members.me) : null;
    if (permissions?.has(PermissionFlagsBits.SendMessages)) {
      const embed = new EmbedBuilder()
        .setTitle(periodType === 'week' ? '🏆 This week in review' : '🏆 This month in review')
        .setDescription(
          page.entries
            .map(
              (entry) =>
                `${rankBadge(entry.rank)} **${
                  entry.displayName ? escapeMarkdown(entry.displayName) : `<@${entry.userId}>`
                }** — ${formatNumber(entry.value)} XP`,
            )
            .join('\n'),
        )
        .setFooter({
          text: `${formatNumber(page.totalRanked)} members earned XP · period starting ${new Date(
            finishedStart,
          ).toISOString().slice(0, 10)}`,
        });

      await channel.send({ embeds: [embed] }).catch((error: unknown) => {
        ctx.log.warn({ err: error, guildId: guild.id }, 'could not post highlights');
      });
    } else {
      ctx.log.warn(
        { guildId: guild.id, channelId },
        'highlights are enabled but I cannot post in the configured channel',
      );
    }
  }

  // The first-place role follows the WEEKLY board only. Monthly winners are
  // reported but do not move it, because two roles fighting over the same
  // "current leader" idea is a worse experience than one that is clearly weekly.
  if (periodType === 'week' && config.highlights.firstPlaceRoleId) {
    await reconcileFirstPlace(guild, ctx, config.highlights.firstPlaceRoleId, page.entries[0]?.userId);
  }
}

/**
 * Hand the first-place role to the new leader and take it from the old one.
 *
 * Reconciled as a desired set of exactly one, for the same reason reward roles
 * are (ADR-007): computing "who should have it" and diffing is idempotent, so a
 * missed run or a manual grant is corrected on the next period rather than
 * accumulating a second holder.
 */
async function reconcileFirstPlace(
  guild: Guild,
  ctx: ModuleContext,
  roleId: string,
  winnerId: string | undefined,
): Promise<void> {
  const role = guild.roles.cache.get(roleId);
  const me = guild.members.me;
  if (!role || !me?.permissions.has(PermissionFlagsBits.ManageRoles)) return;
  if (role.position >= me.roles.highest.position || role.managed) {
    ctx.log.warn({ guildId: guild.id, roleId }, 'cannot manage the first-place role');
    return;
  }

  const holders = role.members;

  for (const [memberId, member] of holders) {
    if (memberId === winnerId) continue;
    await member.roles.remove(role, 'no longer first place').catch(() => undefined);
  }

  if (winnerId && !holders.has(winnerId)) {
    const winner = await guild.members.fetch(winnerId).catch(() => null);
    await winner?.roles.add(role, 'first place this week').catch(() => undefined);
  }
}
