import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // Bound jsdom contention on hosts also running the API, browser and data services.
    maxWorkers: 1,
    testTimeout: 30000,
     hookTimeout: 120000,
    environment: 'node',
    globals: true,
    setupFiles: ['./src/tests/setup.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
});
