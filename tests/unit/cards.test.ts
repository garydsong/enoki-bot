import { describe, expect, it } from 'vitest';
import {
  ALLOWED_DISCORD_CDN_HOSTS,
  avatarUrlFor,
  validateDiscordCdnUrl,
} from '../../src/modules/leveling/domain/net/discordCdn.js';
import {
  createCanvasCardRenderer,
  pickFontFamily,
} from '../../src/modules/leveling/infrastructure/rendering/canvasCardRenderer.js';
import type {
  CardSubject,
  LeaderboardCardRow,
  LeaderboardCardSubject,
} from '../../src/modules/leveling/ports/cards.js';
import { silentLogger } from '../integration/helpers/db.js';

/**
 * A background URL is an SSRF primitive: a user choosing what the server
 * fetches. These are the payloads an allowlist has to refuse, and the reason it
 * is an allowlist — every one of them defeats some blocklist somewhere.
 */
describe('background URL validation', () => {
  it('accepts Discord’s own CDN over https', () => {
    for (const host of ALLOWED_DISCORD_CDN_HOSTS) {
      const result = validateDiscordCdnUrl(`https://${host}/attachments/1/2/pic.png`);
      expect(result.ok, host).toBe(true);
    }
  });

  it('refuses plain http even on an allowed host', () => {
    // A network attacker could swap the image otherwise.
    const result = validateDiscordCdnUrl('http://cdn.discordapp.com/a/b.png');
    expect(result).toEqual({ ok: false, reason: 'not_https' });
  });

  it('refuses the loopback and link-local addresses', () => {
    for (const url of [
      'https://127.0.0.1/x.png',
      'https://localhost/x.png',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/x.png',
      'https://0.0.0.0/x.png',
      'https://10.0.0.5/x.png',
      'https://192.168.1.1/x.png',
    ]) {
      expect(validateDiscordCdnUrl(url), url).toEqual({ ok: false, reason: 'host_not_allowed' });
    }
  });

  it('refuses the encodings that defeat naive host checks', () => {
    for (const url of [
      'https://2130706433/x.png', // decimal-encoded 127.0.0.1
      'https://0x7f000001/x.png', // hex-encoded
      'https://cdn.discordapp.com.evil.test/x.png', // suffix trick
      'https://evil.test/?x=cdn.discordapp.com', // in the query
      'https://user:pass@evil.test/x.png', // credentials confuse the eye
    ]) {
      expect(validateDiscordCdnUrl(url), url).toEqual({ ok: false, reason: 'host_not_allowed' });
    }
  });

  it('is not fooled by a port or by case', () => {
    expect(validateDiscordCdnUrl('https://CDN.DiscordApp.com/a/b.png').ok).toBe(true);
    // A port on an allowed host is fine — the host is still the host.
    expect(validateDiscordCdnUrl('https://cdn.discordapp.com:443/a/b.png').ok).toBe(true);
    expect(validateDiscordCdnUrl('https://evil.test:443/a/b.png').ok).toBe(false);
  });

  it('refuses other schemes outright', () => {
    for (const url of ['file:///etc/passwd', 'ftp://cdn.discordapp.com/x', 'javascript:alert(1)']) {
      expect(validateDiscordCdnUrl(url).ok, url).toBe(false);
    }
  });

  it('refuses nonsense without throwing', () => {
    expect(validateDiscordCdnUrl('')).toEqual({ ok: false, reason: 'not_a_url' });
    expect(validateDiscordCdnUrl('not a url')).toEqual({ ok: false, reason: 'not_a_url' });
  });
});

