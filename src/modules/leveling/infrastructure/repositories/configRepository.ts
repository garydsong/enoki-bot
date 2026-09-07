import type { Database, Queryable } from '../../../../platform/db/pool.js';
import { DEFAULT_LEVELING_CONFIG } from '../../domain/support/defaults.js';
import type {
  AuditRepository,
  ConfigRepository,
  RuleRepository,
} from '../../ports/config.js';
import type {
  GuildLevelingConfig,
  PassiveXpSource,
  RoleRewardRule,
  SourceConfig,
  XpRule,
} from '../../domain/types.js';

export type {
  AuditEntry,
  AuditRepository,
  ConfigRepository,
  LoadedConfig,
  RuleRepository,
} from '../../ports/config.js';

/**
 * Guild configuration assembly.
 *
 * The engine consumes ONE object per evaluation, so this loads the wide config
 * row, the per-source rows, the rule set and the rewards, and stitches them
 * into the shape `domain/` expects. Four indexed reads, cached by
 * `config_version` (see ../cache/configCache.ts) — the hot path does not touch
 * the database for configuration at all.
 *
 * The domain layer never sees a database row: the mapping lives here, which is
 * what lets the schema change without touching the engine.
 */

const SOURCES: PassiveXpSource[] = ['message', 'voice', 'reaction_add', 'reaction_receive'];

interface RawConfig {
  [key: string]: unknown;
  config_version: string;
}

interface RawSource {
  source: PassiveXpSource;
  enabled: boolean;
  min_xp: number;
  max_xp: number;
  cooldown_seconds: number;
  per_event_cap: number;
  message_mode: 'random' | 'per_word' | null;
  reaction_max_per_message: number | null;
  reaction_max_message_age_days: number | null;
}

interface RawRule {
  kind: XpRule['kind'];
  target_type: XpRule['targetType'];
  target_id: string | null;
  bonus_bps: number | null;
  source_scope: PassiveXpSource | null;
  expires_at: Date | null;
}

interface RawReward {
  rule_type: 'exact' | 'recurring';
  level: number | null;
  every_n: number | null;
  start_level: number | null;
  role_id: string;
  broken_reason: string | null;
}

