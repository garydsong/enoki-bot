import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import {
  currentPeriodStart,
  hasPeriodRolledOver,
  InvalidTimezoneError,
  isValidTimezone,
  nextPeriodStart,
  periodKey,
  previousPeriodStart,
} from '../../src/modules/leveling/domain/periods/calendar.js';

const at = (iso: string, zone = 'UTC') => DateTime.fromISO(iso, { zone }).toMillis();
const asLocal = (ms: number, zone: string) => DateTime.fromMillis(ms, { zone }).toISO();

describe('week boundaries', () => {
  it('truncates to the configured week start in the guild timezone', () => {
    // 2026-09-04 is a Friday.
    const start = currentPeriodStart(at('2026-09-04T15:00:00'), 'week', 'UTC', 'monday');
    expect(asLocal(start, 'UTC')).toBe('2026-08-31T00:00:00.000Z');
  });

  it('honours a Sunday week start', () => {
    const start = currentPeriodStart(at('2026-09-04T15:00:00'), 'week', 'UTC', 'sunday');
    expect(asLocal(start, 'UTC')).toBe('2026-08-30T00:00:00.000Z');
  });

  it('a moment exactly on the boundary belongs to the new week', () => {
    const boundary = at('2026-08-31T00:00:00');
    expect(currentPeriodStart(boundary, 'week', 'UTC', 'monday')).toBe(boundary);
  });

  it('one millisecond before the boundary is still the old week', () => {
    const before = at('2026-08-31T00:00:00') - 1;
    expect(asLocal(currentPeriodStart(before, 'week', 'UTC', 'monday'), 'UTC')).toBe(
      '2026-08-24T00:00:00.000Z',
    );
  });
});

describe('month boundaries', () => {
  it('truncates to the first of the month', () => {
    const start = currentPeriodStart(at('2026-09-04T15:00:00'), 'month', 'UTC');
    expect(asLocal(start, 'UTC')).toBe('2026-09-01T00:00:00.000Z');
  });

  it('handles February in a leap year', () => {
    const start = currentPeriodStart(at('2028-02-29T12:00:00'), 'month', 'UTC');
    expect(asLocal(start, 'UTC')).toBe('2028-02-01T00:00:00.000Z');
    expect(asLocal(nextPeriodStart(start, 'month', 'UTC'), 'UTC')).toBe('2028-03-01T00:00:00.000Z');
  });

  it('rolls December into January', () => {
    const dec = currentPeriodStart(at('2026-12-15T00:00:00'), 'month', 'UTC');
    expect(asLocal(nextPeriodStart(dec, 'month', 'UTC'), 'UTC')).toBe('2027-01-01T00:00:00.000Z');
  });
});

/**
 * The whole point of ADR-006: boundaries are LOCAL midnight in the guild's zone,
 * stored as UTC instants. UTC-only would be wrong for most communities.
 */
describe('timezone awareness', () => {
  it('the same instant falls in different weeks depending on the guild zone', () => {
    // Monday 2026-08-31 03:00 UTC is still Sunday 2026-08-30 in Los Angeles.
    const instant = at('2026-08-31T03:00:00');
    const utcWeek = currentPeriodStart(instant, 'week', 'UTC', 'monday');
    const laWeek = currentPeriodStart(instant, 'week', 'America/Los_Angeles', 'monday');
    expect(utcWeek).not.toBe(laWeek);
    expect(asLocal(laWeek, 'America/Los_Angeles')).toBe('2026-08-24T00:00:00.000-07:00');
  });

  it('a month boundary lands at local midnight, not UTC midnight', () => {
    const start = currentPeriodStart(at('2026-09-15T00:00:00'), 'month', 'Asia/Tokyo');
    expect(asLocal(start, 'Asia/Tokyo')).toBe('2026-09-01T00:00:00.000+09:00');
  });

  it('rejects an unknown timezone rather than silently using UTC', () => {
    expect(() => currentPeriodStart(Date.now(), 'week', 'Not/AZone')).toThrow(InvalidTimezoneError);
    expect(isValidTimezone('Not/AZone')).toBe(false);
    expect(isValidTimezone('Europe/Berlin')).toBe(true);
  });
});

