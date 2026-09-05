import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { runMigrations } from '../../src/platform/db/migrator.js';
import { checkReadiness, startHealthServer } from '../../src/platform/http/health.js';
import { createTempDatabase, postgresAvailable, silentLogger, type TempDatabase } from './helpers/db.js';
import type { Client } from 'discord.js';
import type { Database } from '../../src/platform/db/pool.js';
import { createMetrics, type MetricsRegistry } from '../../src/platform/metrics/metrics.js';

const CORE = join(import.meta.dirname, '..', '..', 'migrations');

const fakeClient = (ready: boolean, guilds = 0) =>
  ({ isReady: () => ready, guilds: { cache: { size: guilds } } }) as unknown as Client;

let temp: TempDatabase | null = null;
const servers: { close(cb: () => void): void }[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  await temp?.drop();
  temp = null;
});

async function migrated(): Promise<Database> {
  temp = await createTempDatabase();
  await runMigrations(temp.db, [CORE], silentLogger);
  return temp.db;
}

async function serve(db: Database, client: Client, metrics?: MetricsRegistry) {
  const server = startHealthServer({
    port: 0,
    db,
    client,
    log: silentLogger,
    version: 'test',
    ...(metrics ? { metrics } : {}),
  });
  servers.push(server);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe.runIf(await postgresAvailable())('health endpoints', () => {
  it('/healthz is 200 whenever the process is alive', async () => {
    const base = await serve(await migrated(), fakeClient(false));
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'alive', version: 'test' });
  });

  it('/readyz is 200 when the gateway is up and the database answers', async () => {
    const base = await serve(await migrated(), fakeClient(true));
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ready: true, gateway: true, database: true });
  });

  it('/readyz is 503 while the gateway is not connected', async () => {
    const base = await serve(await migrated(), fakeClient(false));
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ready: false, gateway: false, database: true });
  });

  /**
   * NFR-11: a database blip must NOT restart the bot — that loses in-memory
   * cooldowns and voice session state for no benefit. It must report
   * not-ready while staying alive. This is why /healthz and /readyz differ.
   */
  it('/readyz is 503 when the database is unreachable, and /healthz stays 200', async () => {
    const db = await migrated();
    const base = await serve(db, fakeClient(true));

    await db.close(); // simulate the database going away

    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ ready: false, database: false });

    const alive = await fetch(`${base}/healthz`);
    expect(alive.status).toBe(200); // still alive — do not restart me
  });

  it('404s an unknown path', async () => {
    const base = await serve(await migrated(), fakeClient(true));
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it('reports uptime and version in the readiness payload', async () => {
    const db = await migrated();
    const report = await checkReadiness({
      port: 0,
      db,
      client: fakeClient(true),
      log: silentLogger,
      version: '1.2.3',
    });
    expect(report.version).toBe('1.2.3');
    expect(report.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});


describe.runIf(await postgresAvailable())('the metrics endpoint', () => {
  it('serves the exposition format Prometheus expects', async () => {
    const db = await migrated();
    const metrics = createMetrics();
    metrics.increment('enoki_xp_awarded_total', { source: 'message' });

    const base = await serve(db, fakeClient(true, 7), metrics);
    const response = await fetch(`${base}/metrics`);

    expect(response.status).toBe(200);
    // The content type is part of the contract; a wrong one makes Prometheus
    // refuse the scrape entirely.
    expect(response.headers.get('content-type')).toContain('text/plain');

    const body = await response.text();
    expect(body).toContain('enoki_xp_awarded_total{source="message"} 1');
    // Refreshed at scrape time rather than continuously.
    expect(body).toContain('enoki_guilds 7');
  });

  it('is absent — a plain 404 — when no registry was supplied', async () => {
    const db = await migrated();
    const base = await serve(db, fakeClient(true));
    expect((await fetch(`${base}/metrics`)).status).toBe(404);
  });
});