export function createConfigRepository(db: Database): ConfigRepository {
  return {
    async ensure(guildId) {
      await db.withTransaction(async (tx) => {
        await tx.query(
          `INSERT INTO leveling_config (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING`,
          [guildId],
        );
        for (const source of SOURCES) {
          const d = DEFAULT_LEVELING_CONFIG.sources[source];
          await tx.query(
            `INSERT INTO xp_source_config
               (guild_id, source, enabled, min_xp, max_xp, cooldown_seconds, per_event_cap, message_mode)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (guild_id, source) DO NOTHING`,
            [
              guildId,
              source,
              d.enabled,
              d.minXp,
              d.maxXp,
              d.cooldownSeconds,
              d.perEventCap,
              d.messageMode ?? null,
            ],
          );
        }
      });
    },

    async version(guildId) {
      const { rows } = await db.query<{ config_version: string }>(
        `SELECT config_version FROM leveling_config WHERE guild_id = $1`,
        [guildId],
      );
      return Number(rows[0]?.config_version ?? 0);
    },

    async load(guildId) {
      await this.ensure(guildId);

      const [configResult, sourceResult, ruleResult, rewardResult] = await Promise.all([
        db.query<RawConfig>(`SELECT * FROM leveling_config WHERE guild_id = $1`, [guildId]),
        db.query<RawSource>(`SELECT * FROM xp_source_config WHERE guild_id = $1`, [guildId]),
        db.query<RawRule>(
          `SELECT kind, target_type, target_id, bonus_bps, source_scope, expires_at
           FROM xp_rule WHERE guild_id = $1`,
          [guildId],
        ),
        db.query<RawReward>(
          `SELECT rule_type, level, every_n, start_level, role_id, broken_reason
           FROM role_reward WHERE guild_id = $1`,
          [guildId],
        ),
      ]);

      const raw = configResult.rows[0];
      if (!raw) throw new Error(`leveling_config missing for guild ${guildId}`);

      return {
        version: Number(raw.config_version),
        config: assemble(raw, sourceResult.rows, ruleResult.rows, rewardResult.rows),
      };
    },

    /**
     * Every write bumps `config_version`. That single increment is the entire
     * cache-invalidation protocol: readers compare versions instead of
     * subscribing to anything.
     */
    async update(guildId, patch, actorId) {
      const entries = Object.entries(patch);
      if (entries.length === 0) return this.version(guildId);

      // An UPDATE against a row that does not exist reports success and changes
      // nothing — the admin is told their setting was saved and it was not.
      // Ensuring first makes this method correct on its own rather than
      // correct-only-if-someone-loaded-the-config-first.
      await this.ensure(guildId);

      const assignments = entries.map(([column], i) => `${column} = $${i + 3}`);
      const { rows } = await db.query<{ config_version: string }>(
        `UPDATE leveling_config
         SET ${assignments.join(', ')},
             config_version = config_version + 1,
             updated_at = now(),
             updated_by = $2
         WHERE guild_id = $1
         RETURNING config_version`,
        [guildId, actorId ?? null, ...entries.map(([, value]) => value as never)],
      );
      return Number(rows[0]?.config_version ?? 0);
    },

    async updateSource(guildId, source, patch) {
      const entries = Object.entries(patch);
      if (entries.length === 0) return;

      // Same reasoning as `update`: never silently write into nothing.
      await this.ensure(guildId);

      const assignments = entries.map(([column], i) => `${column} = $${i + 3}`);
      await db.withTransaction(async (tx) => {
        await tx.query(
          `UPDATE xp_source_config SET ${assignments.join(', ')}
           WHERE guild_id = $1 AND source = $2`,
          [guildId, source, ...entries.map(([, value]) => value as never)],
        );
        // Source rows live in their own table but are part of the same cached
        // object, so they must bump the same version.
        await tx.query(
          `UPDATE leveling_config SET config_version = config_version + 1, updated_at = now()
           WHERE guild_id = $1`,
          [guildId],
        );
      });
    },

    async resetToDefaults(guildId) {
      await db.withTransaction(async (tx) => {
        await tx.query(`DELETE FROM leveling_config WHERE guild_id = $1`, [guildId]);
        await tx.query(`DELETE FROM xp_source_config WHERE guild_id = $1`, [guildId]);
      });
      await this.ensure(guildId);
    },
  };
}

// ---------------------------------------------------------------------------
// Row -> domain mapping. The domain never sees snake_case or a Date from pg.
// ---------------------------------------------------------------------------

/**
 * pg returns int8 as a STRING, which is exactly what a snowflake needs — it
 * exceeds Number.MAX_SAFE_INTEGER, so anything that routes one through a JS
 * number silently corrupts it.
 */
function asSnowflake(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;
}

