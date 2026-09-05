import { describe, expect, it } from 'vitest';
import {
  findDeniedRole,
  findRuleContradictions,
  hasLocationWhitelist,
  locationChainIds,
  resolveLocation,
} from '../../src/modules/leveling/domain/restrictions/resolver.js';
import type { LocationChain, XpRule } from '../../src/modules/leveling/domain/types.js';

const CONTEXT = {
  xpInThreads: true,
  xpInForumPosts: true,
  xpInVoiceText: true,
};

const loc = (over: Partial<LocationChain> = {}): LocationChain => ({
  channelId: 'chan-1',
  parentChannelId: null,
  categoryId: null,
  isThread: false,
  isForumPost: false,
  isVoiceText: false,
  ...over,
});

const denyChannel = (id: string): XpRule => ({
  kind: 'restrict_deny',
  targetType: 'channel',
  targetId: id,
});
const onlyChannel = (id: string): XpRule => ({
  kind: 'restrict_only',
  targetType: 'channel',
  targetId: id,
});
const denyCategory = (id: string): XpRule => ({
  kind: 'restrict_deny',
  targetType: 'category',
  targetId: id,
});
const denyRole = (id: string): XpRule => ({
  kind: 'restrict_deny',
  targetType: 'role',
  targetId: id,
});

describe('location chain', () => {
  it('is innermost-first: thread, parent, category', () => {
    expect(
      locationChainIds(loc({ channelId: 't', parentChannelId: 'c', categoryId: 'cat' })),
    ).toEqual(['t', 'c', 'cat']);
  });

  it('omits absent links', () => {
    expect(locationChainIds(loc({ channelId: 'c' }))).toEqual(['c']);
  });
});

describe('blacklist', () => {
  it('denies a listed channel', () => {
    const v = resolveLocation(loc(), [denyChannel('chan-1')], CONTEXT);
    expect(v).toMatchObject({ allowed: false, reason: 'channel_denied' });
  });

  it('denies a channel whose CATEGORY is listed', () => {
    const v = resolveLocation(loc({ categoryId: 'cat-9' }), [denyCategory('cat-9')], CONTEXT);
    expect(v).toMatchObject({ allowed: false, reason: 'channel_denied' });
  });

  it('denies a thread whose PARENT is listed', () => {
    const v = resolveLocation(
      loc({ channelId: 'thread-1', parentChannelId: 'chan-1', isThread: true }),
      [denyChannel('chan-1')],
      CONTEXT,
    );
    expect(v).toMatchObject({ allowed: false, reason: 'channel_denied' });
  });

  it('denies an explicitly listed thread inside an allowed parent', () => {
    const v = resolveLocation(
      loc({ channelId: 'thread-1', parentChannelId: 'chan-1', isThread: true }),
      [denyChannel('thread-1')],
      CONTEXT,
    );
    expect(v).toMatchObject({ allowed: false, reason: 'channel_denied' });
  });

  it('allows an unlisted channel', () => {
    expect(resolveLocation(loc(), [denyChannel('other')], CONTEXT).allowed).toBe(true);
  });
});

describe('whitelist', () => {
  it('denies everywhere except the listed channels', () => {
    const rules = [onlyChannel('allowed')];
    expect(resolveLocation(loc({ channelId: 'allowed' }), rules, CONTEXT).allowed).toBe(true);
    expect(resolveLocation(loc({ channelId: 'elsewhere' }), rules, CONTEXT)).toMatchObject({
      allowed: false,
      reason: 'channel_not_whitelisted',
    });
  });

  it('matches on any element of the chain', () => {
    const v = resolveLocation(
      loc({ channelId: 'thread', parentChannelId: 'parent', isThread: true }),
      [onlyChannel('parent')],
      CONTEXT,
    );
    expect(v.allowed).toBe(true);
  });

  it('an empty whitelist restores allow-everywhere', () => {
    expect(resolveLocation(loc(), [], CONTEXT).allowed).toBe(true);
    expect(hasLocationWhitelist([])).toBe(false);
    expect(hasLocationWhitelist([onlyChannel('x')])).toBe(true);
  });
});

/**
 * ADR-011: blacklist is evaluated AFTER the whitelist and therefore wins.
 * "Only these channels" is a scope; "never this channel" is a prohibition, and
 * a prohibition must be able to carve an exception out of a scope.
 */
describe('whitelist + blacklist conflict (ADR-011)', () => {
  it('a channel on BOTH lists denies', () => {
    const v = resolveLocation(loc({ channelId: 'both' }), [onlyChannel('both'), denyChannel('both')], CONTEXT);
    expect(v).toMatchObject({ allowed: false, reason: 'channel_denied' });
  });

  it('surfaces the contradiction as an admin warning', () => {
    const warnings = findRuleContradictions([onlyChannel('both'), denyChannel('both')]);
    expect(warnings.some((w) => w.includes('both'))).toBe(true);
  });

  it('warns when a no-XP target also carries a booster', () => {
    const warnings = findRuleContradictions([
      denyRole('r1'),
      { kind: 'boost', targetType: 'role', targetId: 'r1', bonusBps: 5000 },
    ]);
    expect(warnings.some((w) => w.includes('can never apply'))).toBe(true);
  });

  it('reports nothing for a clean configuration', () => {
    expect(findRuleContradictions([denyChannel('a'), onlyChannel('b')])).toEqual([]);
  });
});

describe('context toggles', () => {
  it('denies threads when thread XP is off', () => {
    const v = resolveLocation(loc({ isThread: true }), [], { ...CONTEXT, xpInThreads: false });
    expect(v).toMatchObject({ allowed: false, reason: 'context_disabled' });
  });

  it('denies forum posts when forum XP is off', () => {
    const v = resolveLocation(loc({ isThread: true, isForumPost: true }), [], {
      ...CONTEXT,
      xpInForumPosts: false,
    });
    expect(v).toMatchObject({ allowed: false, reason: 'context_disabled' });
  });

  it('a forum post is not blocked by the plain thread toggle', () => {
    const v = resolveLocation(loc({ isThread: true, isForumPost: true }), [], {
      ...CONTEXT,
      xpInThreads: false,
    });
    expect(v.allowed).toBe(true);
  });

  it('denies voice-channel text when that toggle is off', () => {
    const v = resolveLocation(loc({ isVoiceText: true }), [], { ...CONTEXT, xpInVoiceText: false });
    expect(v).toMatchObject({ allowed: false, reason: 'context_disabled' });
  });
});

describe('locationless events', () => {
  it('voice ticks are not location-restricted', () => {
    expect(resolveLocation(undefined, [denyChannel('anything')], CONTEXT).allowed).toBe(true);
  });
});

describe('role denial', () => {
  it('any held no-XP role denies', () => {
    expect(findDeniedRole(['a', 'muted'], [denyRole('muted')])).toBe('muted');
  });

  it('returns null when no held role is denied', () => {
    expect(findDeniedRole(['a', 'b'], [denyRole('muted')])).toBeNull();
  });

  it('denies regardless of how many other roles are held', () => {
    expect(findDeniedRole(['a', 'b', 'c', 'd', 'muted'], [denyRole('muted')])).toBe('muted');
  });
});
