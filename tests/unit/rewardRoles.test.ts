import { describe, expect, it } from 'vitest';
import { whyUngrantable } from '../../src/modules/leveling/adapters/effects/rewardReconciler.js';

/**
 * Checked BEFORE calling Discord, because Discord answers "Missing Permissions"
 * for a role above the bot AND for a genuinely missing permission, so the two
 * cannot be told apart afterwards — and the admin's fix is different for each.
 */

const GUILD = '111111111111111111';
/** The bot's own top role sits at position 10 throughout. */
const me = { roles: { highest: { position: 10 } } } as never;

describe('deciding whether a reward role can be granted', () => {
  it('accepts an ordinary role below the bot', () => {
    expect(whyUngrantable({ id: '222', managed: false, position: 5 }, me, GUILD)).toBeNull();
  });

  it('rejects @everyone, whose id is the guild id', () => {
    // The one that shipped broken: @everyone sits at position 0, so the
    // hierarchy check waves it straight through, and it is not "managed" — yet
    // Discord will never grant or remove it.
    expect(whyUngrantable({ id: GUILD, managed: false, position: 0 }, me, GUILD)).toBe(
      'unassignable',
    );
  });

  it('rejects a role above the bot', () => {
    expect(whyUngrantable({ id: '222', managed: false, position: 10 }, me, GUILD)).toBe(
      'hierarchy',
    );
    expect(whyUngrantable({ id: '222', managed: false, position: 99 }, me, GUILD)).toBe(
      'hierarchy',
    );
  });

  it('rejects an integration role — a bot role, Nitro Booster, a subscriber role', () => {
    expect(whyUngrantable({ id: '222', managed: true, position: 3 }, me, GUILD)).toBe('managed');
  });

  it('reports a deleted role as deleted rather than crashing', () => {
    expect(whyUngrantable(undefined, me, GUILD)).toBe('role_deleted');
  });

  it('checks @everyone before the hierarchy, so the reason is the useful one', () => {
    // Ordering matters: at position 0 the hierarchy check passes, so if
    // @everyone were checked second it would be reported as grantable.
    expect(whyUngrantable({ id: GUILD, managed: true, position: 0 }, me, GUILD)).toBe(
      'unassignable',
    );
  });
});
