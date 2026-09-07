/**
 * PORT: rank card rendering (spec `05` §3.1).
 *
 * The core leveling system must not depend on an image renderer. `/rank` works
 * without one, the embed path is always available, and a render failure must
 * never fail the command — so this port is allowed to return null and every
 * caller has to handle it.
 */

export interface CardStyle {
  /** 0xRRGGBB. */
  readonly accentColor: number;
  /** Already validated. Null means the flat background. */
  readonly backgroundUrl: string | null;
}

export interface CardSubject {
  readonly displayName: string;
  readonly avatarUrl: string;
  readonly level: number;
  readonly rank: number | null;
  readonly rankTotal: number;
  readonly xpIntoLevel: number;
  readonly xpForNextLevel: number;
  readonly totalXp: number;
  readonly progressRatio: number;
  readonly isMaxLevel: boolean;
}

export interface LeaderboardCardRow {
  readonly rank: number;
  readonly displayName: string;
  readonly avatarUrl: string;
  /** Already formatted for the metric — "12,480 XP", "3h 20m", "level 42". */
  readonly value: string;
  /**
   * Drawn as a small pill beside the name.
   *
   * Null means "do not show it", which is what the level board itself passes:
   * a row reading `member  Lv 42 … level 42` says the same thing twice.
   */
  readonly level: number | null;
  readonly isDeparted: boolean;
  /** True for the member who ran the command, who gets their row highlighted. */
  readonly isViewer: boolean;
}

export interface LeaderboardCardSubject {
  readonly title: string;
  /** "Total XP", "Voice time" — the board being shown. */
  readonly metricLabel: string;
  readonly rows: readonly LeaderboardCardRow[];
  readonly page: number;
  readonly totalPages: number;
  readonly totalRanked: number;
  readonly note: string | null;
}

export interface CardRenderer {
  /**
   * Render a PNG, or null if it could not be produced in time.
   *
   * Null is a NORMAL outcome, not an error: a slow avatar fetch, a missing
   * font, an unreadable background. The caller falls back to the embed.
   */
  render(subject: CardSubject, style: CardStyle): Promise<Buffer | null>;

  /**
   * The same, for a page of the leaderboard.
   *
   * Shares the renderer — and therefore the font resolution, the image cache
   * and the budget — with the rank card, because the two being visually
   * consistent means they must be drawn by the same code, not by two files
   * that agree today.
   */
  renderLeaderboard(subject: LeaderboardCardSubject, style: CardStyle): Promise<Buffer | null>;
}

export interface MemberCardConfig {
  readonly accentColor: number | null;
  readonly backgroundUrl: string | null;
}

export interface CardConfigRepository {
  get(guildId: string, userId: string): Promise<MemberCardConfig | null>;
  set(guildId: string, userId: string, config: MemberCardConfig): Promise<void>;
  clear(guildId: string, userId: string): Promise<void>;
}
