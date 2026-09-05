// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * ARCHITECTURE BOUNDARY ENFORCEMENT — spec `07` §1.2, and `11` §D item 6.
 *
 * This is load-bearing, not cosmetic. Every claim in the spec about testing the
 * XP engine without a network depends on `domain/` staying pure. These rules are
 * ERRORS and they run in CI. Do not downgrade them to warnings.
 *
 * Layer rules:
 *   domain          -> domain only (plus `luxon`, the one sanctioned exception:
 *                      pure computation, no I/O, needed for tz-correct periods)
 *   application     -> domain + ports; never discord.js, the ORM, or concretes
 *   infrastructure  -> domain + ports; never application or adapters
 *   adapters        -> application + ports + domain types; never infra concretes
 *   composition     -> everything (the only place concretes are constructed)
 */

const IO_PACKAGES = [
  'discord.js',
  '@discordjs/*',
  'pg',
  'pg-*',
  'drizzle-orm',
  'drizzle-orm/*',
  'drizzle-kit',
  'pino',
  'pino-*',
  'node:fs',
  'node:fs/*',
  'node:net',
  'node:http',
  'node:https',
  'node:child_process',
  'fs',
  'fs/*',
  'net',
  'http',
  'https',
  'child_process',
];

const layerPattern = (groups, message) => ({
  patterns: [{ group: groups, message }],
});

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.config.js'],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
    },
  },

  // ---------------------------------------------------------------------------
  // domain/ — the crown jewels. Pure. No I/O. No frameworks.
  // ---------------------------------------------------------------------------
  {
    files: ['src/modules/*/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        layerPattern(
          [
            ...IO_PACKAGES,
            '**/application/**',
            '**/infrastructure/**',
            '**/adapters/**',
            '**/ports/**',
            '**/platform/**',
            '**/composition/**',
          ],
          'domain/ must stay pure: it may import only from domain/ (plus luxon). See spec 07 §1.2.',
        ),
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // application/ — orchestration. Talks to ports, never to concretes.
  // ---------------------------------------------------------------------------
  {
    files: ['src/modules/*/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        layerPattern(
          [
            'discord.js',
            '@discordjs/*',
            'pg',
            'drizzle-orm',
            'drizzle-orm/*',
            '**/infrastructure/**',
            '**/adapters/**',
            '**/composition/**',
          ],
          'application/ may import domain/ and ports/ only — concretes arrive by injection. See spec 07 §1.2.',
        ),
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // infrastructure/ — implements ports. Never reaches upward.
  // ---------------------------------------------------------------------------
  {
    files: ['src/modules/*/infrastructure/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        layerPattern(
          ['**/application/**', '**/adapters/**', '**/composition/**'],
          'infrastructure/ may import domain/ and ports/ only. See spec 07 §1.2.',
        ),
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // adapters/ — thin Discord translation. No business logic, no concretes.
  // ---------------------------------------------------------------------------
  {
    files: ['src/modules/*/adapters/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        layerPattern(
          ['**/infrastructure/**', '**/composition/**'],
          'adapters/ may import application/, ports/ and domain types — concretes arrive by injection. See spec 07 §1.2.',
        ),
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Tests may reach anywhere, and may use console.
  // ---------------------------------------------------------------------------
  {
    files: ['tests/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-console': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      // Test fixtures legitimately have async no-op bodies (a job that does
      // nothing is the point of the fixture).
      '@typescript-eslint/require-await': 'off',
    },
  },

  // The entrypoint and platform logger legitimately touch the console/process.
  {
    files: ['src/main.ts', 'src/platform/logging/**/*.ts', 'src/platform/config/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
