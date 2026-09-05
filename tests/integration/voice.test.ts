import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runMigrations } from '../../src/platform/db/migrator.js';
import { createGuildRepository } from '../../src/platform/guilds/guildRepository.js';
import { createVoiceSessionRepository } from '../../src/modules/leveling/infrastructure/repositories/voiceSessionRepository.js';
import { createMemberXpRepository } from '../../src/modules/leveling/infrastructure/repositories/memberXpRepository.js';
import { createCooldownStore } from '../../src/modules/leveling/infrastructure/cache/cooldownStore.js';
import {
  createVoiceService,
  type VoiceChannelSnapshot,
} from '../../src/modules/leveling/application/voiceService.js';
import { XpAwarder } from '../../src/modules/leveling/application/awardXp.js';
import { DEFAULT_LEVELING_CONFIG } from '../../src/modules/leveling/domain/support/defaults.js';
import type { GuildLevelingConfig } from '../../src/modules/leveling/domain/types.js';
import type { ConfigCache } from '../../src/modules/leveling/ports/config.js';
import type { VoiceMemberState } from '../../src/modules/leveling/domain/voice/eligibility.js';
import { createTempDatabase, postgresAvailable, silentLogger, type TempDatabase } from './helpers/db.js';

const CORE = join(import.meta.dirname, '..', '..', 'migrations');
const LEVELING = join(import.meta.dirname, '..', '..', 'src', 'modules', 'leveling', 'migrations');

const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const OTHER_CHANNEL = '333333333333333333';
const ALICE = '444444444444444444';
const BOB = '555555555555555555';

let temp: TempDatabase | null = null;
afterEach(async () => {
  await temp?.drop();
  temp = null;
});

/** Voice on, one other member required, a short tick so tests are not slow. */
function voiceConfig(over: Partial<GuildLevelingConfig> = {}): GuildLevelingConfig {
  return {
    ...DEFAULT_LEVELING_CONFIG,
    enabled: true,
    sources: {
      ...DEFAULT_LEVELING_CONFIG.sources,
      voice: {
        ...DEFAULT_LEVELING_CONFIG.sources.voice,
        enabled: true,
        cooldownSeconds: 0,
        minXp: 10,
        maxXp: 10,
      },
    },
    voice: { ...DEFAULT_LEVELING_CONFIG.voice, minMembers: 1, tickSeconds: 1 },
    ...over,
  };
}

async function setup(config = voiceConfig()) {
  temp = await createTempDatabase();
  await runMigrations(temp.db, [CORE, LEVELING], silentLogger);
  await createGuildRepository(temp.db).upsert(GUILD, 'Test Guild');

  const sessions = createVoiceSessionRepository(temp.db);
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

  const voice = createVoiceService({ sessions, configs, awarder, log: silentLogger });
  return { db: temp.db, sessions, memberXp, voice };
}

const member = (userId: string, over: Partial<VoiceMemberState> = {}): VoiceMemberState => ({
  userId,
  isBot: false,
  selfMute: false,
  selfDeaf: false,
  serverMute: false,
  serverDeaf: false,
  ...over,
});

const channel = (
  members: VoiceMemberState[],
  channelId = CHANNEL,
  isAfkChannel = false,
): VoiceChannelSnapshot => ({
  guildId: GUILD,
  channelId,
  isAfkChannel,
  members,
});

/** Rewind a session's watermark so a tick believes time has passed. */
async function ageWatermark(db: TempDatabase['db'], userId: string, seconds: number) {
  await db.query(
    `UPDATE voice_session
     SET last_credited_at = now() - make_interval(secs => $2)
     WHERE user_id = $1 AND ended_at IS NULL`,
    [userId, seconds],
  );
}

