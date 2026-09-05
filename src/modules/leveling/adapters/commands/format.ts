/**
 * Presentation helpers shared by every command in this module.
 *
 * Kept separate from the queries so that the image-card renderer (M12) can
 * replace the *rendering* without touching a single query, and so the numbers
 * on `/rank` and `/leaderboard` are formatted by the same code and cannot
 * disagree about what "12,345" looks like.
 */

const NUMBER = new Intl.NumberFormat('en-US');

export function formatNumber(value: number): string {
  return NUMBER.format(Math.round(value));
}

/**
 * A text progress bar. Uses block characters rather than emoji: emoji render at
 * different widths per platform, so an emoji bar is ragged on mobile.
 */
export function progressBar(ratio: number, width = 16): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0 && minutes === 0) return `${seconds}s`;
  if (hours === 0) return `${minutes}m`;
  return `${formatNumber(hours)}h ${minutes}m`;
}

/** 1st, 2nd, 3rd... Medals for the top three, because people look for them. */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${formatNumber(n)}th`;
  switch (n % 10) {
    case 1:
      return `${formatNumber(n)}st`;
    case 2:
      return `${formatNumber(n)}nd`;
    case 3:
      return `${formatNumber(n)}rd`;
    default:
      return `${formatNumber(n)}th`;
  }
}

export function rankBadge(rank: number): string {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `\`#${String(rank).padStart(2, ' ')}\``;
}

/**
 * Strip formatting from a name pulled out of the database.
 *
 * A member called `**everyone**` or `[click](https://evil)` would otherwise
 * inject markdown into the leaderboard. Mentions are rendered as mentions
 * elsewhere — this is for the plain-text name column.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_~`|>[\]()])/g, '\\$1');
}
