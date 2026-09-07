import { createCanvas, GlobalFonts, loadImage, type SKRSContext2D } from '@napi-rs/canvas';
import type { Logger } from '../../../../platform/logging/logger.js';
import { validateDiscordCdnUrl } from '../../domain/net/discordCdn.js';
import type { CardRenderer, CardStyle, CardSubject } from '../../ports/cards.js';

export type { CardRenderer, CardStyle, CardSubject } from '../../ports/cards.js';

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
  /** Bounded avatar/background cache. */
  readonly imageCacheSize?: number;
  readonly fetchTimeoutMs?: number;
  readonly maxImageBytes?: number;
}

export function createCanvasCardRenderer(options: CanvasRendererOptions): CardRenderer {
  const budgetMs = options.budgetMs ?? 2_500;
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

  return {
    async render(subject, style) {
      // The budget covers EVERYTHING — fetches, decode and draw — because the
      // member is waiting on the total, not on any one step.
      let timer: NodeJS.Timeout | undefined;
      const budget = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), budgetMs);
        timer.unref?.();
      });

      try {
        const result = await Promise.race([draw(subject, style), budget]);
        if (result === null) {
          options.log.debug({ budgetMs }, 'rank card exceeded its budget; using the embed');
        }
        return result;
      } catch (error) {
        // Never propagate: /rank must answer.
        options.log.warn({ err: error }, 'rank card render failed; using the embed');
        return null;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

// ---------------------------------------------------------------------------

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
