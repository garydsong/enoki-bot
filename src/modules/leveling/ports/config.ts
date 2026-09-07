import type { Queryable } from '../../../platform/db/pool.js';
import type { GuildLevelingConfig, PassiveXpSource, XpRule } from '../domain/types.js';

/**
 * PORTS: guild configuration, rules, rewards, audit and the config cache.
 *
 * Same reasoning as `memberXp.ts` — the command handlers in `adapters/` need
 * these shapes and are forbidden from importing the Postgres implementations.
 */

export interface LoadedConfig {
  readonly config: GuildLevelingConfig;
  readonly version: number;
}

export interface ConfigRepository {
  /** Creates the config and default source rows if they do not exist. */
  ensure(guildId: string): Promise<void>;
  load(guildId: string): Promise<LoadedConfig>;
  /** Current version only — a cheap check for cache validity. */
  version(guildId: string): Promise<number>;
  /**
   * Patch scalar settings. Bumps config_version, which invalidates the cache.
   *
   * `patch` keys are COLUMN NAMES interpolated into SQL, because an identifier
   * cannot be parameterised. Callers must resolve them through the setting
   * registry (`application/settings/registry.ts`), which is the whitelist.
   */
  update(
    guildId: string,
    patch: Readonly<Record<string, unknown>>,
    actorId?: string | null,
  ): Promise<number>;
  updateSource(
    guildId: string,
    source: PassiveXpSource,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<void>;
  resetToDefaults(guildId: string): Promise<void>;
}

export interface RewardListEntry {
  readonly type: 'exact' | 'recurring';
  /** The level for an exact rule; the FIRST qualifying level for a recurring one. */
  readonly level: number;
  /** Recurring only: the step between iterations. */
  readonly everyN: number | null;
  readonly roleId: string;
  readonly brokenReason: string | null;
}

/**
 * The outcome of recording a reward breakage.
 *
 * `notify` is throttled deliberately. A broken reward is re-discovered on every
 * single level-up in the guild, so an unthrottled warning is one log line (or
 * one admin ping) per message — the failure mode where the alerting is worse
 * than the fault.
 */
export interface BreakageRecord {
  readonly notify: boolean;
  readonly firstSeen: boolean;
}

export interface RuleRepository {
  addRule(guildId: string, rule: XpRule, createdBy?: string | null): Promise<void>;
  removeRule(
    guildId: string,
    kind: XpRule['kind'],
    targetType: XpRule['targetType'],
    targetId: string | null,
  ): Promise<number>;
  clearRules(guildId: string, kind?: XpRule['kind']): Promise<number>;
  addReward(
    guildId: string,
    level: number,
    roleId: string,
    createdBy?: string | null,
  ): Promise<void>;
  /**
   * "Grant this role at `startLevel`, and again every `everyN` levels."
   *
   * The same role each time, so the member simply holds it from `startLevel`
   * onwards — the step only decides where the rule ranks under `highest`
   * stacking. Kept separate from `addReward` because the two rule shapes have
   * different unique indexes and neither can be expressed as the other.
   */
  addRecurringReward(
    guildId: string,
    everyN: number,
    startLevel: number,
    roleId: string,
    createdBy?: string | null,
  ): Promise<void>;
  removeReward(guildId: string, level: number, roleId?: string): Promise<number>;
  /** Remove recurring rules for a role (all of them when `roleId` is omitted). */
  removeRecurringReward(guildId: string, roleId?: string): Promise<number>;
  listRewards(guildId: string): Promise<RewardListEntry[]>;
  /** Record a breakage. Notification is throttled — see BreakageRecord. */
  markRewardBroken(
    guildId: string,
    roleId: string,
    reason: string,
    throttleHours?: number,
  ): Promise<BreakageRecord>;
  /** The role works again. Clears the reason so the engine offers it once more. */
  clearRewardBroken(guildId: string, roleId: string): Promise<number>;
  /** Every guild that currently has a broken reward — drives the health job. */
  guildsWithBrokenRewards(): Promise<string[]>;
}

export interface AuditEntry {
  readonly actorId?: string | null;
  readonly action: string;
  readonly targetUserId?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly reason?: string | null;
  /** Set on reads; ignored on writes, where the database supplies it. */
  readonly createdAt?: Date | null;
}

/**
 * What to look for in the audit log.
 *
 * The filters exist because the log is only useful once it is long. "Who has
 * been giving XP to this one member?" is the question an admin actually asks,
 * and answering it by paging through everything is not answering it.
 */
export interface AuditQuery {
  /** The member the entry is ABOUT. */
  readonly targetUserId?: string | null;
  /** Who performed it. */
  readonly actorId?: string | null;
  /** Exact action, or a `prefix.` — `xp.` matches `xp.add`, `xp.set`, … */
  readonly action?: string | null;
  readonly limit?: number;
}

export interface AuditRepository {
  record(guildId: string, entry: AuditEntry, tx?: Queryable): Promise<void>;
  recent(guildId: string, limit?: number): Promise<AuditEntry[]>;
  search(guildId: string, query: AuditQuery): Promise<AuditEntry[]>;
  /** Distinct action names seen in this guild, for autocomplete. */
  actions(guildId: string): Promise<string[]>;
}

/**
 * The read-through cache the hot path uses. `invalidate` must be called on the
 * same code path as every write — the version check inside the cache is a
 * safety net, not the mechanism.
 */
export interface ConfigCache {
  get(guildId: string): Promise<GuildLevelingConfig>;
  invalidate(guildId: string): void;
  clear(): void;
  readonly stats: { hits: number; misses: number; revalidations: number };
}
