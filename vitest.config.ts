import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pure unit tests for the sanitized logging/audit helpers.
    // Worker-level containment tests run separately against `wrangler dev`.
    include: ['src/__tests__/*.test.ts'],
    environment: 'node',
  },
});
