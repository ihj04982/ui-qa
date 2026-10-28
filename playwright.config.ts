import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './selftest',
  fullyParallel: true,
  retries: 0,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1024, height: 768 },
    deviceScaleFactor: 1,
    locale: 'ko-KR',
  },
});
