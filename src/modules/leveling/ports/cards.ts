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

export interface CardRenderer {
  /**
   * Render a PNG, or null if it could not be produced in time.
   *
   * Null is a NORMAL outcome, not an error: a slow avatar fetch, a missing
   * font, an unreadable background. The caller falls back to the embed.
   */
  render(subject: CardSubject, style: CardStyle): Promise<Buffer | null>;
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
