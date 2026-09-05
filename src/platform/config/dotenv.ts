import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Load `.env` into `process.env`, if it exists.
 *
 * Uses Node's built-in `process.loadEnvFile` (v20.12+/v21.7+) rather than the
 * `dotenv` package — one fewer dependency for a job the runtime now does — and
 * rather than the `--env-file` CLI flag, because a function call works
 * identically under `node`, `tsx`, `tsx watch` and `vitest`, whereas the flag
 * has to be threaded through whichever runner is in front.
 *
 * ABSENCE IS NORMAL, NOT AN ERROR. In Docker there is no `.env` file at all —
 * compose injects the variables directly — so a missing file must be silent.
 * Real variables always win: anything already in `process.env` is left alone,
 * which is what makes `DATABASE_URL=... npm run dev` behave as expected.
 */
export interface DotenvResult {
  readonly loaded: boolean;
  readonly path: string;
}

export function loadDotenv(cwd: string = process.cwd()): DotenvResult {
  const path = resolve(cwd, '.env');

  if (!existsSync(path)) {
    return { loaded: false, path };
  }

  // Snapshot what was genuinely in the environment, so file values cannot
  // clobber an explicit override on the command line or from compose.
  const preexisting = new Map(Object.entries(process.env));

  process.loadEnvFile(path);

  for (const [key, value] of preexisting) {
    if (value !== undefined) process.env[key] = value;
  }

  return { loaded: true, path };
}
