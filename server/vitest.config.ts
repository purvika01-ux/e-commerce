import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Each test file uses its own throwaway database on the local mongod.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
    env: { NODE_ENV: 'test' },
  },
});
