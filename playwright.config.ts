import { defineConfig, devices } from "@playwright/test";

/**
 * Browser E2E — PRODUCTION_PLAN #9.
 *
 * `pnpm e2e` builds the production bundle and starts the real server against
 * the real database; nothing here is mocked. The specs therefore read the
 * email tokens straight out of the database instead of waiting for a mailbox,
 * which is the only part of the journey that cannot be driven through the UI.
 *
 * Provider credentials are blanked explicitly. `server/index.ts` begins with
 * `import "dotenv/config"`, so a developer's `.env` — which does carry a live
 * Resend key and `EMAIL_FROM` — would otherwise be pulled into the E2E server
 * and every registration would place a real API call. Blank (not deleted) so
 * dotenv's no-override rule keeps them blank: without `EMAIL_FROM` the send is
 * suppressed before any network I/O.
 */
const PORT = process.env.E2E_PORT ?? "3099";
const ORIGIN = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // The primary journey is inherently sequential — each step depends on the
  // state the previous one created — and every worker would otherwise share
  // one database.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: ORIGIN,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm e2e:server",
    url: `${ORIGIN}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: {
      PORT,
      // Neither of the obvious choices works here:
      //   test       — `server/index.ts` deliberately skips `app.listen()` so
      //                supertest can wrap the app, so the process runs the
      //                module and exits without ever binding the port.
      //   production — `assertProductionConfiguration()` demands HTTPS
      //                APP_URL plus EMAIL_FROM/RESEND/STORAGE_BACKEND, none
      //                of which a localhost harness has.
      // Development listens, keeps cookies non-Secure (required over plain
      // http), and returns early from that assertion. The demo-password hint
      // is unaffected: it is gated on `import.meta.env.DEV`, which Vite bakes
      // in at build time from `vite build`, not on server mode.
      NODE_ENV: "development",
      APP_URL: ORIGIN,
      ALLOWED_ORIGINS: ORIGIN,
      LOG_LEVEL: "warn",
      RESEND_API_KEY: "",
      EMAIL_FROM: "",
    },
  },
});