function assemble(
  raw: RawConfig,
  sources: readonly RawSource[],
  rules: readonly RawRule[],
  rewards: readonly RawReward[],
): GuildLevelingConfig {
  const bySource = new Map(sources.map((s) => [s.source, s]));

  const sourceConfig = (source: PassiveXpSource): SourceConfig => {
    const row = bySource.get(source);
    if (!row) return DEFAULT_LEVELING_CONFIG.sources[source];
    return {
      enabled: row.enabled,
      minXp: row.min_xp,
      maxXp: row.max_xp,
      cooldownSeconds: row.cooldown_seconds,
      perEventCap: row.per_event_cap,
      ...(row.message_mode ? { messageMode: row.message_mode } : {}),
      reactionMaxPerMessage: row.reaction_max_per_message ?? 3,
      reactionMaxMessageAgeDays: row.reaction_max_message_age_days,
    };
  };

  const num = (key: string, fallback: number): number => {
    const v = raw[key];
    return typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : fallback;
  };
  const bool = (key: string, fallback: boolean): boolean =>
    typeof raw[key] === 'boolean' ? raw[key] : fallback;
  const str = <T extends string>(key: string, fallback: T): T =>
    typeof raw[key] === 'string' ? (raw[key] as T) : fallback;

  return {
    enabled: bool('enabled', false),

    curve: {
      type: str('curve_type', 'linear'),
      multiplierBps: num('curve_multiplier_bps', 10000),
      maxLevel: raw['max_level'] == null ? null : Number(raw['max_level']),
      hardCapXp: bool('hard_cap_xp', false),
    },

    sources: {
      message: sourceConfig('message'),
      voice: sourceConfig('voice'),
      reaction_add: sourceConfig('reaction_add'),
      reaction_receive: sourceConfig('reaction_receive'),
    },

    rules: rules.map(
      (r): XpRule => ({
        kind: r.kind,
        targetType: r.target_type,
        targetId: r.target_id,
        ...(r.bonus_bps === null ? {} : { bonusBps: r.bonus_bps }),
        sourceScope: r.source_scope,
        expiresAt: r.expires_at === null ? null : r.expires_at.getTime(),
      }),
    ),

    // Broken rewards are excluded from the engine's view: a rule whose role was
    // deleted must not be offered to a member. It is KEPT in the database and
    // surfaced to admins, because silently discarding configuration is hostile.
    rewards: rewards
      .filter((r) => r.broken_reason === null)
      .map((r): RoleRewardRule =>
        r.rule_type === 'exact'
          ? { type: 'exact', level: r.level ?? 0, roleId: r.role_id }
          : {
              type: 'recurring',
              everyN: r.every_n ?? 1,
              startLevel: r.start_level ?? 0,
              roleId: r.role_id,
            },
      ),

    notifications: {
      mode: str('levelup_mode', 'source_channel'),
      // int8/bigint arrives as a string from pg, which is what we want for a
      // snowflake — Number() would silently corrupt it past 2^53.
      channelId: asSnowflake(raw['levelup_channel_id']),
      template: str('levelup_template', DEFAULT_LEVELING_CONFIG.notifications.template),
      useEmbed: bool('levelup_use_embed', false),
      embedColor: raw['levelup_embed_color'] == null ? null : Number(raw['levelup_embed_color']),
      deleteAfterSeconds:
        raw['levelup_delete_after_seconds'] == null
          ? null
          : Number(raw['levelup_delete_after_seconds']),
      onlyOnRewardLevels: bool('levelup_only_on_reward_levels', false),
    },

    highlights: {
      enabled: bool('highlights_enabled', false),
      channelId: asSnowflake(raw['highlights_channel_id']),
      weekly: bool('highlights_weekly', true),
      monthly: bool('highlights_monthly', false),
      size: num('highlights_size', 5),
      firstPlaceRoleId: asSnowflake(raw['first_place_role_id']),
      graceHours: num('highlights_grace_hours', 48),
    },

    cards: {
      enabled: bool('cards_enabled', false),
      accentColor:
        raw['card_accent_color'] == null ? 0x5865f2 : Number(raw['card_accent_color']),
      backgroundUrl: typeof raw['card_background_url'] === 'string'
        ? raw['card_background_url']
        : null,
      allowMemberCustomisation: bool('card_allow_member_customisation', true),
    },

    rewardStacking: str('reward_stacking', 'stack'),
    removeOnLevelDown: bool('remove_on_level_down', true),
    boosterStacking: str('booster_stacking', 'stack'),

    effort: {
      enabled: bool('effort_enabled', false),
      charsPerXp: num('effort_chars_per_xp', 50),
      lengthCap: num('effort_length_cap', 10),
      attachmentXp: num('effort_attachment_xp', 5),
    },

    context: {
      xpInThreads: bool('xp_in_threads', true),
      xpInForumPosts: bool('xp_in_forum_posts', true),
      xpInVoiceText: bool('xp_in_voice_text', true),
      minMessageLength: num('min_message_length', 0),
    },

    voice: {
      minMembers: num('voice_min_members', 1),
      requireUnmuted: bool('voice_require_unmuted', true),
      requireUndeafened: bool('voice_require_undeafened', true),
      countServerMuteAsInactive: bool('voice_server_mute_inactive', true),
      ignoreAfkChannel: bool('voice_ignore_afk_channel', true),
      ignoreBotsInMemberCount: bool('voice_ignore_bots_in_count', true),
      tickSeconds: num('voice_tick_seconds', 180),
      antiAfkEnabled: bool('anti_afk_enabled', true),
      antiAfkAfterMinutes: num('anti_afk_after_minutes', 120),
      // Stored as basis points so the whole config is integer maths; the domain
      // works in fractions.
      antiAfkDecayPerHour: num('anti_afk_decay_per_hour_bps', 2500) / 10000,
      antiAfkFloorMultiplier: num('anti_afk_floor_bps', 1000) / 10000,
    },

    timezone: str('timezone', 'UTC'),
    weekStartDay: str('week_start_day', 'monday'),
    leaderboardPageSize: num('leaderboard_page_size', 10),
    hideDepartedMembers: bool('hide_departed_members', false),
    maxMultiplierBps: num('max_multiplier_bps', 100000),
    minAccountAgeDays: num('min_account_age_days', 0),
    minMemberAgeHours: num('min_member_age_hours', 0),
    allowSelfReactions: bool('allow_self_reactions', false),
    manualGrantMax: num('manual_grant_max', 1_000_000),
    disableResets: bool('disable_resets', false),
    autoResetOnLeave: bool('auto_reset_on_leave', false),
    reconcileOnRankCommand: bool('reconcile_on_rank_command', false),
  };
}

