import { describe, expect, it } from 'vitest';
import { systemClock, systemRng } from '../../src/modules/leveling/domain/support/clock.js';
import { DEFAULT_LEVELING_CONFIG } from '../../src/modules/leveling/domain/support/defaults.js';

describe('systemClock', () => {
  it('returns a plausible current epoch millis', () => {
    const now = systemClock.now();
    expect(now).toBeGreaterThan(1_700_000_000_000);
    expect(Math.abs(now - Date.now())).toBeLessThan(1000);
  });
});

describe('systemRng', () => {
  it('stays within the inclusive range', () => {
    for (let i = 0; i < 2000; i++) {
      const v = systemRng.intBetween(15, 25);
      expect(v).toBeGreaterThanOrEqual(15);
      expect(v).toBeLessThanOrEqual(25);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('can produce both endpoints', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) seen.add(systemRng.intBetween(0, 2));
    expect(seen).toEqual(new Set([0, 1, 2]));
  });

  it('handles a degenerate range', () => {
    expect(systemRng.intBetween(7, 7)).toBe(7);
    expect(systemRng.intBetween(9, 3)).toBe(9);
  });
});

describe('default configuration', () => {
  it('is disabled until an admin turns it on', () => {
    expect(DEFAULT_LEVELING_CONFIG.enabled).toBe(false);
  });

  it("matches Arcane's documented cooldowns", () => {
    expect(DEFAULT_LEVELING_CONFIG.sources.message.cooldownSeconds).toBe(60);
    expect(DEFAULT_LEVELING_CONFIG.sources.reaction_add.cooldownSeconds).toBe(300);
    expect(DEFAULT_LEVELING_CONFIG.sources.voice.cooldownSeconds).toBe(180);
  });

  it("defaults to Arcane's linear curve at 1.0x, uncapped", () => {
    expect(DEFAULT_LEVELING_CONFIG.curve).toMatchObject({
      type: 'linear',
      multiplierBps: 10000,
      maxLevel: null,
    });
  });

  it('starts with message XP on and the rest off', () => {
    expect(DEFAULT_LEVELING_CONFIG.sources.message.enabled).toBe(true);
    expect(DEFAULT_LEVELING_CONFIG.sources.voice.enabled).toBe(false);
    expect(DEFAULT_LEVELING_CONFIG.sources.reaction_add.enabled).toBe(false);
  });

  it('has no rules or rewards until configured', () => {
    expect(DEFAULT_LEVELING_CONFIG.rules).toEqual([]);
    expect(DEFAULT_LEVELING_CONFIG.rewards).toEqual([]);
  });
});
