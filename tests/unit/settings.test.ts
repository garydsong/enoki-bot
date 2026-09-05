import { describe, expect, it } from 'vitest';
import {
  describeAccepted,
  findSetting,
  parseSettingValue,
  searchSettings,
  SETTINGS,
} from '../../src/modules/leveling/application/settings/registry.js';
import { DEFAULT_LEVELING_CONFIG } from '../../src/modules/leveling/domain/support/defaults.js';

describe('the setting registry', () => {
  it('has a unique key for every setting', () => {
    const keys = SETTINGS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('can read every setting off the default config without throwing', () => {
    // A setting whose `read` reaches a field that does not exist would show
    // `undefined` in /level config view. This catches that at build time.
    for (const setting of SETTINGS) {
      const value = setting.read(DEFAULT_LEVELING_CONFIG);
      expect(value, `${setting.key} read as empty`).toBeTruthy();
      expect(value).not.toContain('undefined');
    }
  });

  it('gives every setting a description and an explanation of what it accepts', () => {
    for (const setting of SETTINGS) {
      expect(setting.description.length, setting.key).toBeGreaterThan(10);
      expect(describeAccepted(setting).length, setting.key).toBeGreaterThan(0);
    }
  });

  it('never exposes a column name that could be confused for SQL', () => {
    // The registry IS the injection defence: these column names are
    // interpolated into an UPDATE statement.
    for (const setting of SETTINGS) {
      expect(setting.column, setting.key).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe('key lookup', () => {
  it('is case-insensitive and tolerates whitespace', () => {
    expect(findSetting('  CURVE.Type ')?.column).toBe('curve_type');
  });

  it('returns undefined for anything not in the registry', () => {
    // The whole point: an unknown key must never reach the repository.
    expect(findSetting('enabled; DROP TABLE member_xp')).toBeUndefined();
    expect(findSetting('config_version')).toBeUndefined();
    expect(findSetting('')).toBeUndefined();
  });
});

describe('autocomplete search', () => {
  it('puts prefix matches ahead of description matches', () => {
    const results = searchSettings('curve');
    expect(results[0]?.key.startsWith('curve.')).toBe(true);
  });

  it('never returns more than Discord allows', () => {
    expect(searchSettings('').length).toBeLessThanOrEqual(25);
    expect(searchSettings('e').length).toBeLessThanOrEqual(25);
  });

  it('finds a setting by a word in its description', () => {
    const results = searchSettings('timezone');
    expect(results.some((s) => s.key === 'periods.timezone')).toBe(true);
  });
});

describe('parsing', () => {
  const parse = (key: string, raw: string) => {
    const setting = findSetting(key);
    if (!setting) throw new Error(`no such setting: ${key}`);
    return parseSettingValue(setting, raw);
  };

  it('accepts the many ways people write a boolean', () => {
    for (const yes of ['on', 'ON', 'true', 'yes', '1', 'enable']) {
      expect(parse('enabled', yes)).toEqual({ ok: true, value: true });
    }
    for (const no of ['off', 'false', 'no', '0', 'disabled']) {
      expect(parse('enabled', no)).toEqual({ ok: true, value: false });
    }
  });

  it('rejects a boolean that is neither', () => {
    const result = parse('enabled', 'maybe');
    expect(result.ok).toBe(false);
  });

  it('converts a decimal multiplier to basis points', () => {
    expect(parse('curve.multiplier', '1.5')).toEqual({ ok: true, value: 15000 });
    expect(parse('curve.multiplier', '2x')).toEqual({ ok: true, value: 20000 });
  });

  it('refuses a zero or negative multiplier, which would break the curve', () => {
    expect(parse('curve.multiplier', '0').ok).toBe(false);
    expect(parse('curve.multiplier', '-1').ok).toBe(false);
  });

  it('enforces integer bounds', () => {
    expect(parse('leaderboard.pageSize', '10')).toEqual({ ok: true, value: 10 });
    expect(parse('leaderboard.pageSize', '0').ok).toBe(false);
    expect(parse('leaderboard.pageSize', '26').ok).toBe(false);
    expect(parse('leaderboard.pageSize', '5.5').ok).toBe(false);
  });

  it('clears a nullable setting with any of the obvious words', () => {
    for (const word of ['none', 'off', 'clear', 'default']) {
      expect(parse('curve.maxLevel', word)).toEqual({ ok: true, value: null });
    }
  });

  it('accepts a channel mention or a bare id', () => {
    expect(parse('levelup.channel', '<#123456789012345678>')).toEqual({
      ok: true,
      value: '123456789012345678',
    });
    expect(parse('levelup.channel', '123456789012345678').ok).toBe(true);
    expect(parse('levelup.channel', 'general').ok).toBe(false);
  });

  it('validates a timezone against the real tz database', () => {
    expect(parse('periods.timezone', 'America/New_York')).toEqual({
      ok: true,
      value: 'America/New_York',
    });
    // Plausible-looking but not real: stored happily, it would break every
    // weekly boundary calculation.
    expect(parse('periods.timezone', 'America/New_York_City').ok).toBe(false);
    expect(parse('periods.timezone', 'EST5EDT').ok).toBe(true);
  });

  it('only accepts a listed choice', () => {
    expect(parse('curve.type', 'EXPONENTIAL')).toEqual({ ok: true, value: 'exponential' });
    expect(parse('curve.type', 'quadratic').ok).toBe(false);
  });

  it('accepts a template with unknown placeholders but rejects an empty one', () => {
    // A typo is a WARNING, surfaced by the command; it must not block the write,
    // because the admin can see their own typo rendered back at them.
    expect(parse('levelup.template', 'hi {user.levl}').ok).toBe(true);
    expect(parse('levelup.template', '   ').ok).toBe(false);
    expect(parse('levelup.template', 'x'.repeat(2000)).ok).toBe(false);
  });

  it('parses a hex colour with or without the hash', () => {
    expect(parse('levelup.color', '#5865F2')).toEqual({ ok: true, value: 0x5865f2 });
    expect(parse('levelup.color', '5865F2')).toEqual({ ok: true, value: 0x5865f2 });
    expect(parse('levelup.color', 'none')).toEqual({ ok: true, value: null });
    expect(parse('levelup.color', 'blue').ok).toBe(false);
  });

  it('routes source settings at the right table', () => {
    expect(findSetting('message.cooldown')?.source).toBe('message');
    expect(findSetting('message.cooldown')?.column).toBe('cooldown_seconds');
    expect(findSetting('voice.cooldown')?.source).toBe('voice');
    // A config-table setting must NOT carry a source, or it would be written to
    // xp_source_config, where the column does not exist.
    expect(findSetting('curve.type')?.source).toBeUndefined();
  });

  it('offers message.mode only for messages', () => {
    expect(findSetting('message.mode')).toBeDefined();
    expect(findSetting('voice.mode')).toBeUndefined();
  });
});
