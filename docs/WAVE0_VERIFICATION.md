# Wave 0 Verification Record

**Date:** 2026-09-26
**Source:** `Northline-part4-final.zip`
**Environment:** Node 22.9, pnpm 10.4.1, MariaDB 11.4 (Docker), Windows host

## Result

| Check | Before | After |
| --- | --- | --- |
| Migrations from empty database | **FAIL** (exit 1, silent) | **PASS** — 15/15 applied |
| Full test suite | **FAIL** (25 failures unseeded / 12 seeded) | **PASS** — 53/53 across 19 files |
| `pnpm lint` (Prettier) | PASS | PASS |
| `pnpm check` (tsc) | PASS | PASS |
| `pnpm build` | PASS | PASS |
| CI seed step | missing | added |
| CI `JWT_SECRET` | **invalid** (24 chars) | fixed (41 chars) |
| `pnpm db:seed` | **hangs forever** | exits cleanly |
| `docker build` | **FAIL** (no `.dockerignore`) | **PASS** — image boots, `/health` `database: ok` |
| Flaky billing webhook test | **FAIL** intermittently | **PASS** — `OR` precedence bug fixed |
| `pnpm test` on Windows | **FAIL** (POSIX-only script) | **PASS** — runs under `cmd` |
| Suite stability | 1 flaky + timeout under load | **PASS** — 3/3 consecutive full runs green |

---

## 1. Migrations failed from an empty database

**Symptom:** `drizzle-kit migrate` exited 1 printing *nothing at all* — no error, no stack.

**Evidence:** a clean database ended with 13 of 15 migration rows recorded, yet
`invitations.revokedAt` existed and `invitations_expiry_idx` did not.

**Root cause:** `drizzle/0013_curved_sir_ram.sql` was the only migration file ending with a
dangling `--> statement-breakpoint` marker:

```sql
ALTER TABLE `invitations` ADD `revokedAt` timestamp;--> statement-breakpoint
```

`readMigrationFiles` in `drizzle-orm` splits on that marker with no empty-statement filtering:

```js
const result = query.split("--> statement-breakpoint").map((it) => it);
```

so migration 0013 resolved to two statements: the `ALTER` and a whitespace-only `""`.
The `ALTER` ran first — and because MySQL/MariaDB DDL **implicitly commits**, the column
survived — then the empty statement threw, rolling back the transaction and with it the
`__drizzle_migrations` row for 0013. Migration 0014 never ran. On re-run the same failure
recurred, so the chain could never complete.

**Fix:** removed the dangling marker so 0013 contains exactly one statement.

**Verified:** fresh database → `drizzle-kit generate && drizzle-kit migrate` exits 0,
`__drizzle_migrations` reaches id 15, `revokedAt` and `invitations_expiry_idx` both present.

---

## 2. The test suite could never go green

Four independent causes, one of them a real product bug.

### 2a. CI never seeded the database

`.github/workflows/ci.yml` ran `db:push` then `test`, but roughly 25 tests authenticate as
seeded demo accounts (`admin@construction.local`, `worker@construction.local`, …) and got 401.
**Fix:** added `pnpm db:seed` between `db:push` and the checks.

### 2b. The CI JWT secret was below the application's own minimum

`auth.ts` rejects any secret shorter than 32 characters in *every* environment:

```ts
function secretKey() {
  if (!ENV.cookieSecret || ENV.cookieSecret.length < 32)
    throw new Error("JWT_SECRET must be at least 32 characters");
```

The workflow set `JWT_SECRET: ci-only-secret-change-me` — **24 characters**. Every
authenticated request therefore returned 500. CI, as committed, could never pass.
**Fix:** replaced with a 41-character placeholder.

### 2c. Unit-test timeouts on an integration suite

Vitest's 5000ms default produced 11 failures that were timeouts, not assertion breaks —
bcrypt cost 12 plus real database round-trips. **Fix:** `testTimeout`/`hookTimeout` raised to
30s in `vitest.config.ts`. No assertion was weakened.

### 2d. Real bug: advisory locks released before COMMIT

