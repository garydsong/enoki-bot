import { describe, expect, it } from 'vitest';
import {
  ALLOWED_DISCORD_CDN_HOSTS,
  validateDiscordCdnUrl,
} from '../../src/modules/leveling/domain/net/discordCdn.js';
import {
  createCanvasCardRenderer,
  pickFontFamily,
} from '../../src/modules/leveling/infrastructure/rendering/canvasCardRenderer.js';
import type { CardSubject } from '../../src/modules/leveling/ports/cards.js';
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
