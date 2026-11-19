import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', fullyParallel: false, workers: 1,
  use: { baseURL: process.env.ERTAD_TEST_URL ?? 'http://127.0.0.1:15173', channel: process.env.PLAYWRIGHT_CHANNEL || undefined, trace: 'retain-on-failure' },
  reporter: 'list',
  projects: [
    { name: 'development', testMatch: 'ertad-baseline.spec.ts' },
    { name: 'build', testMatch: 'ertad-baseline.spec.ts', use: { baseURL: 'http://127.0.0.1:15175' } },
  ],
  webServer: {
    command: 'npm run preview --workspace admin -- --host 127.0.0.1 --port 15175 --strictPort',
    url: 'http://127.0.0.1:15175',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
