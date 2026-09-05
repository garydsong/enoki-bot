import { GatewayIntentBits } from 'discord.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type {
  BotModule,
  CommandDefinition,
  ComponentHandler,
  JobDefinition,
  ListenerDefinition,
  ModuleContext,
} from '../../platform/plugin/types.js';
import type { Database } from '../../platform/db/pool.js';
import type { Logger } from '../../platform/logging/logger.js';
import { noopMetrics, type MetricsSink } from '../../platform/metrics/metrics.js';

import { XpAwarder } from './application/awardXp.js';
import {
  createLeaderboardService,
  type LeaderboardService,
} from './application/queries/leaderboard.js';
import { systemClock, systemRng } from './domain/support/clock.js';
import {
  createAuditRepository,
  createConfigRepository,
  createRuleRepository,
  type AuditRepository,
  type ConfigRepository,
  type RuleRepository,
} from './infrastructure/repositories/configRepository.js';
import {
  createMemberXpRepository,
  bumpStats,
  type MemberXpRepository,
} from './infrastructure/repositories/memberXpRepository.js';
import { createConfigCache, type ConfigCache } from './infrastructure/cache/configCache.js';
import { createCooldownStore } from './infrastructure/cache/cooldownStore.js';
import type { CooldownStore } from './ports/cooldowns.js';
import { createRewardReconciler, type RewardReconciler } from './adapters/effects/rewardReconciler.js';
import { createLevelUpNotifier, type LevelUpNotifier } from './adapters/effects/levelUpNotifier.js';
import { createMessageXpListener } from './adapters/listeners/messageXp.js';
import {
  createMemberLeaveListener,
  createMemberRejoinListener,
  createRoleDeleteListener,
} from './adapters/listeners/rewardLifecycle.js';
import { createRewardHealthJob } from './adapters/jobs/rewardHealth.js';
import { createRetentionJob, type RetentionOptions } from './adapters/jobs/retention.js';
import {
  createVoiceStateListener,
  createVoiceTickJob,
  currentVoiceSnapshots,
} from './adapters/listeners/voiceState.js';
import { createVoiceService, type VoiceService } from './application/voiceService.js';
import { createVoiceSessionRepository } from './infrastructure/repositories/voiceSessionRepository.js';
import { createRankCommand } from './adapters/commands/rank.js';
import {
  createLeaderboardCommand,
  createLeaderboardComponent,
} from './adapters/commands/leaderboard.js';
import { createLevelCommand } from './adapters/commands/levelAdmin.js';
import { createXpCommand } from './adapters/commands/xpAdmin.js';

/**
 * The leveling module (ADR-013).
 *
 * This file is the module's ONLY export to the outside world. The core knows
 * nothing about XP; it knows about `BotModule`. That is what makes "add a
 * feature trivially" true rather than aspirational — a new module is a new
 * folder with a file shaped like this one, and no edit to the core.
 *
 * WHY THE GETTERS BELOW. A module's commands must exist before `init` runs,
 * because the core registers them with Discord over REST before it ever
 * connects a gateway — but the services they need require the database and the
 * client, which only exist once `init` is called. Rather than smuggle a mutable
 * half-built object through the type system, each dependency bundle exposes
 * getters that resolve through `use()`. Reading one before `init` throws with a
 * clear message instead of producing `undefined` deep inside a handler.
 */

const here = dirname(fileURLToPath(import.meta.url));

interface LevelingServices {
  readonly db: Database;
  readonly log: Logger;
  readonly configRepo: ConfigRepository;
  readonly rules: RuleRepository;
  readonly audit: AuditRepository;
  readonly configs: ConfigCache;
  readonly memberXp: MemberXpRepository;
  readonly boards: LeaderboardService;
  readonly awarder: XpAwarder;
  readonly reconciler: RewardReconciler;
  readonly notifier: LevelUpNotifier;
  readonly cooldowns: CooldownStore;
  readonly voice: VoiceService;
  readonly stopSweeping: () => void;
}

