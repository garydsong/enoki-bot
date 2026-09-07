import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from '../../src/platform/config/env.js';

/**
 * Regression tests for a boot failure caused by `.env.example` itself.
 *
 * The example file ships blank placeholders (`DISCORD_DEV_GUILD_ID=`), and a
 * blank line in a dotenv file produces an empty STRING, not `undefined`. So
 * `.optional()` never applied, the empty string was validated as a real value,
 * and copying the example file and filling in only what you need failed boot
 * with "must be a snowflake" — pointing at a variable the user had
 * deliberately left blank.
 */

describe('environment validation', () => {
  it('accepts a completely empty environment (M0-style boot)', () => {
    const env = loadEnv({});
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.HTTP_PORT).toBe(3000);
    expect(env.DISCORD_TOKEN).toBeUndefined();
  });

  describe('blank values mean ABSENT, not invalid', () => {
    it.each([
      'DISCORD_TOKEN',
      'DISCORD_APPLICATION_ID',
      'DISCORD_DEV_GUILD_ID',
      'DATABASE_URL',
    ])('%s= is treated as unset', (key) => {
      const env = loadEnv({ [key]: '' });
      expect(env[key as keyof typeof env]).toBeUndefined();
    });

    it('whitespace-only is also treated as unset', () => {
      expect(loadEnv({ DISCORD_DEV_GUILD_ID: '   ' }).DISCORD_DEV_GUILD_ID).toBeUndefined();
    });

    /** The exact scenario that broke: the unmodified example file. */
    it('accepts .env.example verbatim, with every optional value blank', () => {
      expect(() =>
        loadEnv({
          DISCORD_TOKEN: '',
          DISCORD_APPLICATION_ID: '',
          DISCORD_DEV_GUILD_ID: '',
          DATABASE_URL: '',
          LOG_LEVEL: 'info',
        }),
      ).not.toThrow();
    });

    /** And the common half-filled case: dev guild left blank on purpose. */
    it('accepts a real token and application id with the dev guild left blank', () => {
      const env = loadEnv({
        DISCORD_TOKEN: 'a.token.value',
        DISCORD_APPLICATION_ID: '1545460676426993754',
        DISCORD_DEV_GUILD_ID: '',
        DATABASE_URL: 'postgres://u@localhost:5432/db',
      });
      expect(env.DISCORD_APPLICATION_ID).toBe('1545460676426993754');
      expect(env.DISCORD_DEV_GUILD_ID).toBeUndefined();
    });
  });

  describe('a genuinely wrong value is still rejected', () => {
    it('rejects a non-numeric guild id', () => {
      expect(() => loadEnv({ DISCORD_DEV_GUILD_ID: 'my-server' })).toThrow(EnvValidationError);
    });

    it('rejects a guild id that is too short', () => {
      expect(() => loadEnv({ DISCORD_DEV_GUILD_ID: '12345' })).toThrow(EnvValidationError);
    });

    it('rejects a malformed database url', () => {
      expect(() => loadEnv({ DATABASE_URL: 'not-a-url' })).toThrow(EnvValidationError);
    });

    it('rejects an out-of-range port', () => {
      expect(() => loadEnv({ HTTP_PORT: '99999' })).toThrow(EnvValidationError);
    });

    it('rejects a non-numeric port', () => {
      expect(() => loadEnv({ HTTP_PORT: 'nope' })).toThrow(EnvValidationError);
    });

    it('rejects an unknown log level', () => {
      expect(() => loadEnv({ LOG_LEVEL: 'chatty' })).toThrow(EnvValidationError);
    });
  });

  describe('error reporting', () => {
    /** US-37 AC2: fail fast with EVERY problem listed, not the first one. */
    it('reports all problems at once', () => {
      try {
        loadEnv({ DISCORD_DEV_GUILD_ID: 'nope', HTTP_PORT: '0', LOG_LEVEL: 'loud' });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(EnvValidationError);
        const issues = (error as EnvValidationError).issues;
        expect(issues).toHaveLength(3);
        expect(issues.join('\n')).toContain('DISCORD_DEV_GUILD_ID');
        expect(issues.join('\n')).toContain('HTTP_PORT');
        expect(issues.join('\n')).toContain('LOG_LEVEL');
      }
    });

    it('tells the user how to find a guild id rather than just "invalid"', () => {
      try {
        loadEnv({ DISCORD_DEV_GUILD_ID: 'nope' });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as EnvValidationError).message).toContain('Copy Server ID');
      }
    });
  });

  describe('typed coercion', () => {
    it('parses the port as a number', () => {
      expect(loadEnv({ HTTP_PORT: '8080' }).HTTP_PORT).toBe(8080);
    });

    it('parses boolean-ish flags', () => {
      expect(loadEnv({ LOG_PRETTY: 'true' }).LOG_PRETTY).toBe(true);
      expect(loadEnv({ LOG_PRETTY: 'false' }).LOG_PRETTY).toBe(false);
      expect(loadEnv({}).ENABLE_MESSAGE_CONTENT).toBe(true);
      expect(loadEnv({ ENABLE_MESSAGE_CONTENT: 'false' }).ENABLE_MESSAGE_CONTENT).toBe(false);
    });
  });
});

/**
 * Hosting platforms inject `PORT` and health-check it.
 *
 * Nothing in this bot serves public traffic, but a platform that probes a port
 * nothing is listening on reports a dead deploy — so the health server has to
 * bind where the platform says, not where the .env says.
 */
describe('PORT, as every PaaS injects it', () => {
  it('binds the platform’s port when HTTP_PORT is not set', () => {
    const env = loadEnv({ PORT: '8080' });
    expect(env.HTTP_PORT).toBe(8080);
  });

  it('lets an explicit HTTP_PORT win, so a local .env is unaffected', () => {
    const env = loadEnv({ PORT: '8080', HTTP_PORT: '3000' });
    expect(env.HTTP_PORT).toBe(3000);
  });

  it('still defaults when neither is set', () => {
    expect(loadEnv({}).HTTP_PORT).toBe(3000);
  });
})
