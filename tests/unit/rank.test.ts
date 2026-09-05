import { describe, expect, it } from 'vitest';
import { buildRankView } from '../../src/modules/leveling/domain/rank/view.js';
import { DEFAULT_LEVELING_CONFIG } from '../../src/modules/leveling/domain/support/defaults.js';
import type { GuildLevelingConfig } from '../../src/modules/leveling/domain/types.js';

const config: GuildLevelingConfig = { ...DEFAULT_LEVELING_CONFIG, enabled: true };

const input = (over: Partial<Parameters<typeof buildRankView>[0]> = {}) => ({
  userId: 'u1',
  displayName: 'Gary',
  username: 'gary',
  avatarUrl: 'https://cdn.example/avatar.png',
  totalXp: 5250,
  rank: 3,
  rankTotal: 120,
  isDeparted: false,
  ...over,
});

describe('rank view', () => {
  it('derives level and progress from total XP alone', () => {
    const v = buildRankView(input(), config);
    expect(v.level).toBe(10);
    expect(v.xpIntoLevel).toBe(0);
    expect(v.xpForNextLevel).toBe(1075);
    expect(v.totalXp).toBe(5250);
  });

  it('carries no Discord objects — only plain data', () => {
    const v = buildRankView(input(), config);
    for (const value of Object.values(v)) {
      expect(['string', 'number', 'boolean', 'object']).toContain(typeof value);
    }
    expect(JSON.parse(JSON.stringify(v))).toEqual(v);
  });

  it('marks a zero-XP member as unranked (US-20 AC3)', () => {
    const v = buildRankView(input({ totalXp: 0, rank: 99 }), config);
    expect(v.rank).toBeNull();
    expect(v.level).toBe(0);
  });

  it('keeps the rank for anyone with XP', () => {
    expect(buildRankView(input({ totalXp: 1, rank: 42 }), config).rank).toBe(42);
  });

  it('flags a departed member without losing their data', () => {
    const v = buildRankView(input({ isDeparted: true }), config);
    expect(v.isDeparted).toBe(true);
    expect(v.displayName).toBe('Gary');
  });

  it('reports max level when the curve is capped', () => {
    const capped: GuildLevelingConfig = {
      ...config,
      curve: { ...config.curve, maxLevel: 5 },
    };
    const v = buildRankView(input({ totalXp: 999_999 }), capped);
    expect(v.isMaxLevel).toBe(true);
    expect(v.level).toBe(5);
    expect(v.progressRatio).toBe(1);
  });

  it('renders correctly for awkward display names', () => {
    for (const name of ['日本語のなまえ', 'اسم عربي', '🎉🎉🎉', 'a'.repeat(300), '**markdown**']) {
      const v = buildRankView(input({ displayName: name }), config);
      expect(v.displayName).toBe(name);
      expect(v.level).toBeGreaterThanOrEqual(0);
    }
  });

  it('progress ratio stays within bounds', () => {
    for (const totalXp of [0, 1, 74, 75, 5249, 5250, 1_000_000]) {
      const v = buildRankView(input({ totalXp }), config);
      expect(v.progressRatio).toBeGreaterThanOrEqual(0);
      expect(v.progressRatio).toBeLessThanOrEqual(1);
    }
  });
});
