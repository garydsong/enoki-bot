import { GatewayIntentBits } from 'discord.js';

/**
 * Privileged intent handling (spec `03` §1.1).
 *
 * Discord has exactly three privileged intents. As of 11 June 2026 all three are
 * self-serve below 10,000 unique users; above that they need an application, and
 * — importantly — every app holding them must REAPPLY ONCE PER YEAR.
 *
 * That annual renewal is why MessageContent is modelled as an optional
 * capability rather than an assumption. Access can lapse on a bot that is
 * already running in production. When it does, Enoki must keep working with the
 * dependent features disabled, not crash-loop.
 */

export const PRIVILEGED_INTENTS = [
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildPresences,
] as const;

export const INTENT_NAMES: Readonly<Record<number, string>> = Object.fromEntries(
  Object.entries(GatewayIntentBits)
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => [v as number, k]),
);

export function isPrivileged(intent: GatewayIntentBits): boolean {
  return (PRIVILEGED_INTENTS as readonly GatewayIntentBits[]).includes(intent);
}

export function describeIntents(intents: readonly GatewayIntentBits[]): string[] {
  return intents.map((i) => {
    const name = INTENT_NAMES[i] ?? String(i);
    return isPrivileged(i) ? `${name} (privileged)` : name;
  });
}

/**
 * Which requested intents are privileged, so the boot log can tell an operator
 * exactly what to toggle in the Developer Portal. A `Used disallowed intents`
 * error from Discord names nothing — this is what makes it diagnosable.
 */
export function privilegedAmong(intents: readonly GatewayIntentBits[]): string[] {
  return intents.filter(isPrivileged).map((i) => INTENT_NAMES[i] ?? String(i));
}

/**
 * MessageContent is optional. This reports whether the capability is present so
 * feature code can degrade rather than assume (per-word XP mode,
 * min_message_length, the effort booster).
 */
export function hasMessageContent(intents: readonly GatewayIntentBits[]): boolean {
  return intents.includes(GatewayIntentBits.MessageContent);
}

/**
 * Discord's rejection when a requested privileged intent is not enabled is the
 * bare string "Used disallowed intents". It names neither which intent, nor
 * where to enable it, nor which application — and it arrives as a WebSocket
 * close, so the stack points into the library rather than at anything you
 * control. It is one of the most common first-run failures for a Discord bot.
 *
 * This turns it into something actionable.
 */
export function isDisallowedIntentsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /disallowed intents/i.test(message);
}

export function explainDisallowedIntents(
  requested: readonly GatewayIntentBits[],
  applicationId: string,
): string {
  const privileged = privilegedAmong(requested);

  const toggles: Record<string, string> = {
    GuildMembers: 'Server Members Intent',
    MessageContent: 'Message Content Intent',
    GuildPresences: 'Presence Intent',
  };

  const needed = privileged.map((name) => `  - ${toggles[name] ?? name}  (${name})`).join('\n');

  return (
    'Discord refused the connection: "Used disallowed intents".\n\n' +
    'Enoki requested these PRIVILEGED intents, which must be switched on for the\n' +
    'application before the gateway will accept them:\n' +
    `${needed}\n\n` +
    `Enable them here:\n` +
    `  https://discord.com/developers/applications/${applicationId}/bot\n` +
    '  -> scroll to "Privileged Gateway Intents" -> toggle on -> Save Changes\n\n' +
    'They are self-serve while the app has fewer than 10,000 unique users.\n\n' +
    'Alternatively, run without Message Content by setting ENABLE_MESSAGE_CONTENT=false\n' +
    'in .env — per-word XP mode, min_message_length and the effort booster are then\n' +
    'unavailable, but everything else works. Server Members cannot be skipped:\n' +
    'role-based restrictions, boosters and reward reconciliation all depend on it.'
  );
}
