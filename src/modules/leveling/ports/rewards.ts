import type { GuildLevelingConfig, Snowflake } from '../domain/types.js';

/**
 * PORT: reward role reconciliation.
 *
 * The interface moved here in M15 for one concrete reason: `/level reward
 * backfill` is an APPLICATION use case — pace, claim, page, cancel — that needs
 * to reconcile members, and `application/` is forbidden from importing
 * `adapters/` (ESLint, spec `07` §1.2). Rather than weaken the boundary or
 * push the backfill's logic into a Discord command handler where it could not
 * be tested, the shape it depends on lives here and the Discord implementation
 * stays in `adapters/effects/rewardReconciler.ts`.
 */

export type BrokenReason =
  | 'role_deleted'
  | 'hierarchy'
  | 'missing_permission'
  | 'managed'
  | 'unassignable';

export interface ReconcileResult {
  readonly added: readonly Snowflake[];
  readonly removed: readonly Snowflake[];
  readonly broken: readonly { roleId: Snowflake; reason: BrokenReason }[];
  readonly skipped?: 'no_rules' | 'no_permission';
}

export interface ReconcileOptions {
  /**
   * Compute the diff and report it WITHOUT touching Discord or the database.
   *
   * Deliberately a flag on `reconcile` rather than a separate `preview()`: a
   * dry run that walks different code from the real thing is a dry run that can
   * lie about what the real thing will do.
   */
  readonly dryRun?: boolean;
}

export interface RewardReconciler {
  reconcile(
    guildId: string,
    userId: string,
    level: number,
    config: GuildLevelingConfig,
    options?: ReconcileOptions,
  ): Promise<ReconcileResult>;
}