describe('the card renderer', () => {
  const subject = (over: Partial<CardSubject> = {}): CardSubject => ({
    displayName: 'hustling',
    // Deliberately unreachable in tests: the renderer must produce a card
    // anyway, because an avatar that will not load is an everyday event.
    avatarUrl: 'https://cdn.discordapp.com/avatars/1/2.png',
    level: 7,
    rank: 3,
    rankTotal: 120,
    xpIntoLevel: 40,
    xpForNextLevel: 100,
    totalXp: 2540,
    progressRatio: 0.4,
    isMaxLevel: false,
    ...over,
  });

  const renderer = createCanvasCardRenderer({
    log: silentLogger,
    budgetMs: 4_000,
    fetchTimeoutMs: 150,
  });

  const style = { accentColor: 0x5865f2, backgroundUrl: null };

  it('finds a usable font family', () => {
    expect(pickFontFamily()).toBeTypeOf('string');
  });

  it('renders a PNG', async () => {
    const png = await renderer.render(subject(), style);
    expect(png).not.toBeNull();
    // PNG magic number — proof it is an image rather than an empty buffer.
    expect(png?.subarray(0, 4).toString('hex')).toBe('89504e47');
    expect(png!.byteLength).toBeGreaterThan(1000);
  });

  it('renders every awkward fixture without throwing', async () => {
    // A Discord display name can contain anything. Each of these has broken a
    // canvas renderer somewhere.
    const fixtures: Partial<CardSubject>[] = [
      { displayName: 'x'.repeat(120) },
      { displayName: '日本語のユーザー名です' },
      { displayName: 'مستخدم عربي' },
      { displayName: '🎉🎉🎉 party 🎉🎉🎉' },
      { displayName: '' },
      { rank: null, rankTotal: 0 },
      { rank: 99999, rankTotal: 999999, totalXp: 123456789 },
      { level: 0, xpIntoLevel: 0, progressRatio: 0 },
      { isMaxLevel: true, progressRatio: 1 },
      { progressRatio: -1 },
      { progressRatio: 5 },
    ];

    for (const over of fixtures) {
      const png = await renderer.render(subject(over), style);
      expect(png, JSON.stringify(over)).not.toBeNull();
    }
  });

  it('gives up rather than hanging when the budget is impossible', async () => {
    // Null is a NORMAL outcome — /rank falls back to the embed.
    const impatient = createCanvasCardRenderer({
      log: silentLogger,
      budgetMs: 1,
      fetchTimeoutMs: 1,
    });
    const result = await impatient.render(subject(), style);
    expect(result === null || Buffer.isBuffer(result)).toBe(true);
  });

  it('refuses a background the validator would reject, without failing the card', async () => {
    const png = await renderer.render(subject(), {
      accentColor: 0x5865f2,
      backgroundUrl: 'https://169.254.169.254/latest/meta-data/',
    });
    // The card still renders; the background is simply dropped.
    expect(png).not.toBeNull();
  });
});

/**
 * Avatar URLs are DERIVED from the snapshot in `member_xp`, never fetched.
 *
 * A leaderboard page needs up to twenty-five of them; asking Discord for
 * twenty-five members to draw one picture would be absurd. The invariant that
 * matters is the last test here: a URL this function builds must survive our
 * own allowlist, or the renderer would silently refuse every avatar it was
 * given and every board would render as grey circles.
 */
describe('deriving an avatar URL from the stored snapshot', () => {
  const USER = '265307878897549312';

  it('builds a CDN URL from a hash', () => {
    expect(avatarUrlFor(USER, 'abc123', 64)).toBe(
      `https://cdn.discordapp.com/avatars/${USER}/abc123.png?size=64`,
    );
  });

  it('asks for a PNG even for an animated avatar', () => {
    // The card is a still image, and Discord serves the first frame.
    expect(avatarUrlFor(USER, 'a_deadbeef')).toContain('.png');
  });

  it('falls back to Discord’s default when no avatar was ever set', () => {
    const url = avatarUrlFor(USER, null);
    expect(url).toMatch(/^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/);
  });

  it('computes the default bucket with BigInt, not a lossy number', () => {
    // (id >> 22) % 6 on a snowflake past 2^53 gives the wrong bucket in
    // ordinary JS arithmetic — every large id would land on the same default.
    const buckets = new Set(
      ['265307878897549312', '739621421481132032', '981234567890123456', '110000000000000000'].map(
        (id) => avatarUrlFor(id, null),
      ),
    );
    expect(buckets.size).toBeGreaterThan(1);
  });

  it('still returns a usable URL for something that is not a snowflake', () => {
    // A hand-edited row or a test fixture must not take the board down.
    expect(avatarUrlFor('not-an-id', null)).toContain('cdn.discordapp.com');
  });

  it('ALWAYS produces a URL its own allowlist accepts', () => {
    const urls = [
      avatarUrlFor(USER, 'abc123'),
      avatarUrlFor(USER, null),
      avatarUrlFor('0', null),
      avatarUrlFor('not-an-id', null),
    ];
    for (const url of urls) {
      expect(validateDiscordCdnUrl(url).ok, url).toBe(true);
    }
  });
});

