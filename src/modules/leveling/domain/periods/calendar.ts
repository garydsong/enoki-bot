import { DateTime } from 'luxon';
import type { WeekStartDay } from '../types.js';

/**
 * Period boundaries for weekly/monthly XP (ADR-006, Accepted).
 *
 * THE CENTRAL IDEA: a "reset" is not an operation. XP is written into a bucket
 * keyed by the period it falls in, so when the clock crosses local midnight the
 * key changes and writes land in a new row. No reset job exists, nothing is ever
 * deleted, downtime at the boundary has zero consequence, and last week's board
 * is still queryable.
 *
 * Boundaries are computed in the GUILD's timezone and stored as UTC instants.
 * A DST week is therefore 167 or 169 hours long — that is correct, because the
 * boundary is local midnight, not "168 hours later".
 */

export type PeriodType = 'week' | 'month';

const WEEKDAY_NUMBER: Readonly<Record<WeekStartDay, number>> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
};

export class InvalidTimezoneError extends Error {
  constructor(zone: string) {
    super(`Unknown IANA timezone: ${zone}`);
    this.name = 'InvalidTimezoneError';
  }
}

export function isValidTimezone(zone: string): boolean {
  return DateTime.local().setZone(zone).isValid;
}

/**
 * The UTC instant (epoch millis) at which the period containing `at` began.
 * This value is the bucket key.
 */
export function currentPeriodStart(
  at: number,
  periodType: PeriodType,
  timezone: string,
  weekStartDay: WeekStartDay = 'monday',
): number {
  const local = DateTime.fromMillis(at, { zone: timezone });
  if (!local.isValid) throw new InvalidTimezoneError(timezone);

  if (periodType === 'month') {
    return local.startOf('month').toMillis();
  }

  const startWeekday = WEEKDAY_NUMBER[weekStartDay];
  const midnight = local.startOf('day');
  // Luxon weekday: 1 = Monday .. 7 = Sunday.
  const delta = (midnight.weekday - startWeekday + 7) % 7;
  return midnight.minus({ days: delta }).startOf('day').toMillis();
}

/** The start of the period immediately following the one containing `at`. */
export function nextPeriodStart(
  at: number,
  periodType: PeriodType,
  timezone: string,
  weekStartDay: WeekStartDay = 'monday',
): number {
  const start = currentPeriodStart(at, periodType, timezone, weekStartDay);
  const local = DateTime.fromMillis(start, { zone: timezone });
  const advanced = periodType === 'month' ? local.plus({ months: 1 }) : local.plus({ weeks: 1 });
  // startOf('day') re-normalises across a DST transition that lands on the
  // boundary — the next period still begins at local midnight.
  return advanced.startOf('day').toMillis();
}

/** The start of the period before the one containing `at`. Backs Highlights. */
export function previousPeriodStart(
  at: number,
  periodType: PeriodType,
  timezone: string,
  weekStartDay: WeekStartDay = 'monday',
): number {
  const start = currentPeriodStart(at, periodType, timezone, weekStartDay);
  const local = DateTime.fromMillis(start, { zone: timezone });
  const back = periodType === 'month' ? local.minus({ months: 1 }) : local.minus({ weeks: 1 });
  return back.startOf('day').toMillis();
}

/** Stable string key for storage and for job idempotency (`job_run.scope_key`). */
export function periodKey(
  periodStart: number,
  periodType: PeriodType,
  timezone: string,
): string {
  const local = DateTime.fromMillis(periodStart, { zone: timezone });
  if (!local.isValid) throw new InvalidTimezoneError(timezone);
  return periodType === 'month'
    ? local.toFormat('yyyy-MM')
    : local.toFormat("kkkk-'W'WW");
}

/** True when `at` falls on or after the start of a new period relative to `since`. */
export function hasPeriodRolledOver(
  since: number,
  at: number,
  periodType: PeriodType,
  timezone: string,
  weekStartDay: WeekStartDay = 'monday',
): boolean {
  return (
    currentPeriodStart(at, periodType, timezone, weekStartDay) !==
    currentPeriodStart(since, periodType, timezone, weekStartDay)
  );
}
