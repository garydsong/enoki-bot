import { z } from 'zod';

/**
 * Treat an empty or whitespace-only value as ABSENT.
 *
 * `.env.example` ships blank placeholders (`DISCORD_DEV_GUILD_ID=`), and a
 * blank line in a dotenv file yields an empty STRING, not `undefined`. Without
 * this, `.optional()` never applies and the value is validated as a real one —
 * so simply copying the example file and filling in only what you need fails
 * boot with "must be a snowflake". Every optional variable has that hazard, so
 * the normalisation is applied to all of them rather than patched case by case.
 */
const blankAsAbsent = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema);

const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Environment schema. Validated at boot, BEFORE anything connects.
 * Spec: US-37 AC2, NFR-21.
 *
 * A missing or malformed variable must fail fast with a readable list —
 * never a `undefined is not a function` five seconds into startup.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Discord bot token. Required from M1 (the gateway milestone). */
  DISCORD_TOKEN: blankAsAbsent(z.string().min(1).optional()),

  /** Application (client) ID, needed to register slash commands. */
  DISCORD_APPLICATION_ID: blankAsAbsent(
    z
      .string()
      .regex(SNOWFLAKE, 'must be a Discord snowflake (17-20 digits) — Developer Portal -> General Information -> Application ID')
      .optional(),
  ),

  /**
   * When set, slash commands register to this ONE guild and appear instantly.
   * Leave blank in production so they register globally (~1h to propagate).
   * To find it: Discord -> User Settings -> Advanced -> Developer Mode, then
   * right-click the server icon -> Copy Server ID.
   */
  DISCORD_DEV_GUILD_ID: blankAsAbsent(
    z
      .string()
      .regex(SNOWFLAKE, 'must be a Discord snowflake (17-20 digits) — enable Developer Mode, then right-click your server -> Copy Server ID. Leave blank to register commands globally.')
      .optional(),
  ),

  /** Postgres connection string. Required from M1. */
  DATABASE_URL: blankAsAbsent(z.string().url().optional()),

  /**
   * Whether to request the MessageContent privileged intent. Optional by
   * design: it gates per-word XP mode, min_message_length and the effort
   * booster, and access can lapse via Discord's annual reapplication, so the
   * bot must run correctly without it (spec `03` §1.1).
   */
  ENABLE_MESSAGE_CONTENT: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_PRETTY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  // --- retention (spec `08` §5) --------------------------------------------
  // Only OPERATIONAL data is aged out. Member XP, statistics and configuration
  // are never touched by retention — losing someone's level to a cleanup job
  // would be the worst bug this system could have.
  RETENTION_AUDIT_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  RETENTION_VOICE_SESSION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  RETENTION_PERIOD_XP_DAYS: z.coerce.number().int().min(30).max(3650).default(400),
});

export type Env = z.infer<typeof EnvSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * Parse and validate the environment. Throws `EnvValidationError` listing every
 * problem at once, rather than failing on the first.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new EnvValidationError(issues);
  }
  return result.data;
}