`GET_LOCK`/`RELEASE_LOCK` are **session**-scoped, not transaction-scoped, but all three call
sites acquired and released them *inside* the `db.transaction` callback:

```ts
return db.transaction(async (tx) => {
  // GET_LOCK ...
  try {
    return await operation(tx);
  } finally {
    await tx.execute(sql`SELECT RELEASE_LOCK(...)`); // runs before COMMIT
  }
});
```

The lock therefore dropped just before the write became visible. A waiter acquired it, took
its REPEATABLE READ snapshot at that moment, and read the **pre-commit** count — passing the
same limit check.

**Reproduced** (3 runs, pre-fix): 3 projects created on a 1-project plan, 3 users on a
2-user plan, only 8× 429 instead of ≥10 on a 10-attempt login limit. Failures were flaky
(pass/fail/pass), which is exactly the signature of a lost-update race.

**Fix:** new `server/lock.ts` exposes `withAdvisoryLock()`, which pins one pooled connection
for the whole critical section:

```
GET_LOCK -> BEGIN -> work -> COMMIT -> RELEASE_LOCK -> connection returned
```

Each caller holds exactly one connection, so contention produces back-pressure rather than
deadlock. Applied to all three sites:

- `server/subscription.ts` — project and user plan limits
- `server/rateLimit.ts` — login/registration throttle
- `server/routes/platform.ts` — billing checkout reservation

**Verified:** concurrency suite run 5/5 green post-fix (was failing 2/3).

---

## 3. `pnpm db:seed` never exits

`seed.ts` and `seed-demo.ts` ended with `main().catch(...)` and left the mysql2 pool open,
keeping the event loop alive indefinitely — the script completed its work but never
returned. Any CI or deploy step waiting on it would hang.

**Fix:** added `closeDb()` to `server/db.ts` and called it from both seeds' `finally`.
Measured: 9.7s and exits cleanly (previously infinite).

---

## 4. Full clean-database CI simulation

```
DROP/CREATE northline_ci
pnpm db:push   -> exit 0   (15 migrations from empty)
pnpm db:seed   -> exit 0   (14.8s, terminates)
pnpm lint      -> exit 0
pnpm check     -> exit 0
vitest run     -> exit 0   (53/53 tests, 19/19 files)
pnpm build     -> exit 0   (Vite client + esbuild server)
docker build   -> exit 0   (multi-stage, image boots and serves /health)
```

---

## 5. Docker build failed — missing `.dockerignore`

`Dockerfile:7` failed with `Cannot find module '/app/node_modules/typescript/bin/tsc'`.

**Root cause:** there was no `.dockerignore`. `COPY . .` at `Dockerfile:6` ran *after*
`pnpm install` and therefore overwrote the freshly-installed Linux `node_modules` with the
host's Windows pnpm symlink/junction layout, leaving every binary unresolvable. The same
oversight also copied local `uploads/`, `audit/`, `dist/`, `dist-server/` and `.env` files
into the image.

**Fix:** added `.dockerignore` excluding `node_modules`, `dist`, `dist-server`, `uploads`,
`audit`, `.env*`, `*.log`, `.git`, `.github`.

**Verified:** `docker build` exit 0. The image was then run against the database and
checked end to end:

```
/livez  -> 200 {"ok":true,"application":"ok"}
/health -> 200 {"ok":true,"application":"ok","database":"ok"}
/readyz -> 200 {"ok":true,"application":"ok","database":"ok"}
POST /auth/login -> 200 (session cookie set)
GET /projects    -> 200 (tenant-scoped data returned)
```

---

## 6. Real bug: unparenthesised `OR` broke webhook duplicate detection

`server/billing.integration.test.ts > ignores duplicates` failed intermittently —
only under full-suite parallelism, never in isolation (6/6 green alone).

**Root cause** — in `POST /billing/webhook`, the event-claim query combined raw SQL with
`and()`:

```ts
and(
  eq(billingEvents.provider, "stripe"),
  eq(billingEvents.providerEventId, event.id),
  isNull(billingEvents.processingAt),
  sql`processingAt IS NULL OR processingAt < DATE_SUB(NOW(), INTERVAL 5 MINUTE)`,
)
```

