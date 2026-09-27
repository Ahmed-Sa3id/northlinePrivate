import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

// The suite is 19 integration files that each boot the whole Express app and
// open their own MySQL pool. Vitest's default worker count is `cores - 1`,
// which oversubscribes a machine that is also running Docker, a database and
// a dev server: measured 11 concurrent workers, and the tenant isolation
// matrix slowed from 10.2s in isolation to 24.0s under load — close enough to
// a 30s timeout to fail intermittently. Capping the pool bounds that
// contention; on runners with 7 cores or fewer (including GitHub's 4-vCPU
// runner) this is a no-op, so CI keeps its existing concurrency.
const cores = availableParallelism();
const maxWorkers = Math.max(1, Math.min(6, cores - 1));

export default defineConfig({
  root: ".",
  test: {
    include: ["server/**/*.test.ts"],
    // Set here rather than as a `NODE_ENV=test …` prefix in the package
    // script: that prefix only works in POSIX shells, so `pnpm test` was
    // failing outright for anyone on Windows.
    //
    // `LOG_LEVEL: "warn"` keeps the per-request access log out of the test
    // output (every test issues dozens of requests); warn and error still
    // print, and the observability suite opts back into `info` explicitly.
    //
    // The provider credentials are blanked deliberately. `server/index.ts`
    // starts with `import "dotenv/config"`, so a developer's real `.env` is
    // loaded into every test worker — and once `EMAIL_FROM` is set there,
    // each `POST /auth/register` in the suite placed a live call to Resend.
    // Blank (not absent) so dotenv's no-override rule keeps them blank, and
    // the suites that exercise the transport set their own values and stub
    // `fetch`.
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "warn",
      RESEND_API_KEY: "",
      EMAIL_FROM: "",
    },
    maxWorkers,
    // Tinypool rejects a `maxThreads` below its default `minThreads`, so the
    // floor has to be lowered alongside the cap.
    minWorkers: 1,
    // Integration suites against MariaDB: bcrypt cost 12 plus real database
    // round-trips regularly exceed Vitest's 5s unit-test default, and the
    // heaviest matrix test needs ~10s alone / ~24s under load. 60s is a
    // ceiling for genuine hangs, not a target for slow tests.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
