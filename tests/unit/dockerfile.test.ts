import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE IMAGE IS A BUILD NOBODY RUNS LOCALLY.
 *
 * `npm run verify` proves the code is correct on a machine that has the whole
 * repository checked out. The Docker build has a different, much smaller world:
 * only the paths its `COPY` lines name exist. Anything the build script reaches
 * for that was not copied is MODULE_NOT_FOUND — but only in CI, or on the
 * platform, minutes into a deploy.
 *
 * That is not hypothetical. M14 added `scripts/copy-assets.mjs` to the build
 * script and did not add `scripts/` to the Dockerfile, so every image built
 * after it failed. Nothing caught it, because the suite never builds an image.
 *
 * These tests read the Dockerfile as text and check it against the build script
 * it has to run. They are cheap, they need no daemon, and they fail on the pull
 * request rather than on the platform.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

/** The COPY lines up to the runtime stage — the build world. */
function buildStageCopies(): string[] {
  const runtimeAt = dockerfile.indexOf('AS runtime');
  const buildStage = runtimeAt === -1 ? dockerfile : dockerfile.slice(0, runtimeAt);
  return [...buildStage.matchAll(/^\s*COPY\s+(.+)$/gm)].map((m) => m[1] ?? '');
}

/** Local paths the build script names, e.g. `scripts/copy-assets.mjs`. */
function pathsUsedByBuild(): string[] {
  const script = pkg.scripts['build'] ?? '';
  return [...script.matchAll(/(?:^|\s)([\w.-]+\/[\w./-]+)/g)]
    .map((m) => m[1] ?? '')
    .filter((path) => !path.startsWith('-'));
}

describe('the Dockerfile can actually run the build', () => {
  it('copies every local path the build script reaches for', () => {
    const copies = buildStageCopies();
    const missing = pathsUsedByBuild().filter((path) => {
      const top = path.split('/')[0] ?? path;
      // A COPY of the directory, or of the file itself, both count.
      return !copies.some((copy) => copy.includes(top));
    });

    expect(
      missing,
      `the build stage never COPYs: ${missing.join(', ')}. ` +
        'Add a COPY line, or the image fails with MODULE_NOT_FOUND on deploy.',
    ).toEqual([]);
  });

  it('copies the core migrations into the runtime image', () => {
    // These are read from disk at boot, not compiled into the bundle. Without
    // them the bot starts, applies nothing, and fails every query.
    expect(dockerfile).toMatch(/COPY\s+migrations\s+\.\/migrations/);
  });

  it('takes dist from the build stage rather than rebuilding', () => {
    expect(dockerfile).toMatch(/COPY\s+--from=build\s+\/app\/dist\s+\.\/dist/);
  });

  it('installs fonts, without which every rank card silently falls back', () => {
    expect(dockerfile).toMatch(/apk add[^\n]*font/);
  });

  it('runs as a non-root user', () => {
    expect(dockerfile).toMatch(/^USER\s+(?!root)\w+/m);
  });

  it('installs production dependencies only in the runtime stage', () => {
    expect(dockerfile).toMatch(/npm ci --omit=dev/);
  });
});