Drizzle inlines that fragment verbatim and does not parenthesise it, so the emitted SQL
(probed with `.toSQL()`) was:

```sql
where (provider = ? and providerEventId = ? and processedAt is null
       and processingAt IS NULL OR processingAt < DATE_SUB(NOW(), INTERVAL 5 MINUTE))
```

`AND` binds tighter than `OR`, so the predicate degraded to *this event* **OR** *any row
whose `processingAt` is stale*. Two consequences:

1. The claim `UPDATE` rewrote `processingAt` on **unrelated, already-processed** events —
   confirmed directly: rows created at `10:20` and `10:37` still had their original
   `processedAt` but their `processingAt` had been bumped to `10:49:14`.
2. `affectedRows` was therefore `> 0` for the *second* delivery, so instead of taking the
   idempotent `{duplicate: true}` branch the handler fell through and re-processed the
   event, returning `{received: true}`.

Duplicate detection only worked inside the ~5 minute window in which no unrelated row was
yet stale — which is exactly why the test was green immediately after a previous failing
run and red otherwise.

**Fix:** wrap the fragment — ``sql`(processingAt IS NULL OR processingAt < DATE_SUB(NOW(), INTERVAL 5 MINUTE))` ``.
Verified the generated SQL, and a repo-wide sweep for ``sql`… OR …` `` inside `and()` found
this as the only occurrence.

---

## 7. The suite was still timing out under load

With billing fixed, one run failed on `tenant.matrix.integration.test.ts` — `Test timed out
in 30000ms`. In isolation the same test takes **10.2s**, so this looked like a hang; it is not.

**Root cause: worker oversubscription, not a defective test.**

| Measurement | Value |
| --- | --- |
| `tenant.matrix` alone | 10.2s |
| `tenant.matrix` under full suite (default workers) | 24.0s — and >30s on the failing run |
| Vitest default worker count on this box | 11 (`cores - 1`, 12 logical cores) |
| Peak `Threads_connected` / `Threads_running` | 16 / 11 — DB headroom fine (`max_connections` 151) |
| Docker VM CPUs | 12, no container limits |

The database was never the constraint — **CPU was**. Each of the 19 workers runs a full
Express app plus TypeScript transform, so 11 workers on 12 shared cores inflated the
heaviest test by 2.4×, leaving only 6s under the 30s ceiling.

**Fixes:**
- `vitest.config.ts` caps `maxWorkers` at 6 (`cores - 1` otherwise, `minWorkers: 1` because
  Tinypool rejects a `maxThreads` below its default `minThreads`). On runners with ≤7 cores —
  including GitHub's 4-vCPU runner — this is a **no-op**, so CI keeps its existing concurrency.
- `testTimeout`/`hookTimeout` raised 30s → **60s**, sized from the measured load figure rather
  than guessed.

**Result:** 3/3 consecutive full runs green.

| Metric | Before | After |
| --- | --- | --- |
| `tenant.matrix` under load | 24.0s, >30s on failing run | **16.2–17.4s (stable)** |
| `collect` (CPU-bound transform) | 398–480s | **213–244s** |
| Headroom under timeout | 6s (0%) | **~43s (3.5×)** |

---

## Notes and residual risks

- **Node version:** Vite warns that 22.9.0 is below its required 22.12+. CI pins
  `node-version: 22`, which resolves to a current 22.x and is unaffected; local machines
  should upgrade.
- **Rate limiting counts successful logins too.** `consumeDatabaseBucket` pushes a timestamp
  for every attempt, not just failures, so ten legitimate logins from one account/IP within
  the window lock that account out. Not a regression — it is existing behaviour — but it
  should be reconsidered before public launch.
- **`pnpm test` is Unix-only** — **resolved.** The `NODE_ENV=test …` prefix only works in a
  POSIX shell. `NODE_ENV=test` now lives in `vitest.config.ts` (`test.env`), so `pnpm test`
  runs under `cmd` as well; the suite was executed that way on this machine.
- **Dual lockfiles** — **resolved.** `package-lock.json` deleted; `pnpm-lock.yaml` is the
  single source of truth and `pnpm install --frozen-lockfile` is green.
