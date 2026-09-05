import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LEVELUP_TEMPLATE,
  neutraliseMassMentions,
  renderTemplate,
  validateTemplate,
  type TemplateContext,
} from '../../src/modules/leveling/domain/notifications/template.js';
import {
  escapeMarkdown,
  formatDuration,
  formatNumber,
  ordinal,
  progressBar,
  rankBadge,
} from '../../src/modules/leveling/adapters/commands/format.js';

const ctx = (over: Partial<TemplateContext> = {}): TemplateContext => ({
  userMention: '<@123>',
  userName: 'Gary',
  userId: '123',
  level: 7,
  xpIntoLevel: 40,
  xpForNextLevel: 100,
  totalXp: 2540,
  rank: 3,
  serverName: 'Test Server',
  earnedRoles: [],
  ...over,
});

describe('rendering a level-up template', () => {
  it('fills in every documented placeholder', () => {
    const rendered = renderTemplate(
      '{user.mention} {user.name} {user.id} {user.level} {user.xp} {user.xpNeeded} ' +
        '{user.totalXp} {user.rank} {server.name}',
      ctx(),
    );
    expect(rendered).toBe('<@123> Gary 123 7 40 100 2540 3 Test Server');
  });

  it('distinguishes progress within the level from the lifetime total', () => {
    // The single most common confusion in a leveling bot's templating.
    const rendered = renderTemplate('{user.xp} of {user.totalXp}', ctx());
    expect(rendered).toBe('40 of 2540');
  });

  it('leaves an unknown placeholder verbatim so a typo is visible', () => {
    expect(renderTemplate('level {user.levl}!', ctx())).toBe('level {user.levl}!');
  });

  it('renders an unranked member as a dash rather than "null"', () => {
    expect(renderTemplate('{user.rank}', ctx({ rank: null }))).toBe('—');
  });

  it('renders {earned} as nothing when no role was granted', () => {
    // So a template can read "...GG! {earned:You unlocked }" without leaving a
    // dangling fragment on levels that award nothing.
    expect(renderTemplate('GG!{earned: You unlocked }', ctx())).toBe('GG!');
  });

  it('renders {earned} with its prefix and a comma-separated list', () => {
    const rendered = renderTemplate(
      'GG!{earned: You unlocked }',
      ctx({ earnedRoles: ['Regular', 'Veteran'] }),
    );
    expect(rendered).toBe('GG! You unlocked Regular, Veteran');
  });

  it('renders the shipped default without leaving any placeholder behind', () => {
    const rendered = renderTemplate(DEFAULT_LEVELUP_TEMPLATE, ctx());
    expect(rendered).not.toMatch(/\{[a-z]/i);
    expect(rendered).toContain('<@123>');
  });

  it('does not re-expand a placeholder produced by a value', () => {
    // A member named "{user.level}" must not become their own level.
    const rendered = renderTemplate('{user.name}', ctx({ userName: '{user.level}' }));
    expect(rendered).toBe('{user.level}');
  });
});

describe('mass mention neutralisation', () => {
  it('renders @everyone and @here inert', () => {
    const out = neutraliseMassMentions('hey @everyone and @here');
    expect(out).not.toMatch(/(^|[^\u200B])@everyone/);
    expect(out).toContain('everyone');
  });

  it('leaves an ordinary user mention alone', () => {
    expect(neutraliseMassMentions('<@123> hi')).toBe('<@123> hi');
  });
});

describe('validating a template at configuration time', () => {
  it('accepts a good template', () => {
    expect(validateTemplate('{user.mention} reached {user.level}')).toEqual([]);
  });

  it('flags an unknown placeholder as a warning, not a rejection', () => {
    const issues = validateTemplate('{user.levl}');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('unknown_placeholder');
  });

  it('flags an empty template', () => {
    expect(validateTemplate('   ').map((i) => i.kind)).toContain('empty');
  });

  it('flags a template that leaves no room for placeholder expansion', () => {
    expect(validateTemplate('x'.repeat(1900)).map((i) => i.kind)).toContain('too_long');
  });

  it('warns that @everyone will not ping', () => {
    expect(validateTemplate('@everyone gg').map((i) => i.kind)).toContain('mass_mention');
  });
});

describe('presentation helpers', () => {
  it('formats a progress bar at both ends and in the middle', () => {
    expect(progressBar(0, 10)).toBe('░'.repeat(10));
    expect(progressBar(1, 10)).toBe('█'.repeat(10));
    expect(progressBar(0.5, 10)).toBe(`${'█'.repeat(5)}${'░'.repeat(5)}`);
  });

  it('clamps a ratio outside 0..1 instead of producing a ragged bar', () => {
    expect(progressBar(-1, 8)).toHaveLength(8);
    expect(progressBar(5, 8)).toBe('█'.repeat(8));
  });

  it('formats voice time in a way a person reads', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(600)).toBe('10m');
    expect(formatDuration(3660)).toBe('1h 1m');
    expect(formatDuration(-5)).toBe('0s');
  });

  it('gets the awkward ordinals right', () => {
    expect(ordinal(1)).toBe('1st');
    expect(ordinal(2)).toBe('2nd');
    expect(ordinal(3)).toBe('3rd');
    expect(ordinal(11)).toBe('11th');
    expect(ordinal(12)).toBe('12th');
    expect(ordinal(13)).toBe('13th');
    expect(ordinal(21)).toBe('21st');
    expect(ordinal(111)).toBe('111th');
  });

  it('gives medals to the top three only', () => {
    expect(rankBadge(1)).toBe('🥇');
    expect(rankBadge(3)).toBe('🥉');
    expect(rankBadge(4)).toContain('#');
  });

  it('escapes markdown in a display name', () => {
    // A member called "**everyone**" or "[x](https://evil)" must not inject
    // formatting into the leaderboard.
    expect(escapeMarkdown('**bold**')).toBe('\\*\\*bold\\*\\*');
    expect(escapeMarkdown('[click](https://evil)')).toBe(
      '\\[click\\]\\(https://evil\\)',
    );
  });

  it('groups large numbers', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
  });
});
