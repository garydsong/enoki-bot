import { Events, type Client, type Guild } from 'discord.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Server } from 'node:http';

import type { Env } from '../platform/config/env.js';
import type { Logger } from '../platform/logging/logger.js';
import { createDatabase, type Database } from '../platform/db/pool.js';
import { runMigrations } from '../platform/db/migrator.js';
import { ModuleRegistry } from '../platform/plugin/registry.js';
import { createDiscordClient } from '../platform/discord/client.js';
import {
  describeIntents,
  explainDisallowedIntents,
  hasMessageContent,
  isDisallowedIntentsError,
  privilegedAmong,
} from '../platform/discord/intents.js';
import { registerCommands } from '../platform/commands/registrar.js';
import { createInteractionDispatcher } from '../platform/commands/dispatcher.js';
import { Scheduler } from '../platform/jobs/scheduler.js';
import { startHealthServer } from '../platform/http/health.js';
import { createGuildRepository } from '../platform/guilds/guildRepository.js';
import { reconcileGuilds } from '../platform/guilds/reconcile.js';
import { createKvRepository } from '../platform/state/kvRepository.js';
import { createMetrics } from '../platform/metrics/metrics.js';
import { createLevelingModule } from '../modules/leveling/index.js';
import type { ModuleContext } from '../platform/plugin/types.js';

/**
 * THE COMPOSITION ROOT — the only place concrete implementations are
 * constructed. Everything else receives its dependencies (spec `07` §1.2).
 *
 * BOOT ORDER IS LOAD-BEARING and must not be rearranged:
 *
 *   1. validate environment      fail fast, before anything connects
 *   2. connect the database
 *   3. RUN MIGRATIONS            abort boot on failure — never run the bot
 *                                against a schema it does not understand
 *   4. register commands         over REST, before the gateway
 *   5. connect the gateway       only now do we start receiving events
 *
 * Steps 3 and 5 are the ones people get backwards. A bot that logs in first and
 * migrates second will happily process events against a half-migrated schema.
 */

export const VERSION = process.env['ENOKI_VERSION'] ?? '1.0.0';
/** Set at build time so a running bot can be traced back to a commit. */
export const COMMIT = process.env['ENOKI_COMMIT'] ?? 'unknown';

export interface BootResult {
  readonly db: Database;
  readonly client: Client;
  readonly scheduler: Scheduler;
  readonly healthServer: Server;
  readonly shutdown: () => Promise<void>;
}

