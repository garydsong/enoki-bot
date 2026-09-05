/**
 * Level-up message templating. PURE — no Discord types, so every placeholder
 * and every escaping rule is unit-testable without a gateway.
 *
 * Placeholders match Arcane's documented set so an admin migrating a template
 * does not have to relearn it (spec `00` §2.5):
 *
 *   {user.mention} {user.name} {user.id} {user.level}
 *   {user.xp}        progress WITHIN the level, not the lifetime total
 *   {user.totalXp}   the lifetime total
 *   {user.rank} {server.name} {earned}
 *
 * Unknown placeholders are left verbatim rather than blanked: an admin who
 * typos {user.levl} should see their typo, not a message that silently lost a
 * word.
 */

export interface TemplateContext {
  readonly userMention: string;
  readonly userName: string;
  readonly userId: string;
  readonly level: number;
  readonly xpIntoLevel: number;
  readonly xpForNextLevel: number;
  readonly totalXp: number;
  readonly rank: number | null;
  readonly serverName: string;
  /** Names of roles just earned, for {earned}. Empty when none. */
  readonly earnedRoles: readonly string[];
}

export const DEFAULT_LEVELUP_TEMPLATE =
  '{user.mention} has reached level **{user.level}**. GG!';

const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9.]*)(?::([^}]*))?\}/g;

export function renderTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(PLACEHOLDER, (match, rawName: string, argument?: string) => {
    switch (rawName) {
      case 'user.mention':
        return ctx.userMention;
      case 'user.name':
      case 'user.username':
        return ctx.userName;
      case 'user.id':
        return ctx.userId;
      case 'user.level':
        return String(ctx.level);
      case 'user.xp':
        return String(ctx.xpIntoLevel);
      case 'user.xpNeeded':
        return String(ctx.xpForNextLevel);
      case 'user.totalXp':
        return String(ctx.totalXp);
      case 'user.rank':
        return ctx.rank === null ? '—' : String(ctx.rank);
      case 'server.name':
        return ctx.serverName;
      // Conditional by design: renders NOTHING when no role was earned, so a
      // template can read "...GG! {earned:You unlocked }" without leaving a
      // dangling fragment on the levels that award nothing.
      case 'earned':
        if (ctx.earnedRoles.length === 0) return '';
        return `${argument ?? ''}${ctx.earnedRoles.join(', ')}`;
      default:
        return match;
    }
  });
}

/**
 * Discord mentions that a template must never be allowed to fire.
 *
 * This is belt-and-braces ONLY. The real protection is `allowedMentions` on the
 * client, which is enforced by Discord itself and cannot be defeated by clever
 * input. String filtering alone is always defeatable; it exists here so that a
 * previewed template looks like what will actually be sent.
 */
export function neutraliseMassMentions(text: string): string {
  return text.replace(/@(everyone|here)/g, '@​$1');
}

export interface ValidationIssue {
  readonly kind: 'unknown_placeholder' | 'too_long' | 'empty' | 'mass_mention';
  readonly detail: string;
}

const KNOWN = new Set([
  'user.mention',
  'user.name',
  'user.username',
  'user.id',
  'user.level',
  'user.xp',
  'user.xpNeeded',
  'user.totalXp',
  'user.rank',
  'server.name',
  'earned',
]);

/** Validate at CONFIGURATION time, so a typo is caught before anyone levels. */
export function validateTemplate(template: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (template.trim().length === 0) {
    issues.push({ kind: 'empty', detail: 'the template is empty' });
  }
  if (template.length > 1800) {
    issues.push({
      kind: 'too_long',
      detail: `${template.length} characters; Discord's limit is 2000 and placeholders expand`,
    });
  }
  if (/@(everyone|here)/.test(template)) {
    issues.push({
      kind: 'mass_mention',
      detail: '@everyone/@here will be rendered inert rather than pinging',
    });
  }

  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name && !KNOWN.has(name)) {
      issues.push({
        kind: 'unknown_placeholder',
        detail: `{${name}} is not a known placeholder and will be left as-is`,
      });
    }
  }

  return issues;
}
