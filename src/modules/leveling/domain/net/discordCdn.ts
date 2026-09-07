/**
 * Which remote hosts the bot will fetch from — PURE, and deliberately in the
 * domain.
 *
 * This is a security policy, not a rendering detail: it decides what the server
 * is willing to request on a user's say-so. Keeping it here means it is
 * unit-testable without a canvas or a network, and that every caller enforces
 * exactly the same rule — the `/card` command, the guild card setting, the
 * renderer at the moment it fetches, and `/xp import` reading an attachment.
 *
 * IT IS AN ALLOWLIST, AND THAT IS THE WHOLE POINT. A URL supplied by a user and
 * fetched by the server is an SSRF primitive. "Block private IPs" invites an
 * arms race: DNS rebinding, IPv6-mapped addresses, redirect chains,
 * decimal-encoded hosts, and a new bypass every year. Accepting only Discord's
 * own CDN removes the class of problem instead of playing it — and costs
 * nothing, because the file a member wants to use is one they were going to
 * upload to Discord anyway.
 *
 * The fetch itself must also refuse redirects, or an allowed host could bounce
 * the request somewhere else. That half lives with each fetch.
 */

const ALLOWED_HOSTS = new Set([
  'cdn.discordapp.com',
  'media.discordapp.net',
  'images-ext-1.discordapp.net',
  'images-ext-2.discordapp.net',
]);

export const ALLOWED_DISCORD_CDN_HOSTS: readonly string[] = [...ALLOWED_HOSTS];

export type DiscordCdnRejection = 'not_a_url' | 'not_https' | 'host_not_allowed';

export type DiscordCdnValidation =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: DiscordCdnRejection };

/**
 * A member's avatar URL, built from the snapshot we already store.
 *
 * The leaderboard card needs ten avatars per page and must not spend ten
 * Discord API calls to get them. `member_xp.avatar_hash` is written on every
 * award for exactly this kind of use, so the URL is derived rather than
 * fetched — which also means a member who has LEFT still renders with a face
 * instead of a hole.
 *
 * A null hash means they have never set an avatar. Discord serves a default
 * from a fixed set, indexed by `(id >> 22) % 6` under the current username
 * system — computed with BigInt because a snowflake exceeds
 * `Number.MAX_SAFE_INTEGER` and shifting it as a JS number gives the wrong
 * bucket. Both forms live on `cdn.discordapp.com`, so both pass the allowlist
 * above without a special case.
 */
export function avatarUrlFor(userId: string, avatarHash: string | null, size = 64): string {
  if (avatarHash === null || avatarHash === '') {
    let index = 0;
    try {
      index = Number((BigInt(userId) >> 22n) % 6n);
    } catch {
      // Not a snowflake (a test fixture, a hand-edited row). Any default will
      // do; refusing to draw a card over it would not.
      index = 0;
    }
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
  }

  // `a_`-prefixed hashes are animated. We ask for .png regardless: the card is
  // a still image, and Discord serves the first frame.
  return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.png?size=${size}`;
}

export function validateDiscordCdnUrl(raw: string): DiscordCdnValidation {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'not_a_url' };
  }

  // Plain http would let a network attacker swap the file, and every allowed
  // host serves https anyway.
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'not_https' };

  // `hostname` rather than `host`, so a port cannot smuggle anything, and
  // lowercased because host comparison is case-insensitive.
  if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    return { ok: false, reason: 'host_not_allowed' };
  }

  return { ok: true, url: parsed.toString() };
}