export async function boot(env: Env, log: Logger): Promise<BootResult> {
  // The guard is written as one condition so TypeScript narrows the optional
  // fields for the rest of the function; the list is only for the message.
  if (!env.DISCORD_TOKEN || !env.DISCORD_APPLICATION_ID || !env.DATABASE_URL) {
    const missing = [
      !env.DISCORD_TOKEN && 'DISCORD_TOKEN',
      !env.DISCORD_APPLICATION_ID && 'DISCORD_APPLICATION_ID',
      !env.DATABASE_URL && 'DATABASE_URL',
    ].filter((v): v is string => typeof v === 'string');

    // Report every missing variable at once, and say WHERE they are expected.
    // "See the README" is not actionable when the actual cause is almost always
    // a .env that was never created, or a shell running in another directory.
    throw new Error(
      `Missing required configuration: ${missing.join(', ')}.\n` +
        `Expected in ${join(process.cwd(), '.env')} — copy .env.example to .env and fill it in.\n` +
        `DISCORD_TOKEN and DISCORD_APPLICATION_ID come from the Discord Developer Portal ` +
        `(README: "Discord application setup"). ` +
        `DATABASE_URL needs \`docker compose up -d postgres\`.`,
    );
  }

  // --- metrics -------------------------------------------------------------
  const metrics = createMetrics();

  // --- modules -------------------------------------------------------------
  const registry = new ModuleRegistry();
  registry.register(
    createLevelingModule({
      requestMessageContent: env.ENABLE_MESSAGE_CONTENT,
      version: VERSION,
      metrics,
      retention: {
        auditDays: env.RETENTION_AUDIT_DAYS,
        voiceSessionDays: env.RETENTION_VOICE_SESSION_DAYS,
        periodXpDays: env.RETENTION_PERIOD_XP_DAYS,
        reactionAwardDays: env.RETENTION_REACTION_AWARD_DAYS,
      },
    }),
  );

  const intents = registry.intents();
  log.info(
    {
      modules: registry.all().map((m) => m.name),
      intents: describeIntents(intents),
      privileged: privilegedAmong(intents),
      messageContent: hasMessageContent(intents) ? 'enabled' : 'disabled',
    },
    'composed modules',
  );

  if (!hasMessageContent(intents)) {
    log.warn(
      'MessageContent intent is not requested: per-word XP mode, min_message_length ' +
        'and the effort booster will be unavailable. Everything else works normally.',
    );
  }

  // --- database ------------------------------------------------------------
  const db = createDatabase({ connectionString: env.DATABASE_URL, log });

  if (!(await db.ping())) {
    // "cannot reach the database" is true and useless. The cause is almost
    // always that Postgres simply is not running yet.
    throw new Error(
      `Cannot reach the database at ${redactDsn(env.DATABASE_URL)}.\n` +
        `Is Postgres running? Start it with:  docker compose up -d postgres\n` +
        `Then check it is accepting connections:  docker compose ps\n` +
        `If you are running Postgres yourself rather than via compose, make sure ` +
        `DATABASE_URL in .env matches its host, port, user, password and database name.`,
    );
  }

  // --- migrations (BEFORE the gateway) -------------------------------------
  const coreMigrations = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
  await runMigrations(
    db,
    // Namespaced by owner: 'core' for the platform's own tables, the module's
    // name for each module's. See MigrationSource for why the path will not do.
    [{ namespace: 'core', dir: coreMigrations }, ...registry.migrationSources()],
    log,
  );

  // --- discord client ------------------------------------------------------
  const client = createDiscordClient(intents);
  const ctx: ModuleContext = { log, db, client };

  const guilds = createGuildRepository(db);
  const kv = createKvRepository(db);

  // --- commands (over REST, before connecting) -----------------------------
  const commands = registry.commands();
  try {
    await registerCommands(commands, {
      token: env.DISCORD_TOKEN,
      applicationId: env.DISCORD_APPLICATION_ID,
      devGuildId: env.DISCORD_DEV_GUILD_ID,
      log,
      readHash: (scope) => kv.get(`commands:${scope}`),
      writeHash: (scope, hash) => kv.set(`commands:${scope}`, hash),
    });
  } catch (error) {
    // THIS IS THE FIRST CALL THE BOT EVER MAKES TO DISCORD, so it is where a
    // wrong token or a wrong application id actually surfaces — before the
    // gateway ever gets a chance to give its own error. Untranslated, discord.js
    // reports it by dumping the entire command payload (several thousand
    // characters of JSON) with a bare status code buried in it.
    throw new Error(explainCommandRegistrationFailure(error, env.DISCORD_APPLICATION_ID));
  }

  const dispatch = createInteractionDispatcher({
    commands,
    components: registry.components(),
    ctx,
    metrics,
  });
  client.on(Events.InteractionCreate, (interaction) => void dispatch(interaction));

  // --- guild lifecycle -----------------------------------------------------
  // GUILD_CREATE fires on every reconnect, not only on a real join, so this
  // must be an upsert. It is also where a rejoin within the retention window
  // restores a guild's data.
  client.on(Events.GuildCreate, (guild: Guild) => {
    void guilds
      .upsert(guild.id, guild.name)
      .then((row) =>
        log.info(
          { guildId: guild.id, name: guild.name, members: guild.memberCount },
          row.leftAt === null ? 'guild available' : 'guild rejoined',
        ),
      )
      .catch((err: unknown) => log.error({ err, guildId: guild.id }, 'guild upsert failed'));
  });

  client.on(Events.GuildDelete, (guild: Guild) => {
    // CRITICAL: `unavailable` means a Discord outage, NOT a removal. Marking
    // these inactive would eventually delete a live server's data because
    // Discord had a bad afternoon.
    if (guild.available === false) {
      log.warn({ guildId: guild.id }, 'guild unavailable (Discord outage) — not a removal');
      return;
    }
    void guilds
      .markInactive(guild.id)
      .then(() => log.info({ guildId: guild.id }, 'removed from guild; data retained'))
      .catch((err: unknown) => log.error({ err, guildId: guild.id }, 'markInactive failed'));
  });

  client.once(Events.ClientReady, (c) => {
    log.info({ tag: c.user.tag, id: c.user.id, guilds: c.guilds.cache.size }, 'gateway ready');

    // Reconcile on ready, NOT on guildCreate alone. discord.js emits
    // guildCreate only once ws.status is Ready, so guilds the bot was already
    // in never fire it — without this they would have no `guild` row at all,
    // and every guild-scoped write for them would fail on a foreign key.
    void reconcileGuilds(
      guilds,
      c.guilds.cache.map((g) => ({ id: g.id, name: g.name, available: g.available })),
      log,
    )
      .then((result) =>
        log.info(
          {
            seen: result.seen,
            upserted: result.upserted,
            markedInactive: result.markedInactive.length,
          },
          'guilds reconciled',
        ),
      )
      .catch((err: unknown) => log.error({ err }, 'guild reconciliation failed'));
  });

  // A guild that was unavailable during a Discord outage coming back.
  client.on(Events.GuildAvailable, (guild: Guild) => {
    void guilds
      .upsert(guild.id, guild.name)
      .catch((err: unknown) => log.error({ err, guildId: guild.id }, 'guild upsert failed'));
  });

  client.on(Events.Error, (err) => log.error({ err }, 'discord client error'));
  client.on(Events.ShardDisconnect, (_e, id) => log.warn({ shard: id }, 'shard disconnected'));
  client.on(Events.ShardReconnecting, (id) => log.info({ shard: id }, 'shard reconnecting'));
  client.on(Events.ShardResume, (id) => log.info({ shard: id }, 'shard resumed'));

  // --- module init ---------------------------------------------------------
  for (const module of registry.all()) {
    await module.init?.(ctx);
    for (const listener of module.listeners ?? []) {
      // EVERY listener gets its own error boundary. discord.js calls these
      // synchronously and ignores the returned promise, so a rejection here —
      // a database blip during a messageCreate, say — would surface as an
      // unhandled rejection with no context about which listener produced it.
      // A gateway event failing must never take the process down (NFR-11).
      const handler = (...args: unknown[]): void => {
        void (async () => {
          try {
            await listener.handle(ctx, ...args);
          } catch (error) {
            log.error(
              { err: error, module: module.name, event: listener.event },
              'listener failed',
            );
          }
        })();
      };
      if (listener.once) client.once(listener.event, handler);
      else client.on(listener.event, handler);
    }
  }

  // --- scheduler -----------------------------------------------------------
  const scheduler = new Scheduler({ db, log, ctx, metrics });
  for (const { job } of registry.jobs()) scheduler.add(job);

  // --- health --------------------------------------------------------------
  const healthServer = startHealthServer({
    port: env.HTTP_PORT,
    db,
    client,
    log,
    version: VERSION,
    metrics,
  });

  // --- connect (LAST) ------------------------------------------------------
  try {
    await client.login(env.DISCORD_TOKEN);
  } catch (error) {
    // Two failures dominate first runs, and Discord's messages for both are
    // famously unhelpful. Translate them rather than letting a WebSocket close
    // event surface as the whole explanation.
    if (isDisallowedIntentsError(error)) {
      throw new Error(explainDisallowedIntents(intents, env.DISCORD_APPLICATION_ID));
    }
    if (error instanceof Error && /token|unauthorized|401/i.test(error.message)) {
      throw new Error(
        'Discord rejected the bot token.\n' +
          `Reset it at https://discord.com/developers/applications/${env.DISCORD_APPLICATION_ID}/bot ` +
          'and put the new value in .env as DISCORD_TOKEN.\n' +
          'Note this is the BOT TOKEN, not the application id, the public key or the client secret.',
      );
    }
    throw error;
  }
  scheduler.start();

  const shutdown = async (): Promise<void> => {
    await scheduler.stop();
    for (const module of registry.all()) {
      try {
        await module.shutdown?.(ctx);
      } catch (err: unknown) {
        log.error({ err, module: module.name }, 'module shutdown failed');
      }
    }
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    await client.destroy();
    await db.close();
  };

  return { db, client, scheduler, healthServer, shutdown };
}

