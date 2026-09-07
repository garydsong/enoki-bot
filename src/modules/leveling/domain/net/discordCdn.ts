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