export function createLevelingModule(options: {
  /** MessageContent is optional (spec `03` §1.1); it gates per-word XP mode,
   *  min_message_length and the effort booster. The bot must run without it. */
  readonly requestMessageContent: boolean;
  /** Reported by `/level debug health`. Passed in rather than imported, because
   *  a module reaching into the composition root is the coupling this design
   *  exists to prevent. */
  readonly version?: string;
  readonly metrics?: MetricsSink;
  /** Omit to keep operational data forever. */
  readonly retention?: RetentionOptions;
}): BotModule {
  const intents: GatewayIntentBits[] = [
    // Guild/channel/role caches, GUILD_CREATE and GUILD_DELETE.
    GatewayIntentBits.Guilds,
    // Message XP. Delivers message events WITHOUT content unless MessageContent
    // is also granted.
    GatewayIntentBits.GuildMessages,
    // PRIVILEGED. Reliable member role data for role restrictions and boosters,
    // plus GUILD_MEMBER_ADD for reward reconciliation on rejoin. Without it,
    // role checks read an incomplete cache and are simply wrong.
    GatewayIntentBits.GuildMembers,
    // Voice XP (M9). Also delivers the initial voice-state snapshot on
    // GUILD_CREATE, which is what makes restart recovery possible.
    GatewayIntentBits.GuildVoiceStates,
    // Reaction XP (M11).
    GatewayIntentBits.GuildMessageReactions,
  ];

  if (options.requestMessageContent) {
    intents.push(GatewayIntentBits.MessageContent);
  }

  // Deliberately absent: GuildPresences. Zero leveling value and the heaviest
  // event stream on the gateway (spec `03` §1).

  let services: LevelingServices | undefined;
  const use = (): LevelingServices => {
    if (!services) {
      throw new Error('the leveling module was used before init() ran');
    }
    return services;
  };

  // --- dependency bundles, resolved lazily (see the header) -----------------

  const rankDeps = {
    get db() {
      return use().db;
    },
    get configs() {
      return use().configs;
    },
    get reconciler() {
      return use().reconciler;
    },
  };

  const boardDeps = {
    get boards() {
      return use().boards;
    },
    get configs() {
      return use().configs;
    },
  };

  const levelDeps = {
    version: options.version ?? 'unknown',
    // Named, not numeric: this is read by a human in a health report.
    requiredIntents: intents.map((i) => GatewayIntentBits[i] ?? String(i)),
    get config() {
      return use().configRepo;
    },
    get rules() {
      return use().rules;
    },
    get audit() {
      return use().audit;
    },
    get configs() {
      return use().configs;
    },
    get db() {
      return use().db;
    },
    get cooldowns() {
      return use().cooldowns;
    },
  };

  const xpDeps = {
    get awarder() {
      return use().awarder;
    },
    get memberXp() {
      return use().memberXp;
    },
    get config() {
      return use().configRepo;
    },
    get configs() {
      return use().configs;
    },
    get audit() {
      return use().audit;
    },
  };

  const rewardLifecycleDeps = {
    get reconciler() {
      return use().reconciler;
    },
    get configs() {
      return use().configs;
    },
    get memberXp() {
      return use().memberXp;
    },
    get rules() {
      return use().rules;
    },
  };

  const voiceDeps = {
    get voice() {
      return use().voice;
    },
  };

  const messageDeps = {
    hasMessageContent: options.requestMessageContent,
    get awarder() {
      return use().awarder;
    },
    get configs() {
      return use().configs;
    },
    get memberXp() {
      return use().memberXp;
    },
  };

  const commands: CommandDefinition[] = [
    createRankCommand(rankDeps),
    createLeaderboardCommand(boardDeps),
    createLevelCommand(levelDeps),
    createXpCommand(xpDeps),
  ];

  const components: ComponentHandler[] = [createLeaderboardComponent(boardDeps)];
  const listeners: ListenerDefinition[] = [
    createMessageXpListener(messageDeps),
    // Reward roles are reconciled, never incrementally granted (ADR-007), so
    // each of these is the same convergence triggered from a different
    // direction rather than three separate code paths.
    createMemberRejoinListener(rewardLifecycleDeps),
    createMemberLeaveListener(rewardLifecycleDeps),
    createRoleDeleteListener(rewardLifecycleDeps),
    createVoiceStateListener(voiceDeps),
  ];

  const jobs: JobDefinition[] = [
    createRewardHealthJob(rewardLifecycleDeps),
    createVoiceTickJob(voiceDeps),
  ];

  if (options.retention) jobs.push(createRetentionJob(options.retention));

  return {
    name: 'leveling',
    requiredIntents: intents,
    migrationsDir: join(here, 'migrations'),
    commands,
    components,
    listeners,
    jobs,

    async init(ctx: ModuleContext) {
      services = build(ctx, options.metrics ?? noopMetrics);

      // Voice sessions must be settled against reality BEFORE the tick job can
      // run, or the first tick credits sessions belonging to members who left
      // while the process was down. GUILD_CREATE has already populated the
      // caches by the time init runs, so the snapshot is authoritative.
      ctx.client.once('ready', () => {
        void services?.voice
          .reconcile(currentVoiceSnapshots(ctx))
          .catch((err: unknown) => ctx.log.error({ err }, 'voice reconciliation failed'));
      });

      await Promise.resolve();
    },

    async shutdown(ctx: ModuleContext) {
      // Credit every open session's partial interval and leave the sessions
      // OPEN — the members are still in voice, and closing them would make the
      // next startup treat a clean restart as everyone having left.
      try {
        await services?.voice.flushAll();
      } catch (err: unknown) {
        ctx.log.error({ err }, 'voice flush on shutdown failed');
      }
      services?.stopSweeping();
      services = undefined;
    },
  };
}

