// @ts-check
const { defineConfig, devices } = require('@playwright/test');

// Serves the app the same way Netlify does: the static repo root (one level up
// from this tests/ folder) over plain HTTP. The enforced CSP header is a Netlify
// concern and does not apply to this local server — functional tests don't need it.
module.exports = defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'python3 -m http.server 5173 --directory ..',
    cwd: __dirname,
    url: 'http://localhost:5173/index.html',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