/**
 * A DST week is 167 or 169 hours long. That is CORRECT — the boundary is local
 * midnight, not "168 hours later". Getting this wrong drifts every subsequent
 * boundary by an hour.
 */
describe('DST transitions', () => {
  const ZONE = 'America/New_York';

  it('the spring-forward week is 167 hours, not 168', () => {
    // US DST begins Sunday 2026-03-08, so the SHORT week is Mon 03-02..03-09.
    const weekStart = currentPeriodStart(at('2026-03-04T12:00:00', ZONE), 'week', ZONE, 'monday');
    const next = nextPeriodStart(weekStart, 'week', ZONE, 'monday');
    expect((next - weekStart) / 3_600_000).toBe(167);
  });

  it('the autumn-back week is 169 hours', () => {
    // US DST ends 2026-11-01.
    const weekStart = currentPeriodStart(at('2026-10-26T12:00:00', ZONE), 'week', ZONE, 'monday');
    const next = nextPeriodStart(weekStart, 'week', ZONE, 'monday');
    expect((next - weekStart) / 3_600_000).toBe(169);
  });

  it('both boundaries still land on local midnight', () => {
    const weekStart = currentPeriodStart(at('2026-03-04T12:00:00', ZONE), 'week', ZONE, 'monday');
    const next = nextPeriodStart(weekStart, 'week', ZONE, 'monday');
    expect(DateTime.fromMillis(next, { zone: ZONE }).hour).toBe(0);
    expect(DateTime.fromMillis(weekStart, { zone: ZONE }).hour).toBe(0);
  });
});

/**
 * ADR-006: a "reset" is not an operation. Crossing the boundary changes the
 * bucket key, and that is the entire mechanism. No job runs. Nothing is deleted.
 */
describe('reset is a pure function of the clock (ADR-006)', () => {
  it('the key changes across the boundary with no job involved', () => {
    const before = at('2026-08-30T23:59:59');
    const after = at('2026-08-31T00:00:01');
    expect(currentPeriodStart(before, 'week', 'UTC', 'monday')).not.toBe(
      currentPeriodStart(after, 'week', 'UTC', 'monday'),
    );
    expect(hasPeriodRolledOver(before, after, 'week', 'UTC', 'monday')).toBe(true);
  });

  it('two moments in the same week share a key', () => {
    expect(
      hasPeriodRolledOver(at('2026-09-01T01:00:00'), at('2026-09-03T23:00:00'), 'week', 'UTC', 'monday'),
    ).toBe(false);
  });

  it('being offline across the boundary has no effect on the bucketing', () => {
    // Downtime from Saturday to Wednesday: the first write after restart still
    // lands in the correct (new) bucket.
    const wentDown = at('2026-08-29T12:00:00');
    const cameBack = at('2026-09-02T12:00:00');
    expect(asLocal(currentPeriodStart(cameBack, 'week', 'UTC', 'monday'), 'UTC')).toBe(
      '2026-08-31T00:00:00.000Z',
    );
    expect(hasPeriodRolledOver(wentDown, cameBack, 'week', 'UTC', 'monday')).toBe(true);
  });
});

describe('previous period (backs Highlights)', () => {
  it('steps back one week', () => {
    const now = at('2026-09-04T12:00:00');
    expect(asLocal(previousPeriodStart(now, 'week', 'UTC', 'monday'), 'UTC')).toBe(
      '2026-08-24T00:00:00.000Z',
    );
  });

  it('steps back one month', () => {
    const now = at('2026-09-04T12:00:00');
    expect(asLocal(previousPeriodStart(now, 'month', 'UTC'), 'UTC')).toBe('2026-08-01T00:00:00.000Z');
  });
});

describe('period keys', () => {
  it('formats a week as ISO year-week', () => {
    const start = currentPeriodStart(at('2026-09-04T12:00:00'), 'week', 'UTC', 'monday');
    expect(periodKey(start, 'week', 'UTC')).toBe('2026-W36');
  });

  it('formats a month as year-month', () => {
    const start = currentPeriodStart(at('2026-09-04T12:00:00'), 'month', 'UTC');
    expect(periodKey(start, 'month', 'UTC')).toBe('2026-09');
  });

  it('rejects an invalid zone', () => {
    expect(() => periodKey(Date.now(), 'week', 'Not/AZone')).toThrow(InvalidTimezoneError);
  });
});
