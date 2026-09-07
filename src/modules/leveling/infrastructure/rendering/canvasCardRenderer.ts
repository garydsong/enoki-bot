import { createCanvas, GlobalFonts, loadImage, type SKRSContext2D } from '@napi-rs/canvas';
import type { Logger } from '../../../../platform/logging/logger.js';
import { validateDiscordCdnUrl } from '../../domain/net/discordCdn.js';
import type {
  CardRenderer,
  CardStyle,
  CardSubject,
  LeaderboardCardSubject,
} from '../../ports/cards.js';

export type {
  CardRenderer,
  CardStyle,
  CardSubject,
  LeaderboardCardRow,
  LeaderboardCardSubject,
} from '../../ports/cards.js';

/**
 * Rank card rendering (spec `05` §3, roadmap M14).
 *
 * THE RULE ABOVE ALL OTHERS: rendering must never fail the command. Every path
 * here returns null rather than throwing, and `/rank` falls back to the embed —
 * a member who asks for their rank gets an answer even if the image pipeline is
 * broken, out of memory, or waiting on a CDN that is having a bad day.
 *
 * THE SECOND RULE IS THE BUDGET. Discord invalidates an interaction token after
 * three seconds without acknowledgement; the dispatcher defers, which buys
 * fifteen minutes, but a member staring at "thinking..." for eight seconds has
 * had a worse experience than an instant embed. So the whole render races a
 * timeout and loses gracefully.
 */

const WIDTH = 900;
const HEIGHT = 260;
const PADDING = 34;
const AVATAR = 152;

/** Leaderboard geometry. The width is shared, so the two sit together well. */
const BOARD_HEADER = 74;
const BOARD_ROW = 58;
const BOARD_FOOTER = 40;
/** `leaderboard.pageSize` is already clamped to 25; this is the same ceiling. */
const MAX_BOARD_ROWS = 25;
/** Horizontal breathing room inside the level pill. */
const LEVEL_PILL_PADDING = 9;

/**
 * Font families in preference order.
 *
 * Fonts are NOT bundled. @napi-rs/canvas discovers the system's fonts at
 * import, which on Windows and macOS means the good ones are already there, and
 * the Dockerfile installs DejaVu plus Noto for CJK and emoji. Bundling a
 * typeface would add a megabyte to the image and still not cover the scripts a
 * Discord display name can contain, so the list below degrades instead: it
 * picks the first family that actually exists, and the renderer bails out
 * cleanly if none do.
 */
const PREFERRED = [
  'Segoe UI',
  'Inter',
  'Helvetica Neue',
  'Arial',
  'Liberation Sans',
  'DejaVu Sans',
  'Noto Sans',
];

let resolvedFamily: string | null | undefined;

/** The first preferred family the system actually has, or null. */
export function pickFontFamily(): string | null {
  if (resolvedFamily !== undefined) return resolvedFamily;

  const available = new Set(GlobalFonts.families.map((f) => f.family));
  resolvedFamily = PREFERRED.find((family) => available.has(family)) ?? null;

  // Nothing preferred, but something exists: better an unexpected typeface than
  // no card at all.
  if (resolvedFamily === null && GlobalFonts.families.length > 0) {
    resolvedFamily = GlobalFonts.families[0]?.family ?? null;
  }
  return resolvedFamily;
}

/** Test hook — the family list is memoised. */
export function __resetFontCache(): void {
  resolvedFamily = undefined;
}

export interface CanvasRendererOptions {
  readonly log: Logger;
  /** Whole-render budget. Beyond this the embed is used instead. */
  readonly budgetMs?: number;
  /** The same, for a leaderboard page — more avatars, so more room. */
  readonly boardBudgetMs?: number;
  /** Bounded avatar/background cache. */
  readonly imageCacheSize?: number;
  readonly fetchTimeoutMs?: number;
  readonly maxImageBytes?: number;
}

