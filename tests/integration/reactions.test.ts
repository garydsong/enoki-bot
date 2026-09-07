import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runMigrations } from '../../src/platform/db/migrator.js';
import { createGuildRepository } from '../../src/platform/guilds/guildRepository.js';
import { createReactionAwardRepository } from '../../src/modules/leveling/infrastructure/repositories/reactionAwardRepository.js';
import { createMemberXpRepository } from '../../src/modules/leveling/infrastructure/repositories/memberXpRepository.js';
import { createCooldownStore } from '../../src/modules/leveling/infrastructure/cache/cooldownStore.js';
import {
  createReactionService,
  type ReactionEvent,
} from '../../src/modules/leveling/application/reactionService.js';
import { XpAwarder } from '../../src/modules/leveling/application/awardXp.js';
import { DEFAULT_LEVELING_CONFIG } from '../../src/modules/leveling/domain/support/defaults.js';
import type { GuildLevelingConfig } from '../../src/modules/leveling/domain/types.js';
import type { ConfigCache } from '../../src/modules/leveling/ports/config.js';
import { createTempDatabase, postgresAvailable, silentLogger, type TempDatabase } from './helpers/db.js';

const CORE = join(import.meta.dirname, '..', '..', 'migrations');
const LEVELING = join(import.meta.dirname, '..', '..', 'src', 'modules', 'leveling', 'migrations');

const GUILD = '111111111111111111';
const MESSAGE = '999999999999999999';
const AUTHOR = '222222222222222222';
const REACTOR = '333333333333333333';

let temp: TempDatabase | null = null;
afterEach(async () => {
  await temp?.drop();
  temp = null;
});

function reactionConfig(over: Partial<GuildLevelingConfig> = {}): GuildLevelingConfig {
  const source = {
    enabled: true,
    minXp: 10,
    maxXp: 10,
    cooldownSeconds: 0,
    perEventCap: 500,
    reactionMaxPerMessage: 3,
    reactionMaxMessageAgeDays: null,
  };
  return {
    ...DEFAULT_LEVELING_CONFIG,
    enabled: true,
    sources: {
      ...DEFAULT_LEVELING_CONFIG.sources,
      reaction_add: { ...source },
      reaction_receive: { ...source },
    },
    ...over,
  };
}

async function setup(config = reactionConfig()) {
  temp = await createTempDatabase();
  await runMigrations(temp.db, [CORE, LEVELING], silentLogger);
  await createGuildRepository(temp.db).upsert(GUILD, 'Test Guild');

  const memberXp = createMemberXpRepository(temp.db);
  const configs: ConfigCache = {
    get: () => Promise.resolve(config),
    invalidate: () => {},
    clear: () => {},
    stats: { hits: 0, misses: 0, revalidations: 0 },
  };
  const awarder = new XpAwarder({
    db: temp.db,
    memberXp,
    cooldowns: createCooldownStore({ sweepIntervalMs: 0 }),
    clock: { now: () => Date.now() },
    rng: { intBetween: (min) => min },
    log: silentLogger,
  });

  const reactions = createReactionService({
    awards: createReactionAwardRepository(temp.db),
    configs,
    awarder,
    log: silentLogger,
  });

  return { db: temp.db, memberXp, reactions };
}

const event = (over: Partial<ReactionEvent> = {}): ReactionEvent => ({
  guildId: GUILD,
  messageId: MESSAGE,
  reactorId: REACTOR,
  emoji: '👍',
  reactorIsBot: false,
  reactorRoleIds: [],
  location: {
    channelId: '444444444444444444',
    parentChannelId: null,
    categoryId: null,
    isThread: false,
    isForumPost: false,
    isVoiceText: false,
  },
  messageAuthorId: AUTHOR,
  messageAuthorIsBot: false,
  messageCreatedAt: Date.now(),
  occurredAt: Date.now(),
  ...over,
});

describe.runIf(await postgresAvailable())('reaction XP', () => {
  it('credits both the reactor and the author', async () => {
    const { memberXp, reactions } = await setup();

    const outcome = await reactions.handle(event());

    expect(outcome.claimed).toBe(true);
    expect(outcome.reactorXp).toBe(10);
    expect(outcome.authorXp).toBe(10);
    expect((await memberXp.get(GUILD, REACTOR))?.totalXp).toBe(10);
    expect((await memberXp.get(GUILD, AUTHOR))?.totalXp).toBe(10);
  });

  it('records both sides in the statistics', async () => {
    const { db, reactions } = await setup();
    await reactions.handle(event());

    const { rows } = await db.query<{
      user_id: string;
      reactions_given: string;
      reactions_received: string;
    }>(`SELECT user_id, reactions_given, reactions_received FROM member_stats ORDER BY user_id`);

    expect(rows.find((r) => r.user_id === REACTOR)?.reactions_given).toBe('1');
    expect(rows.find((r) => r.user_id === AUTHOR)?.reactions_received).toBe('1');
  });
});

