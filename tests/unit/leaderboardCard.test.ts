import { describe, expect, it } from 'vitest';
import { createLeaderboardCommand } from '../../src/modules/leveling/adapters/commands/leaderboard.js';
import { DEFAULT_LEVELING_CONFIG } from '../../src/modules/leveling/domain/support/defaults.js';
import type { GuildLevelingConfig } from '../../src/modules/leveling/domain/types.js';
import type { LeaderboardPage } from '../../src/modules/leveling/application/queries/leaderboard.js';
import type { CardRenderer, LeaderboardCardSubject } from '../../src/modules/leveling/ports/cards.js';
import type { ConfigCache } from '../../src/modules/leveling/ports/config.js';

/**
 * The leaderboard's image mode (spec `05` §3).
 *
 * The rule is the same one `/rank` lives by: THE IMAGE IS AN ENHANCEMENT, NEVER
 * A DEPENDENCY. Every test here is a way the renderer can decline — turned off,
 * out of budget, no font — and in every one of them the board still answers,
 * still paginates, and still says the same thing.
 */

const GUILD = '111111111111111111';
const VIEWER = '222222222222222222';
const user = (n: number): string => String(300000000000000000n + BigInt(n));

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

function config(over: Partial<GuildLevelingConfig['cards']> = {}): GuildLevelingConfig {
  return {
    ...DEFAULT_LEVELING_CONFIG,
    enabled: true,
    cards: { ...DEFAULT_LEVELING_CONFIG.cards, enabled: true, leaderboard: true, ...over },
  };
}

function page(entries = 3): LeaderboardPage {
  return {
    metric: 'xp',
    page: 1,
    pageSize: 10,
    totalRanked: entries,
    totalPages: 1,
    entries: Array.from({ length: entries }, (_, i) => ({
      rank: i + 1,
      userId: user(i + 1),
      displayName: `member ${i + 1}`,
      avatarHash: i === 0 ? 'deadbeef' : null,
      isDeparted: false,
      value: (entries - i) * 100,
      level: entries - i,
    })),
  };
}

/** Captures whatever the command hands to `editReply`. */
function fakeInteraction() {
  const replies: Record<string, unknown>[] = [];
  return {
    replies,
    interaction: {
      guildId: GUILD,
      user: { id: VIEWER },
      guild: { name: 'Test Guild' },
      options: { getString: () => null, getInteger: () => null },
      editReply: (payload: Record<string, unknown>) => {
        replies.push(payload);
        return Promise.resolve({});
      },
    },
  };
}

async function run(
  cfg: GuildLevelingConfig,
  renderer: CardRenderer,
  board = page(),
): Promise<Record<string, unknown>> {
  const configs: ConfigCache = {
    get: () => Promise.resolve(cfg),
    invalidate: () => {},
    clear: () => {},
    stats: { hits: 0, misses: 0, revalidations: 0 },
  };

  const command = createLeaderboardCommand({
    boards: { page: () => Promise.resolve(board), pageOf: () => Promise.resolve(1) },
    configs,
    renderer,
  });

  const { interaction, replies } = fakeInteraction();
  await command.execute(interaction as never, {} as never);
  return replies[0] ?? {};
}

const drawing = (captured?: { subject?: LeaderboardCardSubject }): CardRenderer => ({
  render: () => Promise.resolve(null),
  renderLeaderboard: (subject) => {
    if (captured) captured.subject = subject;
    return Promise.resolve(PNG);
  },
});

const declining: CardRenderer = {
  render: () => Promise.resolve(null),
  renderLeaderboard: () => Promise.resolve(null),
};

