import { loadDotenv } from './platform/config/dotenv.js';
import { EnvValidationError, loadEnv } from './platform/config/env.js';
import { createLogger } from './platform/logging/logger.js';
import { boot, COMMIT, VERSION } from './composition/bootstrap.js';

/**
 * Enoki — entrypoint.
 *
 * Responsibilities kept deliberately thin: validate the environment, build a
 * logger, hand off to the composition root, and own the process signals.
 * Everything else lives in `composition/bootstrap.ts`.
 */
async function main(): Promise<void> {
  // Must happen before loadEnv() — it reads process.env, and nothing else
  // populates it locally. In Docker there is no .env and compose injects the
  // variables directly, so a missing file is normal.
  const dotenv = loadDotenv();

  let env;
  try {
    env = loadEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      // No logger yet — the env is what configures it.
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const log = createLogger(env);
  log.info(
    {
      app: 'enoki',
      version: VERSION,
      commit: COMMIT,
      node: process.version,
      env_file: dotenv.loaded ? dotenv.path : 'none (using the ambient environment)',
    },
    'starting',
  );

  let shutdownHandle: (() => Promise<void>) | null = null;

  try {
    const result = await boot(env, log);
    shutdownHandle = result.shutdown;
    log.info('started');
  } catch (error) {
    // A boot failure is fatal by design: a bot that starts against a schema it
    // does not understand, or without credentials, corrupts data quietly.
    // Failing loudly here is the cheap outcome (spec NFR-38).
    log.fatal({ err: error }, 'boot failed');
    process.exit(1);
  }

  // --- graceful shutdown (spec BR-11) ---------------------------------------
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      log.warn({ signal }, 'already shutting down; ignoring');
      return;
    }
    shuttingDown = true;
    log.info({ signal }, 'shutting down');

    // Hard deadline: if a drain hangs, exit anyway rather than becoming a
    // process that will not die and has to be SIGKILLed by an operator.
    const deadline = setTimeout(() => {
      log.error('shutdown timed out after 10s; exiting anyway');
      process.exit(1);
    }, 10_000);
    deadline.unref();

    void (async () => {
      try {
        await shutdownHandle?.();
        log.info('shutdown complete');
        process.exit(0);
      } catch (error) {
        log.error({ err: error }, 'error during shutdown');
        process.exit(1);
      }
    })();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'unhandled rejection');
  });
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'uncaught exception');
    process.exit(1);
  });
}

void main();