// ---------------------------------------------------------------------------
// Rules, rewards and the audit log
// ---------------------------------------------------------------------------

export function createRuleRepository(db: Database): RuleRepository {
  return {
    async addRule(guildId, rule, createdBy) {
      await db.query(
        `INSERT INTO xp_rule (guild_id, kind, target_type, target_id, bonus_bps, source_scope, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (guild_id, kind, target_type, COALESCE(target_id, ''), COALESCE(source_scope, ''))
         DO UPDATE SET bonus_bps = EXCLUDED.bonus_bps, expires_at = EXCLUDED.expires_at`,
        [
          guildId,
          rule.kind,
          rule.targetType,
          rule.targetId,
          rule.bonusBps ?? null,
          rule.sourceScope ?? null,
          rule.expiresAt == null ? null : new Date(rule.expiresAt),
          createdBy ?? null,
        ],
      );
      await bumpConfigVersion(db, guildId);
    },

    async removeRule(guildId, kind, targetType, targetId) {
      const result = await db.query(
        `DELETE FROM xp_rule
         WHERE guild_id = $1 AND kind = $2 AND target_type = $3
           AND COALESCE(target_id, '') = COALESCE($4, '')`,
        [guildId, kind, targetType, targetId],
      );
      await bumpConfigVersion(db, guildId);
      return result.rowCount ?? 0;
    },

    async clearRules(guildId, kind) {
      const result = kind
        ? await db.query(`DELETE FROM xp_rule WHERE guild_id = $1 AND kind = $2`, [guildId, kind])
        : await db.query(`DELETE FROM xp_rule WHERE guild_id = $1`, [guildId]);
      await bumpConfigVersion(db, guildId);
      return result.rowCount ?? 0;
    },

    async addReward(guildId, level, roleId, createdBy) {
      await db.query(
        `INSERT INTO role_reward (guild_id, rule_type, level, role_id, created_by)
         VALUES ($1, 'exact', $2, $3, $4)
         ON CONFLICT (guild_id, level, role_id) WHERE rule_type = 'exact'
         DO UPDATE SET broken_reason = NULL, broken_notified_at = NULL`,
        [guildId, level, roleId, createdBy ?? null],
      );
      await bumpConfigVersion(db, guildId);
    },

    /**
     * "This role, at level N, and again every M levels."
     *
     * A separate statement from `addReward` because the two shapes have
     * different unique indexes and a CHECK constraint that refuses to let one
     * masquerade as the other (`role_reward_shape`). Re-adding an identical
     * rule clears any breakage, matching the exact case: an admin re-adding a
     * reward after fixing the role expects it to start working again.
     */
    async addRecurringReward(guildId, everyN, startLevel, roleId, createdBy) {
      await db.query(
        `INSERT INTO role_reward (guild_id, rule_type, every_n, start_level, role_id, created_by)
         VALUES ($1, 'recurring', $2, $3, $4, $5)
         ON CONFLICT (guild_id, every_n, start_level, role_id) WHERE rule_type = 'recurring'
         DO UPDATE SET broken_reason = NULL, broken_notified_at = NULL`,
        [guildId, everyN, startLevel, roleId, createdBy ?? null],
      );
      await bumpConfigVersion(db, guildId);
    },

    async removeRecurringReward(guildId, roleId) {
      const result = roleId
        ? await db.query(
            `DELETE FROM role_reward
             WHERE guild_id = $1 AND rule_type = 'recurring' AND role_id = $2`,
            [guildId, roleId],
          )
        : await db.query(
            `DELETE FROM role_reward WHERE guild_id = $1 AND rule_type = 'recurring'`,
            [guildId],
          );
      await bumpConfigVersion(db, guildId);
      return result.rowCount ?? 0;
    },

    async removeReward(guildId, level, roleId) {
      const result = roleId
        ? await db.query(
            `DELETE FROM role_reward WHERE guild_id = $1 AND level = $2 AND role_id = $3`,
            [guildId, level, roleId],
          )
        : await db.query(`DELETE FROM role_reward WHERE guild_id = $1 AND level = $2`, [
            guildId,
            level,
          ]);
      await bumpConfigVersion(db, guildId);
      return result.rowCount ?? 0;
    },

    async listRewards(guildId) {
      const { rows } = await db.query<{
        rule_type: 'exact' | 'recurring';
        level: number | null;
        every_n: number | null;
        start_level: number | null;
        role_id: string;
        broken_reason: string | null;
      }>(
        // Ordered by the level the rule FIRST takes effect, so an exact rule at
        // 10 and a recurring one starting at 10 sit next to each other rather
        // than in two separate blocks.
        `SELECT rule_type, level, every_n, start_level, role_id, broken_reason
         FROM role_reward
         WHERE guild_id = $1
         ORDER BY COALESCE(level, start_level), rule_type, role_id`,
        [guildId],
      );
      return rows.map((r) => ({
        type: r.rule_type,
        level: (r.rule_type === 'exact' ? r.level : r.start_level) ?? 0,
        everyN: r.rule_type === 'recurring' ? (r.every_n ?? 1) : null,
        roleId: r.role_id,
        brokenReason: r.broken_reason,
      }));
    },

    /**
     * Read the previous notification time under a lock, decide, then write.
     *
     * Doing the decision in SQL would mean comparing a column against `now()`
     * inside the same statement that sets it to `now()`, which reads as clever
     * and is impossible to reason about. Two statements in a transaction are
     * obviously correct, and this runs at most once per breakage per guild.
     */
    async markRewardBroken(guildId, roleId, reason, throttleHours = 24) {
      return db.withTransaction(async (tx) => {
        const { rows } = await tx.query<{
          broken_reason: string | null;
          broken_notified_at: Date | null;
        }>(
          `SELECT broken_reason, broken_notified_at FROM role_reward
           WHERE guild_id = $1 AND role_id = $2 FOR UPDATE`,
          [guildId, roleId],
        );

        if (rows.length === 0) return { notify: false, firstSeen: false };

        const firstSeen = rows.every((r) => r.broken_reason === null);
        const lastNotified = rows.reduce<number | null>((newest, r) => {
          const at = r.broken_notified_at?.getTime() ?? null;
          return at !== null && (newest === null || at > newest) ? at : newest;
        }, null);

        const notify =
          lastNotified === null || Date.now() - lastNotified > throttleHours * 3_600_000;

        await tx.query(
          `UPDATE role_reward
           SET broken_reason = $3${notify ? ', broken_notified_at = now()' : ''}
           WHERE guild_id = $1 AND role_id = $2`,
          [guildId, roleId, reason],
        );

        // The engine's view of rewards excludes broken ones, so this changes
        // configuration and must move the version the cache keys on.
        await bumpConfigVersion(tx, guildId);
        return { notify, firstSeen };
      });
    },

    /**
     * Self-healing. An admin who moves the bot's role above a reward role, or
     * recreates a deleted one, should not also have to remember to re-add the
     * reward — the hourly health job calls this once the role works again.
     */
    async clearRewardBroken(guildId, roleId) {
      const result = await db.query(
        `UPDATE role_reward SET broken_reason = NULL, broken_notified_at = NULL
         WHERE guild_id = $1 AND role_id = $2 AND broken_reason IS NOT NULL`,
        [guildId, roleId],
      );
      if ((result.rowCount ?? 0) > 0) await bumpConfigVersion(db, guildId);
      return result.rowCount ?? 0;
    },

    async guildsWithBrokenRewards() {
      const { rows } = await db.query<{ guild_id: string }>(
        `SELECT DISTINCT guild_id FROM role_reward WHERE broken_reason IS NOT NULL`,
      );
      return rows.map((r) => r.guild_id);
    },
  };
}