describe.runIf(await postgresAvailable())('the voice session state machine', () => {
  it('opens a session on join', async () => {
    const { sessions, voice } = await setup();
    await voice.onJoin(GUILD, member(ALICE), channel([member(ALICE), member(BOB)]));

    const session = await sessions.find(GUILD, ALICE);
    expect(session?.channelId).toBe(CHANNEL);
    expect(session?.isEligible).toBe(true);
  });

  it('opens an INELIGIBLE session for someone alone in a channel', async () => {
    const { sessions, voice } = await setup();
    await voice.onJoin(GUILD, member(ALICE), channel([member(ALICE)]));

    expect((await sessions.find(GUILD, ALICE))?.isEligible).toBe(false);
  });

  it('never opens two sessions for one member', async () => {
    // The partial unique index is the guarantee; a rapid re-join is the race a
    // check-then-insert would lose.
    const { db, voice } = await setup();
    const state = channel([member(ALICE), member(BOB)]);
    await voice.onJoin(GUILD, member(ALICE), state);
    await voice.onJoin(GUILD, member(ALICE), state);

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM voice_session WHERE user_id = $1 AND ended_at IS NULL`,
      [ALICE],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('closes the session on leave and credits the partial interval', async () => {
    // ADR-004's end-of-session flush: a member who leaves 2:59 into a tick is
    // not robbed of it.
    const { db, sessions, memberXp, voice } = await setup();
    await voice.onJoin(GUILD, member(ALICE), channel([member(ALICE), member(BOB)]));
    await ageWatermark(db, ALICE, 30);

    await voice.onLeave(GUILD, ALICE);

    expect(await sessions.find(GUILD, ALICE)).toBeNull();
    expect((await memberXp.get(GUILD, ALICE))?.totalXp).toBeGreaterThan(0);
  });

  it('treats a move as a mutation, preserving accrued time', async () => {
    // Closing and reopening would reset the anti-AFK timer, so hopping channels
    // every two hours would defeat it — the obvious exploit.
    //
    // A long tick here so the two-tick claim cap is not what limits the
    // measurement: the point is that accrual SURVIVES, not how much of it a
    // single claim may pay.
    const { db, sessions, voice } = await setup(
      voiceConfig({ voice: { ...DEFAULT_LEVELING_CONFIG.voice, minMembers: 1, tickSeconds: 60 } }),
    );
    await voice.onJoin(GUILD, member(ALICE), channel([member(ALICE), member(BOB)]));
    const before = await sessions.find(GUILD, ALICE);
    await ageWatermark(db, ALICE, 40);

    await voice.onMove(
      GUILD,
      member(ALICE),
      channel([member(ALICE), member(BOB)], OTHER_CHANNEL),
      CHANNEL,
    );

    const after = await sessions.find(GUILD, ALICE);
    expect(after?.id).toBe(before?.id);
    expect(after?.channelId).toBe(OTHER_CHANNEL);
    expect(after?.accruedEligibleSeconds).toBeGreaterThanOrEqual(39);
  });

  it('stops crediting when a member mutes, after paying what they earned', async () => {
    const { db, sessions, memberXp, voice } = await setup();
    await voice.onJoin(GUILD, member(ALICE), channel([member(ALICE), member(BOB)]));
    await ageWatermark(db, ALICE, 30);

    await voice.reevaluateChannel(
      channel([member(ALICE, { selfMute: true }), member(BOB)]),
    );

    expect((await sessions.find(GUILD, ALICE))?.isEligible).toBe(false);
    // Credited on the way out — clearing the flag first would have made that
    // interval unclaimable.
    expect((await memberXp.get(GUILD, ALICE))?.totalXp).toBeGreaterThan(0);
  });

  it('never credits the muted gap after unmuting', async () => {
    const { db, sessions, memberXp, voice } = await setup();
    await voice.onJoin(GUILD, member(ALICE), channel([member(ALICE), member(BOB)]));
    await voice.reevaluateChannel(channel([member(ALICE, { selfMute: true }), member(BOB)]));

    // An hour muted.
    await ageWatermark(db, ALICE, 3600);
    await voice.reevaluateChannel(channel([member(ALICE), member(BOB)]));

    const session = await sessions.find(GUILD, ALICE);
    expect(session?.isEligible).toBe(true);
    // Regaining eligibility moved the watermark, so the gap is simply gone.
    expect(Date.now() - (session?.lastCreditedAt.getTime() ?? 0)).toBeLessThan(5_000);

    const before = (await memberXp.get(GUILD, ALICE))?.totalXp ?? 0;
    await voice.tick();
    expect((await memberXp.get(GUILD, ALICE))?.totalXp ?? 0).toBe(before);
  });

  it('stops everyone earning when the channel empties to one', async () => {
    // THE SUBTLE ONE: eligibility depends on OTHER members, so one event
    // changes N sessions.
    const { sessions, voice } = await setup();
    const full = channel([member(ALICE), member(BOB)]);
    await voice.onJoin(GUILD, member(ALICE), full);
    await voice.onJoin(GUILD, member(BOB), full);
    expect((await sessions.find(GUILD, ALICE))?.isEligible).toBe(true);

    await voice.onLeave(GUILD, BOB);
    await voice.reevaluateChannel(channel([member(ALICE)]));

    expect((await sessions.find(GUILD, ALICE))?.isEligible).toBe(false);
  });

  it('starts everyone earning when a second person arrives', async () => {
    const { sessions, voice } = await setup();
    await voice.onJoin(GUILD, member(ALICE), channel([member(ALICE)]));
    expect((await sessions.find(GUILD, ALICE))?.isEligible).toBe(false);

    await voice.onJoin(GUILD, member(BOB), channel([member(ALICE), member(BOB)]));

    expect((await sessions.find(GUILD, ALICE))?.isEligible).toBe(true);
  });

  it('closes a session for someone our records say is present but is not', async () => {
    const { sessions, voice } = await setup();
    await voice.onJoin(GUILD, member(ALICE), channel([member(ALICE), member(BOB)]));

    await voice.reevaluateChannel(channel([member(BOB)]));

    expect(await sessions.find(GUILD, ALICE)).toBeNull();
  });

  it('refuses to earn in the AFK channel', async () => {
    const { sessions, voice } = await setup();
    await voice.onJoin(
      GUILD,
      member(ALICE),
      channel([member(ALICE), member(BOB)], CHANNEL, true),
    );
    expect((await sessions.find(GUILD, ALICE))?.isEligible).toBe(false);
  });

  it('ignores bots entirely', async () => {
    const { sessions, voice } = await setup();
    await voice.onJoin(GUILD, member(ALICE, { isBot: true }), channel([member(ALICE)]));
    expect(await sessions.find(GUILD, ALICE)).toBeNull();
  });
});

describe.runIf(await postgresAvailable())('crediting', () => {
  it('pays a whole tick and advances the watermark', async () => {
    const { db, memberXp, voice } = await setup();
    await voice.onJoin(GUILD, member(ALICE), channel([member(ALICE), member(BOB)]));
    await ageWatermark(db, ALICE, 5);

    const result = await voice.tick();

    expect(result.credited).toBe(1);
    expect((await memberXp.get(GUILD, ALICE))?.totalXp).toBe(10);
  });

  it('pays nothing twice, however the ticks interleave', async () => {
    // claimInterval reads and advances the watermark in ONE statement, so two
    // concurrent claims cannot both be paid for the same seconds.
    const { db, memberXp, voice } = await setup();
    await voice.onJoin(GUILD, member(ALICE), channel([member(ALICE), member(BOB)]));
    await ageWatermark(db, ALICE, 5);

    await Promise.all([voice.tick(), voice.tick(), voice.tick()]);

    expect((await memberXp.get(GUILD, ALICE))?.totalXp).toBe(10);
  });

  it('does not pay before a full tick has elapsed', async () => {
    // The cadence of the job must not set the XP rate.
    const { memberXp, voice } = await setup({ ...voiceConfig() });
    await voice.onJoin(GUILD, member(ALICE), channel([member(ALICE), member(BOB)]));

    await voice.tick();

    expect(await memberXp.get(GUILD, ALICE)).toBeNull();
  });

  it('never pays an ineligible session', async () => {
    const { db, memberXp, voice } = await setup();
    await voice.onJoin(GUILD, member(ALICE), channel([member(ALICE)]));
    await ageWatermark(db, ALICE, 60);

    await voice.tick();

    expect(await memberXp.get(GUILD, ALICE)).toBeNull();
  });

  it('caps a single claim so stale time is not paid in one lump', async () => {
    // After downtime the watermark can be hours stale. Two ticks' worth is the
    // most any single claim may pay.
    const { db, sessions, voice } = await setup();
    await voice.onJoin(GUILD, member(ALICE), channel([member(ALICE), member(BOB)]));
    await ageWatermark(db, ALICE, 10_000);

    await voice.tick();

    const session = await sessions.find(GUILD, ALICE);
    expect(session?.accruedEligibleSeconds).toBeLessThanOrEqual(2);
  });

  it('accumulates voice_seconds for the leaderboard', async () => {
    const { db, voice } = await setup();
    await voice.onJoin(GUILD, member(ALICE), channel([member(ALICE), member(BOB)]));
    await ageWatermark(db, ALICE, 2);
    await voice.tick();

    const { rows } = await db.query<{ voice_seconds: string }>(
      `SELECT voice_seconds FROM member_stats WHERE guild_id = $1 AND user_id = $2`,
      [GUILD, ALICE],
    );
    expect(Number(rows[0]?.voice_seconds)).toBeGreaterThan(0);
  });
});

describe.runIf(await postgresAvailable())('restart recovery', () => {
  it('resumes a member who is still in voice, without crediting the downtime', async () => {
    // Case 1 of spec 04 §8.6. Paying for the gap would reward crashes.
    const { db, sessions, memberXp, voice } = await setup();
    await voice.onJoin(GUILD, member(ALICE), channel([member(ALICE), member(BOB)]));
    await ageWatermark(db, ALICE, 7200); // two hours of "downtime"

    const result = await voice.reconcile([channel([member(ALICE), member(BOB)])]);

    expect(result.resumed).toBe(1);
    const session = await sessions.find(GUILD, ALICE);
    expect(session).not.toBeNull();
    expect(Date.now() - (session?.lastCreditedAt.getTime() ?? 0)).toBeLessThan(5_000);

    await voice.tick();
    expect(await memberXp.get(GUILD, ALICE)).toBeNull();
  });

  it('closes a session for someone who left while we were down', async () => {
    // Case 2, closed at the last proven-present moment rather than now().
    const { sessions, voice } = await setup();
    await voice.onJoin(GUILD, member(ALICE), channel([member(ALICE), member(BOB)]));

    const result = await voice.reconcile([channel([member(BOB)])]);

    expect(result.closed).toBe(1);
    expect(await sessions.find(GUILD, ALICE)).toBeNull();
  });

  it('opens a session for someone in voice with no record', async () => {
    // Case 3: they joined while the bot was down.
    const { sessions, voice } = await setup();

    const result = await voice.reconcile([channel([member(ALICE), member(BOB)])]);

    expect(result.opened).toBe(2);
    expect((await sessions.find(GUILD, ALICE))?.isEligible).toBe(true);
  });

  it('closes sessions whose heartbeat stopped, as crash residue', async () => {
    // Case 4. Left alone these would be resumed forever.
    const { db, sessions, voice } = await setup();
    await voice.onJoin(GUILD, member(ALICE), channel([member(ALICE), member(BOB)]));
    await db.query(
      `UPDATE voice_session SET last_heartbeat_at = now() - interval '3 hours'
       WHERE user_id = $1`,
      [ALICE],
    );

    const result = await voice.reconcile([]);

    expect(result.orphaned).toBe(1);
    expect(await sessions.find(GUILD, ALICE)).toBeNull();
  });

  it('corrects the channel of someone who moved during downtime', async () => {
    const { sessions, voice } = await setup();
    await voice.onJoin(GUILD, member(ALICE), channel([member(ALICE), member(BOB)]));

    await voice.reconcile([channel([member(ALICE), member(BOB)], OTHER_CHANNEL)]);

    expect((await sessions.find(GUILD, ALICE))?.channelId).toBe(OTHER_CHANNEL);
  });

  it('is idempotent — reconciling twice changes nothing further', async () => {
    const { sessions, voice } = await setup();
    const present = [channel([member(ALICE), member(BOB)])];

    await voice.reconcile(present);
    const second = await voice.reconcile(present);

    expect(second.opened).toBe(0);
    expect(second.closed).toBe(0);
    expect(second.resumed).toBe(2);
    expect(await sessions.countOpen()).toBe(2);
  });

  it('flushes partial credit on shutdown but leaves sessions OPEN', async () => {
    // The members are still in voice; closing them would make the next startup
    // treat a clean restart as everyone having left.
    const { db, sessions, memberXp, voice } = await setup();
    await voice.onJoin(GUILD, member(ALICE), channel([member(ALICE), member(BOB)]));
    await ageWatermark(db, ALICE, 30);

    const flushed = await voice.flushAll();

    expect(flushed).toBe(1);
    expect((await memberXp.get(GUILD, ALICE))?.totalXp).toBeGreaterThan(0);
    expect(await sessions.find(GUILD, ALICE)).not.toBeNull();
  });

  it('loses at most one tick across a restart', async () => {
    // The definition-of-done for M9, asserted end to end: flush, reconcile,
    // and carry on without double-paying or losing the session.
    const { db, memberXp, voice } = await setup();
    await voice.onJoin(GUILD, member(ALICE), channel([member(ALICE), member(BOB)]));
    await ageWatermark(db, ALICE, 60);

    await voice.flushAll(); // SIGTERM
    const afterFlush = (await memberXp.get(GUILD, ALICE))?.totalXp ?? 0;

    await voice.reconcile([channel([member(ALICE), member(BOB)])]); // restart
    await ageWatermark(db, ALICE, 2);
    await voice.tick();

    const afterResume = (await memberXp.get(GUILD, ALICE))?.totalXp ?? 0;
    expect(afterFlush).toBeGreaterThan(0);
    expect(afterResume).toBeGreaterThan(afterFlush);
  });
});