/**
 * Turn a REST failure during command registration into something actionable.
 *
 * Exported for testing: the three cases below are the three ways a first run
 * goes wrong, and each one has a different fix.
 */
export function explainCommandRegistrationFailure(
  error: unknown,
  applicationId: string,
): string {
  const status = (error as { status?: number } | null)?.status;
  const portal = `https://discord.com/developers/applications/${applicationId}`;

  if (status === 401) {
    return (
      'Discord rejected the bot token while registering slash commands.\n' +
      `Reset it at ${portal}/bot and put the new value in .env as DISCORD_TOKEN.\n` +
      'Note this is the BOT TOKEN, not the application id, the public key or the client secret.'
    );
  }

  if (status === 403) {
    return (
      'Discord refused to register slash commands for this application (403).\n' +
      'Two causes account for almost all of these:\n' +
      `  1. DISCORD_APPLICATION_ID does not match the token's application. Both are on ${portal}.\n` +
      '  2. The bot was invited without the `applications.commands` scope. Re-invite it using ' +
      'the URL in the README — an invite missing that scope can never register commands.'
    );
  }

  if (status === 404) {
    return (
      `No Discord application exists with id ${applicationId} (404).\n` +
      'Check DISCORD_APPLICATION_ID in .env against the "Application ID" on ' +
      `${portal}/information.`
    );
  }

  // A malformed command definition. Discord names the offending JSON path, and
  // that path is the only useful part of an otherwise enormous error.
  if (status === 400) {
    const detail = JSON.stringify((error as { rawError?: unknown }).rawError ?? {}).slice(0, 600);
    return (
      'Discord rejected the slash command definitions as invalid (400).\n' +
      'This is a bug in the bot, not in your setup. Please report it with this detail:\n' +
      detail
    );
  }

  return `Failed to register slash commands: ${
    error instanceof Error ? error.message : String(error)
  }`;
}

function redactDsn(dsn: string): string {
  return dsn.replace(/\/\/[^@]*@/, '//***@');
}
