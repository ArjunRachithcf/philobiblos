// End-to-end tests: the built server and web app, a fresh data folder each run, Chromium with a virtual
// authenticator (real WebAuthn), and axe on every screen. Run: pnpm --filter @philobiblos/web e2e (after pnpm build).
import { defineConfig, devices } from '@playwright/test';
import { PORT, SEEDED_PORT } from './e2e/env';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list']],
  use: { trace: 'retain-on-failure', locale: 'en-GB', timezoneId: 'Europe/Zurich' },
  projects: [
    { name: 'chromium', testIgnore: /seeded/, use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${PORT}` } },
    { name: 'chromium-seeded', testMatch: /seeded/, use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${SEEDED_PORT}` } },
  ],
  webServer: [
    { command: `node e2e/serve.mjs ${PORT}`, url: `http://localhost:${PORT}/api/health`, reuseExistingServer: false, stdout: 'ignore', stderr: 'pipe' },
    { command: `node e2e/serve.mjs ${SEEDED_PORT} seed-sample`, url: `http://localhost:${SEEDED_PORT}/api/health`, reuseExistingServer: false, stdout: 'ignore', stderr: 'pipe' },
  ],
});
