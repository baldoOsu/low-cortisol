import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __FLAVOR__: JSON.stringify('dev'),
    __COMPANION_VERSION__: JSON.stringify('0.0.0-test'),
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
  },
});
