import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  MessageComponentInteraction,
  RESTPostAPIApplicationCommandsJSONBody,
} from 'discord.js';
import type { Logger } from '../logging/logger.js';
import type { Database } from '../db/pool.js';

/**
 * THE PLUGIN SEAM (ADR-013, Accepted).
 *
 * The project's stated goal is "modular enough that I can continuously add
 * features trivially". That is a claim about a boundary, and a boundary that
 * only one thing has ever crossed is a boundary nobody has tested. So leveling
 * itself is a BotModule from day one — the seam is exercised by the only feature
 * that exists, and cannot silently rot.
 *
 * The core owns: the gateway connection, the command registrar, the scheduler,
 * the DB pool, logging, health. A module owns: its tables (prefixed), its
 * commands, its listeners, its jobs.
 *
 * Modules NEVER import each other. A future module needing leveling data
 * consumes a published read port, not a repository.
 */

export interface ModuleContext {
  readonly log: Logger;
  readonly db: Database;
  readonly client: Client;
}

export interface CommandDefinition {
  /** The top-level command name, used for registration diffing. */
  readonly name: string;
  /** Discord's JSON command body, from SlashCommandBuilder#toJSON(). */
  readonly data: RESTPostAPIApplicationCommandsJSONBody;
  readonly execute: (
    interaction: ChatInputCommandInteraction,
    ctx: ModuleContext,
  ) => Promise<void>;
  /**
   * Whether the handler may exceed Discord's 3-second acknowledgement window.
   * When true the framework defers before calling execute (spec `03` §4.7).
   */
  readonly defer?: boolean;
  /** Ephemeral deferral, for admin commands whose output is noise in-channel. */
  readonly ephemeral?: boolean;
  /**
   * Autocomplete for this command's options. Discord gives THREE SECONDS with
   * no deferral available, so a handler here must answer from memory — never
   * from the database or an API call.
   */
  readonly autocomplete?: (
    interaction: AutocompleteInteraction,
    ctx: ModuleContext,
  ) => Promise<void>;
}

/**
 * A handler for buttons and select menus.
 *
 * Routing is by custom-id PREFIX because a custom id is the only state Discord
 * carries back for a component: `lb:xp:2` is the whole "which board, which
 * page" state, which is why the leaderboard needs no server-side session at all
 * and keeps working across a restart.
 */
export interface ComponentHandler {
  /** Everything before the first `:` in the custom id. Must be unique. */
  readonly customIdPrefix: string;
  readonly handle: (
    interaction: MessageComponentInteraction,
    ctx: ModuleContext,
  ) => Promise<void>;
}

export interface ListenerDefinition<E extends string = string> {
  readonly event: E;
  readonly once?: boolean;
  readonly handle: (ctx: ModuleContext, ...args: unknown[]) => Promise<void> | void;
}

export interface JobDefinition {
  readonly name: string;
  /** Fixed interval in milliseconds. Calendar-aligned jobs arrive at M13. */
  readonly intervalMs: number;
  /** Skip the immediate run at startup; wait one interval first. */
  readonly skipInitialRun?: boolean;
  readonly run: (ctx: ModuleContext) => Promise<void>;
}

export interface BotModule {
  readonly name: string;
  /** Gateway intents this module requires. The union across enabled modules is
   *  what the client actually requests — least privilege by construction. */
  readonly requiredIntents: readonly GatewayIntentBits[];
  /** Absolute path to this module's migrations directory, if it owns tables. */
  readonly migrationsDir?: string;
  readonly commands?: readonly CommandDefinition[];
  readonly components?: readonly ComponentHandler[];
  readonly listeners?: readonly ListenerDefinition[];
  readonly jobs?: readonly JobDefinition[];
  /** Called once after the DB is ready and before the gateway connects. */
  readonly init?: (ctx: ModuleContext) => Promise<void>;
  /** Called on graceful shutdown, before the pool closes. */
  readonly shutdown?: (ctx: ModuleContext) => Promise<void>;
}
