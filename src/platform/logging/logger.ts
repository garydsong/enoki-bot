import pino from 'pino';
import type { Env } from '../config/env.js';

/**
 * Structured JSON logging (spec NFR-27). Every line carries context so that
 * "why didn't this user get XP" is answerable from logs alone.
 *
 * Redaction is not optional: tokens and connection strings must never appear.
 */
export function createLogger(env: Env) {
  return pino({
    level: env.LOG_LEVEL,
    redact: {
      paths: [
        'DISCORD_TOKEN',
        'token',
        'DATABASE_URL',
        '*.token',
        '*.password',
        'req.headers.authorization',
      ],
      censor: '[redacted]',
    },
    base: { env: env.NODE_ENV },
    ...(env.LOG_PRETTY
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  });
}

export type Logger = ReturnType<typeof createLogger>;
