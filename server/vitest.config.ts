import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    fileParallelism: false, testTimeout: 30000, hookTimeout: 120000,
    env: { NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://legacy:legacy@localhost:5432/class_legacy_test', PAYMENT_WEBHOOK_SECRET: 'test-secret', LOGIN_RATE_MAX: '100000' },
  },
});
