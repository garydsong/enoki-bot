import { REST, Routes, type RESTPostAPIApplicationCommandsJSONBody } from 'discord.js';
import { createHash } from 'node:crypto';
import type { Logger } from '../logging/logger.js';
import type { CommandDefinition } from '../plugin/types.js';

/**
 * Slash command registration with diffing.
 *
 * Re-uploading an unchanged command set on every boot is not free: it burns a
 * heavily-limited rate bucket (200 global command creates per day), and during
 * development — where restarts are constant — it is the fastest way to get
 * rate-limited out of your own bot.
 *
 * So we hash the payload, store the hash, and skip the upload when nothing
 * changed. The hash lives in the database rather than memory so a restart
 * doesn't defeat it.
 *
 * Guild-scoped registration (DISCORD_DEV_GUILD_ID) applies instantly; global
 * registration takes up to an hour to propagate. Development uses the former.
 */

export interface RegistrarOptions {
  readonly token: string;
  readonly applicationId: string;
  readonly devGuildId?: string | undefined;
  readonly log: Logger;
  /** Reads the last-registered hash. Returns null when never registered. */
  readonly readHash: (scope: string) => Promise<string | null>;
  readonly writeHash: (scope: string, hash: string) => Promise<void>;
}

export function commandSetHash(bodies: readonly RESTPostAPIApplicationCommandsJSONBody[]): string {
  // Sort by name so a reordering in code is not treated as a change.
  const stable = [...bodies].sort((a, b) => a.name.localeCompare(b.name));
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 32);
}

export interface RegistrationResult {
  readonly action: 'registered' | 'skipped';
  readonly scope: string;
  readonly count: number;
}

export async function registerCommands(
  commands: readonly CommandDefinition[],
  options: RegistrarOptions,
): Promise<RegistrationResult> {
  const bodies = commands.map((c) => c.data);
  const scope = options.devGuildId ? `guild:${options.devGuildId}` : 'global';
  const hash = commandSetHash(bodies);

  const previous = await options.readHash(scope);
  if (previous === hash) {
    options.log.info({ scope, count: bodies.length }, 'command set unchanged, skipping upload');
    return { action: 'skipped', scope, count: bodies.length };
  }

  const rest = new REST({ version: '10' }).setToken(options.token);
  const route = options.devGuildId
    ? Routes.applicationGuildCommands(options.applicationId, options.devGuildId)
    : Routes.applicationCommands(options.applicationId);

  await rest.put(route, { body: bodies });
  await options.writeHash(scope, hash);

  options.log.info(
    { scope, count: bodies.length, commands: bodies.map((b) => b.name) },
    'registered commands',
  );
  return { action: 'registered', scope, count: bodies.length };
}