describe.runIf(await postgresAvailable())('the farming vectors', () => {
  it('NEVER re-earns on add / remove / re-add', async () => {
    // The whole reason reaction dedup is durable rather than in-memory: this is
    // a two-click loop anyone can run forever.
    const { memberXp, reactions } = await setup();

    await reactions.handle(event());
    const replay = await reactions.handle(event());

    expect(replay.claimed).toBe(false);
    expect(replay.skipped).toBe('duplicate');
    expect((await memberXp.get(GUILD, REACTOR))?.totalXp).toBe(10);
  });

  it('survives a restart — the dedup is in the database, not in memory', async () => {
    const { db, memberXp, reactions } = await setup();
    await reactions.handle(event());

    // A completely fresh service over the same database, as after a restart.
    const fresh = createReactionService({
      awards: createReactionAwardRepository(db),
      configs: {
        get: () => Promise.resolve(reactionConfig()),
        invalidate: () => {},
        clear: () => {},
        stats: { hits: 0, misses: 0, revalidations: 0 },
      },
      awarder: new XpAwarder({
        db,
        memberXp,
        cooldowns: createCooldownStore({ sweepIntervalMs: 0 }),
        clock: { now: () => Date.now() },
        rng: { intBetween: (min) => min },
        log: silentLogger,
      }),
      log: silentLogger,
    });

    expect((await fresh.handle(event())).skipped).toBe('duplicate');
    expect((await memberXp.get(GUILD, REACTOR))?.totalXp).toBe(10);
  });

  it('treats a different emoji as a genuinely different act', async () => {
    // Keying on the message alone would make the first reaction the only one
    // that ever counted, which is not what anyone means by "react".
    const { memberXp, reactions } = await setup();

    await reactions.handle(event({ emoji: '👍' }));
    const second = await reactions.handle(event({ emoji: '🎉' }));

    expect(second.claimed).toBe(true);
    expect((await memberXp.get(GUILD, REACTOR))?.totalXp).toBe(20);
  });

  it('caps the distinct reactors credited to the author', async () => {
    // A ring of alts reacting to one friend's message is the vector this stops.
    const { memberXp, reactions } = await setup();

    for (let i = 1; i <= 6; i++) {
      await reactions.handle(event({ reactorId: `55555555555555555${i}` }));
    }

    // Three distinct reactors credited, at 10 XP each.
    expect((await memberXp.get(GUILD, AUTHOR))?.totalXp).toBe(30);
  });

  it('still credits the REACTOR past the cap', async () => {
    // The cap protects the RECEIVING side. Someone who reacts to an already
    // popular message has done nothing wrong and still earns their own XP.
    const { memberXp, reactions } = await setup();
    const reactorIds = [1, 2, 3, 4, 5].map((n) => `66666666666666660${n}`);

    for (const reactorId of reactorIds) {
      await reactions.handle(event({ reactorId }));
    }

    // Every reactor earned, including the two beyond the cap...
    for (const reactorId of reactorIds) {
      expect((await memberXp.get(GUILD, reactorId))?.totalXp, reactorId).toBe(10);
    }
    // ...while the author was credited for only the first three.
    expect((await memberXp.get(GUILD, AUTHOR))?.totalXp).toBe(30);
  });

  it('denies a self-reaction by default', async () => {
    const { memberXp, reactions } = await setup();

    const outcome = await reactions.handle(event({ reactorId: AUTHOR }));

    expect(outcome.claimed).toBe(true); // the slot is still spent
    expect(outcome.reactorXp).toBe(0);
    expect(outcome.authorXp).toBe(0);
    expect(await memberXp.get(GUILD, AUTHOR)).toBeNull();
  });

  it('allows a self-reaction when the guild opts in', async () => {
    const { reactions } = await setup(reactionConfig({ allowSelfReactions: true }));
    const outcome = await reactions.handle(event({ reactorId: AUTHOR }));
    expect(outcome.reactorXp).toBe(10);
  });

  it('refuses a message older than the configured limit, WITHOUT spending the slot', async () => {
    // Refusing on age must not consume the dedup: the reaction never had a
    // chance to earn, and the admin may lift the limit later.
    const { reactions } = await setup(
      reactionConfig({
        sources: {
          ...reactionConfig().sources,
          reaction_receive: {
            ...reactionConfig().sources.reaction_receive,
            reactionMaxMessageAgeDays: 7,
          },
        },
      }),
    );

    const outcome = await reactions.handle(
      event({ messageCreatedAt: Date.now() - 30 * 86_400_000 }),
    );

    expect(outcome.skipped).toBe('too_old');
    expect(outcome.claimed).toBe(false);
  });

  it('spends the slot even when the award is denied', async () => {
    // Otherwise "react, get denied, remove, re-react" is a retry loop that
    // eventually lands outside the cooldown window.
    const { db, reactions } = await setup(
      reactionConfig({
        sources: {
          ...reactionConfig().sources,
          reaction_add: { ...reactionConfig().sources.reaction_add, enabled: false },
          reaction_receive: { ...reactionConfig().sources.reaction_receive, enabled: false },
        },
        // Module on, both sources off — the service still short-circuits, so
        // use a restriction instead to get a genuine engine denial.
        rules: [{ kind: 'restrict_deny', targetType: 'channel', targetId: '444444444444444444' }],
      }),
    );

    // With both sources disabled the service skips before claiming, which is
    // correct; re-enable one and deny via the restriction instead.
    const restricted = reactionConfig({
      rules: [{ kind: 'restrict_deny', targetType: 'channel', targetId: '444444444444444444' }],
    });
    const service = createReactionService({
      awards: createReactionAwardRepository(db),
      configs: {
        get: () => Promise.resolve(restricted),
        invalidate: () => {},
        clear: () => {},
        stats: { hits: 0, misses: 0, revalidations: 0 },
      },
      awarder: new XpAwarder({
        db,
        memberXp: createMemberXpRepository(db),
        cooldowns: createCooldownStore({ sweepIntervalMs: 0 }),
        clock: { now: () => Date.now() },
        rng: { intBetween: (min) => min },
        log: silentLogger,
      }),
      log: silentLogger,
    });
    void reactions;

    const first = await service.handle(event());
    expect(first.claimed).toBe(true);
    expect(first.reactorXp).toBe(0);

    // The slot is spent, so removing and re-reacting cannot retry.
    expect((await service.handle(event())).skipped).toBe('duplicate');
  });

  it('ignores a bot reactor and a bot author', async () => {
    const { memberXp, reactions } = await setup();

    expect((await reactions.handle(event({ reactorIsBot: true }))).skipped).toBe('bot');

    const botAuthored = await reactions.handle(
      event({ messageId: '888888888888888888', messageAuthorIsBot: true }),
    );
    expect(botAuthored.reactorXp).toBe(10);
    expect(botAuthored.authorXp).toBe(0);
    expect(await memberXp.get(GUILD, AUTHOR)).toBeNull();
  });

  it('credits the reactor when the author could not be resolved', async () => {
    // An uncached, deleted message. Losing the receive side is acceptable;
    // losing both would punish the reactor for the bot's cache.
    const { reactions } = await setup();

    const outcome = await reactions.handle(event({ messageAuthorId: null }));

    expect(outcome.reactorXp).toBe(10);
    expect(outcome.authorXp).toBe(0);
    // The dedup is still recorded, so the farm loop stays closed.
    expect((await reactions.handle(event({ messageAuthorId: null }))).skipped).toBe('duplicate');
  });
});

describe.runIf(await postgresAvailable())('the two cooldowns are independent', () => {
  it('reacting does not consume the author’s ability to receive', async () => {
    // Sharing a cooldown key would mean reacting to someone silently used up
    // their own receive allowance.
    const { memberXp, reactions } = await setup(
      reactionConfig({
        sources: {
          ...reactionConfig().sources,
          reaction_add: { ...reactionConfig().sources.reaction_add, cooldownSeconds: 3600 },
          reaction_receive: {
            ...reactionConfig().sources.reaction_receive,
            cooldownSeconds: 3600,
          },
        },
      }),
    );

    // A reacts to B, then B reacts to A. Each earns on both sides once.
    await reactions.handle(event({ reactorId: REACTOR, messageAuthorId: AUTHOR }));
    await reactions.handle(
      event({ messageId: '777777777777777777', reactorId: AUTHOR, messageAuthorId: REACTOR }),
    );

    // Each of them: 10 for the one they gave, 10 for the one they received.
    expect((await memberXp.get(GUILD, REACTOR))?.totalXp).toBe(20);
    expect((await memberXp.get(GUILD, AUTHOR))?.totalXp).toBe(20);
  });
});
