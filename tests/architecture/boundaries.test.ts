import { ESLint } from 'eslint';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * THE LOAD-BEARING TEST (spec `11` §D item 6).
 *
 * Every claim in the design spec about testing the XP engine without a network
 * rests on `domain/` staying pure. A lint rule that is merely *configured* rots
 * the first time someone runs `--fix` and ignores the output, so this test
 * asserts the rule actually FAILS on a real violation.
 *
 * If these tests ever go green while a violation compiles, the architecture has
 * silently stopped being enforced — treat that as a build break, not a flake.
 *
 * Implementation note: this uses ESLint's Node API rather than spawning `npx`.
 * Spawning was both slow (a fresh ESLint process per case, ~26s for the suite)
 * and broken on Windows, where `npx` is `npx.cmd` and cannot be exec'd without a
 * shell — the spawn failed silently, every case reported empty output, and the
 * suite failed for a reason that had nothing to do with the architecture.
 *
 * The fixture is written into `domain/` for real, because the rule is scoped by
 * file path and the config is type-aware — it must be a file the TS project
 * actually includes.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const FIXTURE_DIR = join(ROOT, 'src', 'modules', 'leveling', 'domain', '__arch_fixture__');
const FIXTURE = join(FIXTURE_DIR, 'violation.ts');

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: ROOT });
  mkdirSync(FIXTURE_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

interface LintOutcome {
  readonly errorCount: number;
  readonly ruleIds: string[];
  readonly messages: string;
}

async function lintFixture(source: string): Promise<LintOutcome> {
  writeFileSync(FIXTURE, source, 'utf8');
  const [result] = await eslint.lintFiles([FIXTURE]);
  const messages = result?.messages ?? [];
  return {
    errorCount: result?.errorCount ?? 0,
    ruleIds: messages.map((m) => m.ruleId ?? '(fatal)'),
    messages: messages.map((m) => m.message).join('\n'),
  };
}

describe('domain purity is mechanically enforced', () => {
  it('FAILS the build when domain/ imports discord.js', async () => {
    const r = await lintFixture(`import { Client } from 'discord.js';\nexport const c = Client;\n`);
    expect(r.errorCount).toBeGreaterThan(0);
    expect(r.ruleIds).toContain('no-restricted-imports');
    expect(r.messages).toContain('domain/ must stay pure');
  });

  it('FAILS the build when domain/ imports a database driver', async () => {
    const r = await lintFixture(`import { Pool } from 'pg';\nexport const p = Pool;\n`);
    expect(r.errorCount).toBeGreaterThan(0);
    expect(r.ruleIds).toContain('no-restricted-imports');
  });

  it('FAILS the build when domain/ imports the logger', async () => {
    const r = await lintFixture(`import pino from 'pino';\nexport const l = pino;\n`);
    expect(r.errorCount).toBeGreaterThan(0);
    expect(r.ruleIds).toContain('no-restricted-imports');
  });

  it('FAILS the build when domain/ reaches into infrastructure/', async () => {
    const r = await lintFixture(
      `import x from '../../infrastructure/repositories/memberXp.js';\nexport default x;\n`,
    );
    expect(r.errorCount).toBeGreaterThan(0);
    expect(r.ruleIds).toContain('no-restricted-imports');
  });

  it('FAILS the build when domain/ reaches into application/', async () => {
    const r = await lintFixture(`import x from '../../application/awardXp.js';\nexport default x;\n`);
    expect(r.errorCount).toBeGreaterThan(0);
    expect(r.ruleIds).toContain('no-restricted-imports');
  });

  it('FAILS the build when domain/ reaches into the platform core', async () => {
    const r = await lintFixture(
      `import x from '../../../../platform/db/pool.js';\nexport default x;\n`,
    );
    expect(r.errorCount).toBeGreaterThan(0);
    expect(r.ruleIds).toContain('no-restricted-imports');
  });

  it('FAILS the build when domain/ performs file I/O', async () => {
    const r = await lintFixture(
      `import { readFileSync } from 'node:fs';\nexport const r = readFileSync;\n`,
    );
    expect(r.errorCount).toBeGreaterThan(0);
    expect(r.ruleIds).toContain('no-restricted-imports');
  });

  it('PASSES for a legitimate domain-internal import', async () => {
    const r = await lintFixture(
      `import type { CurveType } from '../types.js';\nexport const t: CurveType = 'linear';\n`,
    );
    expect(r.messages).toBe('');
    expect(r.errorCount).toBe(0);
  });

  it('PASSES for luxon — the one sanctioned exception (pure tz computation)', async () => {
    const r = await lintFixture(
      `import { DateTime } from 'luxon';\nexport const now = (): number => DateTime.utc().toMillis();\n`,
    );
    expect(r.messages).toBe('');
    expect(r.errorCount).toBe(0);
  });
});