describe('the leaderboard card', () => {
  const renderer = createCanvasCardRenderer({
    log: silentLogger,
    boardBudgetMs: 8_000,
    fetchTimeoutMs: 150,
  });

  const style = { accentColor: 0x5865f2, backgroundUrl: null };

  const row = (rank: number, over: Partial<LeaderboardCardRow> = {}): LeaderboardCardRow => ({
    rank,
    displayName: `member ${rank}`,
    // Unreachable in tests: the board must draw anyway, because an avatar that
    // will not load is an everyday event and ten of them is a normal page.
    avatarUrl: 'https://cdn.discordapp.com/avatars/1/2.png',
    value: `${rank * 100} XP`,
    level: 40 - rank,
    isDeparted: false,
    isViewer: false,
    ...over,
  });

  const board = (over: Partial<LeaderboardCardSubject> = {}): LeaderboardCardSubject => ({
    title: 'Test Guild',
    metricLabel: 'Total XP',
    rows: Array.from({ length: 10 }, (_, i) => row(i + 1)),
    page: 1,
    totalPages: 4,
    totalRanked: 37,
    note: null,
    ...over,
  });

  it('renders a PNG', async () => {
    const png = await renderer.renderLeaderboard(board(), style);
    expect(png?.subarray(0, 4).toString('hex')).toBe('89504e47');
    expect(png!.byteLength).toBeGreaterThan(1000);
  });

  it('grows with the number of rows and shrinks back', async () => {
    // The height is computed from the row count, so a short page must not be
    // a tall image with empty space, and a long one must not clip.
    const short = await renderer.renderLeaderboard(board({ rows: [row(1)] }), style);
    const long = await renderer.renderLeaderboard(board(), style);
    expect(short!.byteLength).toBeLessThan(long!.byteLength);
  });

  it('renders every awkward page without throwing', async () => {
    const fixtures: Partial<LeaderboardCardSubject>[] = [
      { rows: [] },
      { rows: [row(1, { displayName: 'x'.repeat(200) })] },
      { rows: [row(1, { displayName: '日本語のなまえ' })] },
      { rows: [row(1, { displayName: 'مستخدم عربي' })] },
      { rows: [row(1, { displayName: '🎉🎉🎉' })] },
      { rows: [row(1, { displayName: '' })] },
      { rows: [row(1, { isViewer: true, isDeparted: true })] },
      // Page 1,000 of a very large server.
      { rows: [row(99999, { value: '987,654,321 XP' })], page: 1000, totalPages: 1000 },
      { title: 'y'.repeat(300) },
      { note: 'departed members hidden' },
    ];

    for (const over of fixtures) {
      const png = await renderer.renderLeaderboard(board(over), style);
      expect(png, JSON.stringify(over).slice(0, 80)).not.toBeNull();
    }
  });

  it('caps the rows it will draw, whatever it is handed', async () => {
    // `leaderboard.pageSize` is clamped to 25 upstream, but a renderer that
    // trusts its caller produces a 60,000-pixel-tall PNG the first time
    // something upstream changes.
    const png = await renderer.renderLeaderboard(
      board({ rows: Array.from({ length: 500 }, (_, i) => row(i + 1)) }),
      style,
    );
    expect(png).not.toBeNull();
    expect(png!.byteLength).toBeLessThan(2_000_000);
  });

  it('gives up rather than hanging when the budget is impossible', async () => {
    const impatient = createCanvasCardRenderer({
      log: silentLogger,
      boardBudgetMs: 1,
      fetchTimeoutMs: 1,
    });
    const result = await impatient.renderLeaderboard(board(), style);
    expect(result === null || Buffer.isBuffer(result)).toBe(true);
  });

  it('drops an SSRF background without failing the board', async () => {
    const png = await renderer.renderLeaderboard(board(), {
      accentColor: 0x5865f2,
      backgroundUrl: 'https://169.254.169.254/latest/meta-data/',
    });
    expect(png).not.toBeNull();
  });
});