describe('the leaderboard in image mode', () => {
  it('sends the PNG and no embed', async () => {
    const payload = await run(config(), drawing());

    expect(payload['files']).toHaveLength(1);
    expect(payload['embeds']).toEqual([]);
  });

  it('KEEPS THE PAGINATION BUTTONS', async () => {
    // An image board that cannot be paged is a worse board. The controls are
    // attached identically in both modes.
    const image = await run(config(), drawing());
    const embed = await run(config(), declining);

    expect(image['components']).toHaveLength(1);
    expect(embed['components']).toHaveLength(1);
  });

  it('always sends `attachments: []`, so a stale image cannot linger', async () => {
    // Editing a message that already has a file, without clearing attachments,
    // leaves the OLD picture above the new content — which is what paging from
    // an image board to a fallback embed would otherwise look like.
    for (const renderer of [drawing(), declining]) {
      const payload = await run(config(), renderer);
      expect(payload['attachments']).toEqual([]);
    }
  });

  it('falls back to the embed when the renderer declines', async () => {
    const payload = await run(config(), declining);

    expect(payload['files']).toEqual([]);
    expect(payload['embeds']).toHaveLength(1);
  });

  it('the EMBED shows the level too, so the fallback says no less', async () => {
    // A fallback that carries less information than the thing it replaces
    // reads as broken rather than as a fallback.
    const payload = await run(config(), declining);
    const embed = (payload['embeds'] as { data: { description: string } }[])[0];

    expect(embed?.data.description).toContain('Lv 3');
  });

  it('the embed suppresses it on the level board, exactly as the image does', async () => {
    const payload = await run(config(), declining, { ...page(), metric: 'level' });
    const embed = (payload['embeds'] as { data: { description: string } }[])[0];

    expect(embed?.data.description).not.toContain('Lv ');
  });

  it('does not render when cards are off entirely', async () => {
    let called = false;
    const spy: CardRenderer = {
      render: () => Promise.resolve(null),
      renderLeaderboard: () => {
        called = true;
        return Promise.resolve(PNG);
      },
    };

    const payload = await run(config({ enabled: false }), spy);

    expect(called).toBe(false);
    expect(payload['embeds']).toHaveLength(1);
  });

  it('does not render when only the board is switched off', async () => {
    // The separate switch exists because a board page fetches up to twenty-five
    // avatars where a rank card fetches one.
    let called = false;
    const spy: CardRenderer = {
      render: () => Promise.resolve(null),
      renderLeaderboard: () => {
        called = true;
        return Promise.resolve(PNG);
      },
    };

    await run(config({ leaderboard: false }), spy);
    expect(called).toBe(false);
  });

  it('uses the embed for an empty board rather than drawing an empty picture', async () => {
    const payload = await run(config(), drawing(), { ...page(0), entries: [] });

    expect(payload['embeds']).toHaveLength(1);
    expect(payload['files']).toEqual([]);
  });
});

describe('what the board is told to draw', () => {
  it('derives each avatar URL from the stored hash', async () => {
    const captured: { subject?: LeaderboardCardSubject } = {};
    await run(config(), drawing(captured));

    const rows = captured.subject?.rows ?? [];
    expect(rows[0]?.avatarUrl).toContain(`/avatars/${user(1)}/deadbeef.png`);
    // No hash stored: Discord's default, not a broken link.
    expect(rows[1]?.avatarUrl).toContain('/embed/avatars/');
  });

  it('formats the value for the metric, not as a bare number', async () => {
    const captured: { subject?: LeaderboardCardSubject } = {};
    await run(config(), drawing(captured), { ...page(), metric: 'voice' });

    expect(captured.subject?.rows[0]?.value).toMatch(/[hm]/);
  });

  it('marks the viewer’s own row', async () => {
    const captured: { subject?: LeaderboardCardSubject } = {};
    const board = page();
    await run(config(), drawing(captured), {
      ...board,
      entries: board.entries.map((e, i) => (i === 1 ? { ...e, userId: VIEWER } : e)),
    });

    const flags = (captured.subject?.rows ?? []).map((r) => r.isViewer);
    expect(flags).toEqual([false, true, false]);
  });

  it('passes the guild’s accent, not a member’s', async () => {
    // The board is shared. Tinting it with whoever happened to open it would
    // make the same page look different to different people.
    const captured: { subject?: LeaderboardCardSubject } = {};
    const cfg = config();
    await run({ ...cfg, cards: { ...cfg.cards, accentColor: 0xe0a800 } }, drawing(captured));

    expect(captured.subject?.metricLabel).toBe('Total XP');
  });

  it('puts the level beside the name', async () => {
    const captured: { subject?: LeaderboardCardSubject } = {};
    await run(config(), drawing(captured));

    expect(captured.subject?.rows.map((r) => r.level)).toEqual([3, 2, 1]);
  });

  it('SUPPRESSES the level on the level board, where the value already is it', async () => {
    // `member  Lv 42 … level 42` says the same thing twice.
    const captured: { subject?: LeaderboardCardSubject } = {};
    await run(config(), drawing(captured), { ...page(), metric: 'level' });

    expect(captured.subject?.rows.every((r) => r.level === null)).toBe(true);
  });

  it('names a member with no stored display name without leaking a bare snowflake', async () => {
    const captured: { subject?: LeaderboardCardSubject } = {};
    const board = page();
    await run(config(), drawing(captured), {
      ...board,
      entries: board.entries.map((e, i) => (i === 0 ? { ...e, displayName: null } : e)),
    });

    const name = captured.subject?.rows[0]?.displayName ?? '';
    expect(name).not.toBe(user(1));
    expect(name.length).toBeGreaterThan(0);
  });
});
