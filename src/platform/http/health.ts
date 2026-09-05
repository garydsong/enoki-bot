import { createServer, type Server } from 'node:http';
import type { Client } from 'discord.js';
import type { Database } from '../db/pool.js';
import type { Logger } from '../logging/logger.js';
import type { MetricsRegistry } from '../metrics/metrics.js';

/**
 * Health endpoints (spec NFR-29).
 *
 *   /healthz — liveness. Is the process alive? Used by a restart policy.
 *   /readyz  — readiness. Gateway connected AND the database answered.
 *
 * The distinction matters operationally: a bot whose database is briefly
 * unreachable should NOT be restarted (that loses in-memory cooldowns and voice
 * session state for no benefit), but it should be reported as not-ready.
 * Conflating the two turns a 10-second blip into a restart loop.
 */

export interface HealthOptions {
  readonly port: number;
  readonly db: Database;
  readonly client: Client;
  readonly log: Logger;
  readonly version: string;
  /** Omit to serve no /metrics endpoint at all. */
  readonly metrics?: MetricsRegistry;
}

export interface ReadinessReport {
  readonly ready: boolean;
  readonly gateway: boolean;
  readonly database: boolean;
  readonly uptimeSeconds: number;
  readonly version: string;
}

export async function checkReadiness(options: HealthOptions): Promise<ReadinessReport> {
  const gateway = options.client.isReady();
  const database = await options.db.ping();
  return {
    ready: gateway && database,
    gateway,
    database,
    uptimeSeconds: Math.floor(process.uptime()),
    version: options.version,
  };
}

export function startHealthServer(options: HealthOptions): Server {
  const server = createServer((req, res) => {
    const url = req.url ?? '/';

    if (url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'alive', version: options.version }));
      return;
    }

    if (url === '/readyz') {
      void checkReadiness(options)
        .then((report) => {
          res.writeHead(report.ready ? 200 : 503, { 'content-type': 'application/json' });
          res.end(JSON.stringify(report));
        })
        .catch((error: unknown) => {
          options.log.error({ err: error }, 'readiness check threw');
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ready: false, error: 'readiness check failed' }));
        });
      return;
    }

    if (url === '/metrics' && options.metrics) {
      // Refreshed at scrape time rather than continuously: a gauge is only ever
      // read here, so keeping it live between scrapes is pure overhead.
      options.metrics.gauge('enoki_guilds', options.client.guilds.cache.size);
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(options.metrics.render());
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  server.listen(options.port, () => {
    options.log.info({ port: options.port }, 'health server listening');
  });

  return server;
}
