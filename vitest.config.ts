import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Upstream Prisma test files fetched by scripts/copy_prisma_tests.py are reference material, not tests.
    exclude: ['**/node_modules/**', 'tests-reference/**'],
  },
});