async function bumpConfigVersion(db: Queryable, guildId: string): Promise<void> {
  await db.query(
    `UPDATE leveling_config SET config_version = config_version + 1, updated_at = now()
     WHERE guild_id = $1`,
    [guildId],
  );
}

// ---------------------------------------------------------------------------

export function createAuditRepository(db: Database): AuditRepository {
  return {
    async record(guildId, entry, tx) {
      const target = tx ?? db;
      await target.query(
        `INSERT INTO audit_log (guild_id, actor_id, action, target_user_id, before, after, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          guildId,
          entry.actorId ?? null,
          entry.action,
          entry.targetUserId ?? null,
          // NEVER message content — small values only (spec `06` §2.12).
          entry.before === undefined ? null : JSON.stringify(entry.before),
          entry.after === undefined ? null : JSON.stringify(entry.after),
          entry.reason?.slice(0, 200) ?? null,
        ],
      );
    },

    async recent(guildId, limit = 25) {
      return this.search(guildId, { limit });
    },

    /**
     * The audit log, filtered (roadmap M15).
     *
     * Every filter is optional and expressed as `($n IS NULL OR column = $n)`
     * rather than by concatenating a WHERE clause: one prepared statement, no
     * string building anywhere near user input, and the planner still uses
     * `audit_log_target_idx` when the target filter is supplied.
     *
     * `action` accepts a trailing dot as a prefix — `xp.` finds every `xp.*`
     * action — because "show me everything anyone did to member XP" is the
     * question, and naming all six actions is not how anyone asks it.
     */
    async search(guildId, query) {
      const action = query.action?.trim() || null;
      const prefix = action !== null && action.endsWith('.') ? action : null;

      const { rows } = await db.query<{
        actor_id: string | null;
        action: string;
        target_user_id: string | null;
        before: unknown;
        after: unknown;
        reason: string | null;
        created_at: Date;
      }>(
        `SELECT actor_id, action, target_user_id, before, after, reason, created_at
         FROM audit_log
         WHERE guild_id = $1
           AND ($2::bigint IS NULL OR target_user_id = $2::bigint)
           AND ($3::bigint IS NULL OR actor_id = $3::bigint)
           AND ($4::text   IS NULL OR action = $4::text)
           AND ($5::text   IS NULL OR action LIKE $5::text || '%')
         ORDER BY created_at DESC, id DESC
         LIMIT $6`,
        [
          guildId,
          query.targetUserId ?? null,
          query.actorId ?? null,
          prefix === null ? action : null,
          prefix,
          Math.min(Math.max(query.limit ?? 25, 1), 100),
        ],
      );

      return rows.map((r) => ({
        actorId: r.actor_id,
        action: r.action,
        targetUserId: r.target_user_id,
        before: r.before,
        after: r.after,
        reason: r.reason,
        createdAt: r.created_at,
      }));
    },

    async actions(guildId) {
      const { rows } = await db.query<{ action: string }>(
        `SELECT DISTINCT action FROM audit_log WHERE guild_id = $1 ORDER BY action`,
        [guildId],
      );
      return rows.map((r) => r.action);
    },
  };
}
