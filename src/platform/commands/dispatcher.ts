import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type Interaction,
  type MessageComponentInteraction,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { CommandDefinition, ComponentHandler, ModuleContext } from '../plugin/types.js';
import { noopMetrics, type MetricsSink } from '../metrics/metrics.js';

/**
 * Command dispatch: deferral, permission re-checking, and the error boundary.
 *
 * Three things this exists to guarantee, each of which is a bug class rather
 * than a nicety:
 *
 * 1. **The 3-second rule.** Discord invalidates an interaction token that is not
 *    acknowledged within 3 seconds, and the user sees "The application did not
 *    respond". Anything that might touch the database or render an image must
 *    defer FIRST. Handlers declare `defer: true` and the framework does it, so
 *    the discipline is not left to each handler author remembering.
 *
 * 2. **Permissions are re-checked server-side.** `default_member_permissions` is
 *    a UI hint that a server admin can freely override in Integrations settings.
 *    Trusting it means an admin can accidentally (or deliberately) expose /xp to
 *    everyone. Handlers that need a permission check do it themselves; this
 *    layer guarantees they are never bypassed by a framework shortcut.
 *
 * 3. **Nothing escapes.** An unhandled rejection in a command handler would take
 *    down the process. Every failure is caught, logged with a correlation ID,
 *    and reported to the user with that ID and nothing else — never a stack
 *    trace (spec `03` §4.7).
 */

export interface DispatcherOptions {
  readonly commands: readonly CommandDefinition[];
  readonly components?: readonly ComponentHandler[];
  readonly ctx: ModuleContext;
  readonly metrics?: MetricsSink;
}

export function createInteractionDispatcher(options: DispatcherOptions) {
  const byName = new Map(options.commands.map((c) => [c.name, c]));
  const byPrefix = new Map((options.components ?? []).map((c) => [c.customIdPrefix, c]));
  // Command NAMES are a closed set, so this label is safe. A guild or user id
  // here would create an unbounded number of time series.
  const metrics = options.metrics ?? noopMetrics;

  return async function dispatch(interaction: Interaction): Promise<void> {
    // Autocomplete FIRST and on its own path: Discord allows no deferral and no
    // error reply here, so it must never reach the machinery below.
    if (interaction.isAutocomplete()) {
      const command = byName.get(interaction.commandName);
      try {
        await command?.autocomplete?.(interaction, options.ctx);
      } catch (error) {
        // A failed autocomplete shows the user an empty list. That is the whole
        // consequence, so it is logged and dropped.
        options.ctx.log.warn(
          { err: error, command: interaction.commandName },
          'autocomplete failed',
        );
      }
      return;
    }

    if (interaction.isMessageComponent()) {
      await dispatchComponent(interaction, byPrefix, options.ctx);
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = byName.get(interaction.commandName);
    if (!command) {
      options.ctx.log.warn(
        { command: interaction.commandName },
        'received an interaction for an unknown command',
      );
      return;
    }

    const correlationId = randomUUID().slice(0, 8);
    const log = options.ctx.log.child({
      correlationId,
      command: interaction.commandName,
      guildId: interaction.guildId ?? undefined,
      userId: interaction.user.id,
    });

    const started = Date.now();
    try {
      if (command.defer) {
        await interaction.deferReply(
          command.ephemeral ? { flags: MessageFlags.Ephemeral } : {},
        );
      }

      await command.execute(interaction, { ...options.ctx, log });
      metrics.increment('enoki_commands_total', { command: command.name, outcome: 'ok' });
    } catch (error) {
      metrics.increment('enoki_commands_total', { command: command.name, outcome: 'error' });
      log.error({ err: error }, 'command handler failed');
      await replyWithError(interaction, correlationId).catch((replyError: unknown) => {
        log.error({ err: replyError }, 'failed to report the error to the user');
      });
    } finally {
      metrics.observe('enoki_command_duration_ms', Date.now() - started, {
        command: command.name,
      });
    }
  };
}

async function dispatchComponent(
  interaction: MessageComponentInteraction,
  byPrefix: ReadonlyMap<string, ComponentHandler>,
  ctx: ModuleContext,
): Promise<void> {
  const prefix = interaction.customId.split(':')[0] ?? '';
  const handler = byPrefix.get(prefix);
  // Not ours: almost always a component on a message from a previous version of
  // the bot. Silence is the right response — an error reply on someone else's
  // button is worse than nothing happening.
  if (!handler) return;

  const correlationId = randomUUID().slice(0, 8);
  const log = ctx.log.child({
    correlationId,
    component: interaction.customId,
    guildId: interaction.guildId ?? undefined,
    userId: interaction.user.id,
  });

  try {
    await handler.handle(interaction, { ...ctx, log });
  } catch (error) {
    log.error({ err: error }, 'component handler failed');
    await replyWithError(interaction, correlationId).catch((replyError: unknown) => {
      log.error({ err: replyError }, 'failed to report the error to the user');
    });
  }
}

async function replyWithError(
  interaction: ChatInputCommandInteraction | MessageComponentInteraction,
  correlationId: string,
): Promise<void> {
  const content =
    `Something went wrong running that command.\n` +
    `If you report this, quote \`${correlationId}\` — it identifies the failure in the logs.`;

  if (interaction.deferred) {
    await interaction.editReply({ content });
  } else if (interaction.replied) {
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
  } else {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
}