export function createCanvasCardRenderer(options: CanvasRendererOptions): CardRenderer {
  const budgetMs = options.budgetMs ?? 2_500;
  const boardBudgetMs = options.boardBudgetMs ?? 5_000;
  const cacheSize = options.imageCacheSize ?? 200;
  const images = new Map<string, Buffer | null>();

  const remember = (url: string, data: Buffer | null): void => {
    images.set(url, data);
    if (images.size > cacheSize) {
      const oldest = images.keys().next().value;
      if (oldest !== undefined) images.delete(oldest);
    }
  };

  const fetchImage = async (url: string): Promise<Buffer | null> => {
    const cached = images.get(url);
    // A cached FAILURE matters as much as a cached success: a deleted avatar
    // must not be re-fetched on every /rank.
    if (cached !== undefined) return cached;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.fetchTimeoutMs ?? 1_500);

    try {
      // Re-validated at the point of use, for BOTH avatars and backgrounds.
      // Avatars come from the same CDN, so one rule covers them, and this is
      // the last gate before the process makes an outbound request — a row
      // edited by hand must not become an SSRF.
      if (!validateDiscordCdnUrl(url).ok) {
        remember(url, null);
        return null;
      }

      // `redirect: 'error'` is the second half of the allowlist: an approved
      // host must not be able to bounce us somewhere else.
      const response = await fetch(url, { signal: controller.signal, redirect: 'error' });
      if (!response.ok) {
        remember(url, null);
        return null;
      }

      const maxBytes = options.maxImageBytes ?? 8 * 1024 * 1024;
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > maxBytes) {
        remember(url, null);
        return null;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      // Checked again after the fact: content-length is a claim, not a promise.
      if (buffer.byteLength > maxBytes) {
        remember(url, null);
        return null;
      }

      remember(url, buffer);
      return buffer;
    } catch {
      remember(url, null);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const draw = async (subject: CardSubject, style: CardStyle): Promise<Buffer | null> => {
    const family = pickFontFamily();
    if (family === null) {
      options.log.warn('no usable font family; falling back to the rank embed');
      return null;
    }

    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');
    const accent = `#${style.accentColor.toString(16).padStart(6, '0')}`;

    // --- background --------------------------------------------------------
    ctx.fillStyle = '#1b1d24';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    if (style.backgroundUrl) {
      const data = await fetchImage(style.backgroundUrl);
      if (data) {
        try {
          const image = await loadImage(data);
          ctx.drawImage(image, 0, 0, WIDTH, HEIGHT);
          // A scrim, so white text stays legible over any image someone picks.
          ctx.fillStyle = 'rgba(12, 13, 17, 0.62)';
          ctx.fillRect(0, 0, WIDTH, HEIGHT);
        } catch {
          // Not a decodable image. The flat background is already drawn.
        }
      }
    }

    // --- avatar ------------------------------------------------------------
    const avatarX = PADDING;
    const avatarY = (HEIGHT - AVATAR) / 2;

    const avatarData = await fetchImage(subject.avatarUrl);
    if (avatarData) {
      try {
        const image = await loadImage(avatarData);
        ctx.save();
        ctx.beginPath();
        ctx.arc(avatarX + AVATAR / 2, avatarY + AVATAR / 2, AVATAR / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(image, avatarX, avatarY, AVATAR, AVATAR);
        ctx.restore();
      } catch {
        /* fall through to the ring alone */
      }
    }

    ctx.beginPath();
    ctx.arc(avatarX + AVATAR / 2, avatarY + AVATAR / 2, AVATAR / 2, 0, Math.PI * 2);
    ctx.lineWidth = 5;
    ctx.strokeStyle = accent;
    ctx.stroke();

    // --- text --------------------------------------------------------------
    const textX = avatarX + AVATAR + 30;
    const textWidth = WIDTH - textX - PADDING;

    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 40px "${family}"`;
    ctx.fillText(ellipsise(ctx, subject.displayName, textWidth - 200), textX, avatarY + 42);

    // Rank and level, right-aligned so a long name cannot collide with them.
    ctx.textAlign = 'right';
    ctx.font = `bold 34px "${family}"`;
    ctx.fillStyle = accent;
    ctx.fillText(`LEVEL ${subject.level}`, WIDTH - PADDING, avatarY + 42);

    ctx.font = `22px "${family}"`;
    ctx.fillStyle = '#b9bdc9';
    ctx.fillText(
      subject.rank === null ? 'unranked' : `RANK #${subject.rank} / ${subject.rankTotal}`,
      WIDTH - PADDING,
      avatarY + 74,
    );
    ctx.textAlign = 'left';

    // --- progress ----------------------------------------------------------
    const barY = avatarY + 104;
    const barHeight = 26;
    const radius = barHeight / 2;

    roundedRect(ctx, textX, barY, textWidth, barHeight, radius);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.fill();

    const filled = Math.max(
      subject.progressRatio > 0 ? barHeight : 0,
      Math.round(textWidth * clamp01(subject.progressRatio)),
    );
    if (filled > 0) {
      roundedRect(ctx, textX, barY, filled, barHeight, radius);
      ctx.fillStyle = accent;
      ctx.fill();
    }

    ctx.font = `20px "${family}"`;
    ctx.fillStyle = '#d7dae3';
    ctx.fillText(
      subject.isMaxLevel
        ? 'Max level reached'
        : `${format(subject.xpIntoLevel)} / ${format(subject.xpForNextLevel)} XP`,
      textX,
      barY + barHeight + 26,
    );

    ctx.textAlign = 'right';
    ctx.fillText(`${format(subject.totalXp)} total`, WIDTH - PADDING, barY + barHeight + 26);
    ctx.textAlign = 'left';

    return canvas.toBuffer('image/png');
  };

  /**
   * A page of the leaderboard, in the rank card's visual language.
   *
   * Same ground, same accent, same typeface, same avatar treatment — drawn by
   * the same file for exactly that reason. Two renderers that "look the same"
   * agree on the day they are written and diverge on every day after.
   *
   * The layout is a uniform ranked list. A podium for the top three would make
   * page 1 prettier and every other page a different design; a board people
   * page through should not change shape underneath them.
   */
  const drawBoard = async (
    subject: LeaderboardCardSubject,
    style: CardStyle,
  ): Promise<Buffer | null> => {
    const family = pickFontFamily();
    if (family === null) {
      options.log.warn('no usable font family; falling back to the leaderboard embed');
      return null;
    }

    const rows = subject.rows.slice(0, MAX_BOARD_ROWS);
    const height = BOARD_HEADER + rows.length * BOARD_ROW + BOARD_FOOTER;
    const canvas = createCanvas(WIDTH, height);
    const ctx = canvas.getContext('2d');
    const accent = `#${style.accentColor.toString(16).padStart(6, '0')}`;

    // --- background --------------------------------------------------------
    ctx.fillStyle = '#1b1d24';
    ctx.fillRect(0, 0, WIDTH, height);

    if (style.backgroundUrl) {
      const data = await fetchImage(style.backgroundUrl);
      if (data) {
        try {
          const image = await loadImage(data);
          ctx.drawImage(image, 0, 0, WIDTH, height);
          // Heavier than the rank card's scrim: this page carries far more
          // small text, and legibility beats the picture.
          ctx.fillStyle = 'rgba(12, 13, 17, 0.78)';
          ctx.fillRect(0, 0, WIDTH, height);
        } catch {
          /* not decodable; the flat ground is already drawn */
        }
      }
    }

    // --- avatars, all at once ----------------------------------------------
    // Ten sequential fetches would spend ten round trips of the budget one
    // after another. They are independent, so they go together; the cache
    // means a second page of the same board spends none at all.
    const avatars = await Promise.all(
      rows.map(async (row) => {
        const data = await fetchImage(row.avatarUrl);
        if (!data) return null;
        try {
          return await loadImage(data);
        } catch {
          return null;
        }
      }),
    );

    // --- header ------------------------------------------------------------
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, WIDTH, 4);

    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 30px "${family}"`;
    ctx.fillText(ellipsise(ctx, subject.title, WIDTH - PADDING * 2 - 260), PADDING, 48);

    ctx.textAlign = 'right';
    ctx.font = `bold 20px "${family}"`;
    ctx.fillStyle = accent;
    ctx.fillText(subject.metricLabel.toUpperCase(), WIDTH - PADDING, 46);
    ctx.textAlign = 'left';

    // --- rows --------------------------------------------------------------
    const avatarSize = 40;
    const rankGutter = PADDING + 52;
    const nameX = rankGutter + avatarSize + 18;

    for (const [index, row] of rows.entries()) {
      const top = BOARD_HEADER + index * BOARD_ROW;
      const middle = top + BOARD_ROW / 2;

      // The viewer's own row is tinted rather than outlined: finding yourself
      // is the single most common reason to open a leaderboard.
      if (row.isViewer) {
        roundedRect(ctx, PADDING - 10, top + 3, WIDTH - (PADDING - 10) * 2, BOARD_ROW - 6, 10);
        ctx.fillStyle = withAlpha(style.accentColor, 0.16);
        ctx.fill();
      } else if (index % 2 === 1) {
        roundedRect(ctx, PADDING - 10, top + 3, WIDTH - (PADDING - 10) * 2, BOARD_ROW - 6, 10);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.035)';
        ctx.fill();
      }

      // Rank. The top three are the accent colour — the one concession to
      // hierarchy in an otherwise uniform list.
      //
      // The size steps down for four- and five-digit ranks. Page 100 of a big
      // server is `#991`–`#1000`, and a fixed size would push those out through
      // the left padding — a case nobody sees while building and everybody with
      // a large server sees eventually.
      const rankText = `#${row.rank}`;
      const rankSize = rankText.length >= 6 ? 17 : rankText.length >= 5 ? 19 : row.rank <= 3 ? 26 : 22;
      ctx.textAlign = 'right';
      ctx.font = `bold ${rankSize}px "${family}"`;
      ctx.fillStyle = row.rank <= 3 ? accent : '#8a8fa0';
      ctx.fillText(rankText, rankGutter - 14, middle + 8);
      ctx.textAlign = 'left';

      // Avatar, clipped to a circle exactly as on the rank card.
      const avatar = avatars[index];
      const avatarY = middle - avatarSize / 2;
      if (avatar) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(rankGutter + avatarSize / 2, middle, avatarSize / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(avatar, rankGutter, avatarY, avatarSize, avatarSize);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(rankGutter + avatarSize / 2, middle, avatarSize / 2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
        ctx.fill();
      }

      if (row.rank <= 3) {
        ctx.beginPath();
        ctx.arc(rankGutter + avatarSize / 2, middle, avatarSize / 2, 0, Math.PI * 2);
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = accent;
        ctx.stroke();
      }

      // Everything to the right of the name is measured FIRST, each in its own
      // font, because the name's room is whatever the rest leaves. Measuring
      // one of them under the name's font — as this did at first — silently
      // mis-sizes the gap, and they collide on exactly the rows where it
      // matters: a long name beside a large number.
      const valueFont = `bold 22px "${family}"`;
      ctx.font = valueFont;
      const valueWidth = ctx.measureText(row.value).width;

      const levelFont = `bold 15px "${family}"`;
      const levelText = row.level === null ? null : `Lv ${format(row.level)}`;
      let levelWidth = 0;
      if (levelText !== null) {
        ctx.font = levelFont;
        levelWidth = ctx.measureText(levelText).width + LEVEL_PILL_PADDING * 2 + 10;
      }

      ctx.font = `${row.rank <= 3 ? 'bold ' : ''}23px "${family}"`;
      ctx.fillStyle = row.isDeparted ? '#7e8395' : '#ffffff';
      const nameRoom = WIDTH - PADDING - nameX - valueWidth - levelWidth - 24;
      const name = ellipsise(ctx, row.displayName, nameRoom);
      ctx.fillText(name, nameX, middle + 8);

      // The pill sits after the name AS DRAWN, not after the room reserved for
      // it — a short name should not leave the badge floating in open space.
      if (levelText !== null) {
        const nameWidth = ctx.measureText(name).width;
        const pillX = nameX + nameWidth + 10;
        ctx.font = levelFont;
        const pillWidth = ctx.measureText(levelText).width + LEVEL_PILL_PADDING * 2;

        roundedRect(ctx, pillX, middle - 12, pillWidth, 24, 12);
        // A departed member's whole row reads as muted, pill included —
        // dimming the name and leaving the badge at full accent draws the eye
        // to precisely the row that matters least.
        ctx.fillStyle = row.isDeparted
          ? 'rgba(255, 255, 255, 0.07)'
          : withAlpha(style.accentColor, 0.22);
        ctx.fill();

        ctx.fillStyle = row.isDeparted ? '#7e8395' : accent;
        ctx.fillText(levelText, pillX + LEVEL_PILL_PADDING, middle + 5);
      }

      ctx.textAlign = 'right';
      ctx.font = valueFont;
      ctx.fillStyle = row.isViewer ? '#ffffff' : '#c9cdd9';
      ctx.fillText(row.value, WIDTH - PADDING, middle + 8);
      ctx.textAlign = 'left';
    }

    // --- footer ------------------------------------------------------------
    const footerY = height - 18;
    ctx.font = `18px "${family}"`;
    ctx.fillStyle = '#7e8395';
    ctx.fillText(
      `Page ${subject.page} of ${subject.totalPages}` +
        (subject.note ? ` · ${subject.note}` : ''),
      PADDING,
      footerY,
    );

    ctx.textAlign = 'right';
    ctx.fillText(`${format(subject.totalRanked)} ranked`, WIDTH - PADDING, footerY);
    ctx.textAlign = 'left';

    return canvas.toBuffer('image/png');
  };

  /**
   * Race any draw against the budget.
   *
   * Shared by both renderers so that "the render never fails the command" is
   * one guarantee with one implementation, rather than a promise each of them
   * makes separately.
   */
  const within = async (
    what: string,
    ms: number,
    work: () => Promise<Buffer | null>,
  ): Promise<Buffer | null> => {
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
      timer.unref?.();
    });

    try {
      const result = await Promise.race([work(), budget]);
      if (result === null) {
        options.log.debug({ budgetMs: ms, what }, 'card exceeded its budget; using the embed');
      }
      return result;
    } catch (error) {
      // Never propagate: the command must answer.
      options.log.warn({ err: error, what }, 'card render failed; using the embed');
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return {
    // The budget covers EVERYTHING — fetches, decode and draw — because the
    // member is waiting on the total, not on any one step.
    render: (subject, style) => within('rank', budgetMs, () => draw(subject, style)),

    // A larger budget, because a cold page fetches up to twenty-five avatars
    // rather than one. They go in parallel, so this is not twenty-five times
    // the work — but it is not one avatar's worth either, and cutting a board
    // off at the rank card's budget would mean the first use of every board
    // falls back to the embed.
    renderLeaderboard: (subject, style) =>
      within('leaderboard', boardBudgetMs, () => drawBoard(subject, style)),
  };
}

// ---------------------------------------------------------------------------

/** `rgba()` from the stored 0xRRGGBB accent, for tints over the background. */
function withAlpha(color: number, alpha: number): string {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function format(value: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}

/**
 * Trim to fit, measuring rather than guessing a character count — a CJK name
 * and a Latin one of the same length are wildly different widths.
 */
function ellipsise(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;

  let trimmed = text;
  while (trimmed.length > 1 && ctx.measureText(`${trimmed}…`).width > maxWidth) {
    trimmed = trimmed.slice(0, -1);
  }
  return `${trimmed}…`;
}

function roundedRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
