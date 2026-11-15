// End-to-end tests: the built server and web app, a fresh data folder each run, Chromium with a virtual
// authenticator (real WebAuthn), and axe on every screen. Run: pnpm --filter @shelf/web e2e (after pnpm build).
import { defineConfig, devices } from '@playwright/test';
import { PORT } from './e2e/env';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure', locale: 'en-GB', timezoneId: 'Europe/Zurich' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: { command: 'node e2e/serve.mjs', url: `http://localhost:${PORT}/api/health`, reuseExistingServer: false, stdout: 'ignore', stderr: 'pipe' },
});
