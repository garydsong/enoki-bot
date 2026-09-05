import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/modules/*/domain/**/*.ts'],
      // types.ts is type-only: no runtime statements to cover.
      exclude: ['**/types.ts'],
      thresholds: {
        // spec 01 NFR-34: domain layer >= 90% branch coverage
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
  },
});
