import { getCurve } from '../curve/curve.js';
import type { GuildLevelingConfig, Snowflake } from '../types.js';

/**
 * The data `/rank` needs — plain numbers and strings, no Discord objects.
 *
 * Spec `05` §3.1: the core leveling system must not depend on the image
 * renderer. Both the embed formatter and the card renderer consume this same
 * object, and neither knows about the other. If rendering is deleted, `/rank`
 * still works.
 */
export interface RankView {
  readonly userId: Snowflake;
  readonly displayName: string;
  readonly username: string;
  readonly avatarUrl: string;
  readonly level: number;
  readonly rank: number | null;
  readonly rankTotal: number;
  readonly xpIntoLevel: number;
  readonly xpForNextLevel: number;
  readonly progressRatio: number;
  readonly totalXp: number;
  readonly isMaxLevel: boolean;
  readonly isDeparted: boolean;
}

export interface RankViewInput {
  readonly userId: Snowflake;
  readonly displayName: string;
  readonly username: string;
  readonly avatarUrl: string;
  readonly totalXp: number;
  readonly rank: number | null;
  readonly rankTotal: number;
  readonly isDeparted: boolean;
}

export function buildRankView(input: RankViewInput, config: GuildLevelingConfig): RankView {
  const progress = getCurve(config.curve).progressFor(input.totalXp);

  return {
    userId: input.userId,
    displayName: input.displayName,
    username: input.username,
    avatarUrl: input.avatarUrl,
    level: progress.level,
    // Members with zero XP are unranked, consistently (US-20 AC3).
    rank: input.totalXp > 0 ? input.rank : null,
    rankTotal: input.rankTotal,
    xpIntoLevel: progress.xpIntoLevel,
    xpForNextLevel: progress.xpForNextLevel,
    progressRatio: progress.progressRatio,
    totalXp: progress.totalXp,
    isMaxLevel: progress.isMaxLevel,
    isDeparted: input.isDeparted,
  };
}
