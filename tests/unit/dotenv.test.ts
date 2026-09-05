import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDotenv } from '../../src/platform/config/dotenv.js';

/**
 * Regression tests for a gap M1 shipped with: nothing loaded `.env`, so
 * `npm run dev` failed with "DISCORD_TOKEN is required" even when the file was
 * sitting right there. It worked under Docker (compose injects the variables
 * directly), which is exactly why it went unnoticed.
 */

const dirs: string[] = [];
const touched: string[] = [];

function tempDirWith(contents: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'enoki-env-'));
  dirs.push(dir);
  if (contents !== null) writeFileSync(join(dir, '.env'), contents, 'utf8');
  return dir;
}

function track(...keys: string[]): void {
  touched.push(...keys);
}

afterEach(() => {
  for (const k of touched.splice(0)) delete process.env[k];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('loadDotenv', () => {
  it('loads values from a .env file into process.env', () => {
    track('ENOKI_TEST_A', 'ENOKI_TEST_B');
    const dir = tempDirWith('ENOKI_TEST_A=alpha\nENOKI_TEST_B=beta\n');

    const result = loadDotenv(dir);

    expect(result.loaded).toBe(true);
    expect(result.path).toBe(join(dir, '.env'));
    expect(process.env['ENOKI_TEST_A']).toBe('alpha');
    expect(process.env['ENOKI_TEST_B']).toBe('beta');
  });

  /**
   * Absence is NORMAL, not an error: in Docker there is no .env at all and
   * compose injects the variables. Throwing here would break the container.
   */
  it('is silent when there is no .env file', () => {
    const dir = tempDirWith(null);
    const result = loadDotenv(dir);
    expect(result.loaded).toBe(false);
  });

  /**
   * A real environment variable must beat the file, so
   * `DATABASE_URL=... npm run dev` and compose overrides both behave as
   * expected rather than being silently clobbered by a stale .env.
   */
  it('does not overwrite a variable already set in the environment', () => {
    track('ENOKI_TEST_PRECEDENCE');
    process.env['ENOKI_TEST_PRECEDENCE'] = 'from-the-shell';
    const dir = tempDirWith('ENOKI_TEST_PRECEDENCE=from-the-file\n');

    loadDotenv(dir);

    expect(process.env['ENOKI_TEST_PRECEDENCE']).toBe('from-the-shell');
  });

  it('still fills in variables the environment does not define', () => {
    track('ENOKI_TEST_SET', 'ENOKI_TEST_UNSET');
    process.env['ENOKI_TEST_SET'] = 'shell';
    const dir = tempDirWith('ENOKI_TEST_SET=file\nENOKI_TEST_UNSET=file\n');

    loadDotenv(dir);

    expect(process.env['ENOKI_TEST_SET']).toBe('shell');
    expect(process.env['ENOKI_TEST_UNSET']).toBe('file');
  });

  it('handles comments and blank lines', () => {
    track('ENOKI_TEST_C');
    const dir = tempDirWith('# a comment\n\nENOKI_TEST_C=gamma\n\n# trailing\n');
    loadDotenv(dir);
    expect(process.env['ENOKI_TEST_C']).toBe('gamma');
  });

  it('resolves .env relative to the given directory, not the process cwd', () => {
    track('ENOKI_TEST_D');
    const dir = tempDirWith('ENOKI_TEST_D=delta\n');
    const result = loadDotenv(dir);
    expect(result.path.startsWith(dir)).toBe(true);
    expect(process.env['ENOKI_TEST_D']).toBe('delta');
  });
});
