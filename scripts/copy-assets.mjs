/**
 * Copy non-TypeScript build assets into `dist/`.
 *
 * `tsc` emits only what it compiles, so the module-owned `.sql` migrations
 * under each module's `migrations` folder never reach the build output. Left
 * unfixed that is a SILENT production failure: the migration loader treats a
 * missing directory as "this module has no migrations yet", so a Docker image
 * would boot, apply the core schema, and then fail every leveling query with
 * "relation does not exist" — with nothing in the logs pointing at the cause.
 *
 * Written in Node rather than as a `cp -r` so it works on Windows, which is
 * where this project is actually developed.
 */
import { cp, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const dist = join(root, 'dist');

if (!existsSync(dist)) {
  console.error('dist/ does not exist — run the TypeScript build first.');
  process.exit(1);
}

let copied = 0;

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(full);
    } else if (entry.name.endsWith('.sql')) {
      const target = join(dist, relative(src, full));
      await cp(full, target, { force: true });
      copied++;
    }
  }
}

await walk(src);
console.log(`copied ${copied} SQL file(s) into dist/`);