/**
 * THE MODULE'S OWN COMPOSITION ROOT. Everything concrete is constructed here
 * and nowhere else, which is why every file above this one takes its
 * collaborators as parameters and can be tested without a database.
 */
function build(ctx: ModuleContext, metrics: MetricsSink): LevelingServices {
  const { db, log, client } = ctx;

  const configRepo = createConfigRepository(db);
  const rules = createRuleRepository(db);
  const audit = createAuditRepository(db);
  const configs = createConfigCache({ repository: configRepo });
  const memberXp = createMemberXpRepository(db);
  const boards = createLeaderboardService(db);
  const cooldowns = createCooldownStore();

  const awarder = new XpAwarder({
    db,
    memberXp,
    cooldowns,
    clock: systemClock,
    rng: systemRng,
    log,
    metrics,
  });

  const voiceSessions = createVoiceSessionRepository(db);
  const voice = createVoiceService({ sessions: voiceSessions, configs, awarder, log });

  const reconciler = createRewardReconciler({ client, rules, log });
  const notifier = createLevelUpNotifier({
    client,
    log,
    rankOf: (guildId, userId) => memberXp.rankOf(guildId, userId),
  });

  /**
   * THE LEVEL-UP EFFECT — ordering matters and is enforced by composing the two
   * effects into one handler rather than registering them separately.
   *
   * Roles are reconciled BEFORE the announcement so that `{earned}` can name the
   * role the member just got. Registering two independent handlers would leave
   * that ordering to the order of two lines somewhere else, which is exactly
   * the kind of coupling that breaks silently a year later.
   */
  awarder.on(async (event) => {
    if (!event.leveledUp && !event.leveledDown) return;

    const result = await reconciler.reconcile(
      event.guildId,
      event.userId,
      event.levelAfter,
      event.config,
    );

    if (result.added.length > 0 || result.removed.length > 0) {
      metrics.increment(
        'enoki_reward_role_changes_total',
        { operation: 'add' },
        result.added.length,
      );
      metrics.increment(
        'enoki_reward_role_changes_total',
        { operation: 'remove' },
        result.removed.length,
      );
    }

    if (event.leveledUp) {
      await notifier.announce(event, result.added);
      // Counted here rather than in the award transaction because a level-up is
      // a property of the TRANSITION, which is only known after the commit.
      await db
        .withTransaction((tx) =>
          bumpStats(tx, event.guildId, event.userId, { levelups: event.levelsCrossed.length }),
        )
        .catch((err: unknown) => log.warn({ err }, 'failed to record level-up statistic'));
    }
  });

  return {
    db,
    log,
    configRepo,
    rules,
    audit,
    configs,
    memberXp,
    boards,
    awarder,
    reconciler,
    notifier,
    cooldowns,
    voice,
    stopSweeping: () => cooldowns.stopSweeping(),
  };
}
