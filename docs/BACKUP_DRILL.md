# Backup & restore drill record

**Drill #1 — 2026-09-26** · Status: **PASSED** · Next drill due: **2026-10-26** (monthly)

Runbook: [`BACKUP-RESTORE.md`](../BACKUP-RESTORE.md) · Script: [`scripts/backup-db.sh`](../scripts/backup-db.sh)

---

## Result

| Step | Outcome |
| --- | --- |
| Backup created | `northline-20260926T160401Z.sql.gz` |
| gzip integrity | `gzip -t` OK |
| Checksum written & verified | `.sha256` written; `sha256sum -c` → **OK** |
| Interlock (refuse unconfirmed restore) | **PASS** — exited `2` without `CONFIRM_RESTORE` |
| Restore into disposable DB | **PASS** — exit `0` |
| Row-by-row comparison, 19 tables | **ALL MATCH EXACTLY** |
| Full test suite against restored DB | **PASS — 53/53, 19/19 files** |

## Environment

- MariaDB 11.4 in Docker (`northline-verify-db`), host port 3310
- Source database `northline_ci` (migrated + seeded)
- Restore target `northline_drill` — created fresh for this drill, dropped beforehand
- Backup executed inside the database container, where the MariaDB client tools live

## Source vs restored row counts

```
attendance                 0        plans                     3
audit_logs               542        project_assignments       0
billing_events            72        rate_limit_buckets        40
companies                237        sessions                 449
email_verification_tokens 224       subscriptions           224
expenses                  0        users                    256
invitations               26        __drizzle_migrations      15
issues                     0
materials                  0        19 tables total
material_transactions      0
password_reset_tokens     13
projects                  69
```

All 19 counts matched the source exactly after restore.

## Verification performed

1. `scripts/backup-db.sh` — dump, compress, `gzip -t`, `sha256sum`.
2. `scripts/restore-db.sh` **without** `CONFIRM_RESTORE` → refused, exit 2 (proves the
   "never restore over production" interlock works).
3. `scripts/restore-db.sh` **with** `CONFIRM_RESTORE=northline_drill` → exit 0, checksum
   re-verified before the pipe.
4. Per-table `COUNT(*)` diff source vs restored — 19/19 identical.
5. `pnpm test` with `DATABASE_URL` pointed at `northline_drill` → **53/53 passed in 31.9s**.
   This is the end-to-end proof: it exercises `/health`, login, session cookies,
   tenant-scoped listing and the cross-tenant denial matrix against the restored data.

## Defects found by this drill (and fixed)

The script had **never been executed** — running it exposed three defects that would have
made a real recovery impossible:

1. **`mysqldump: command not found`** (exit 127). MariaDB 10.5 renamed the binary to
   `mariadb-dump` and the official image does not ship the compatibility symlink. The script
   now resolves `mariadb-dump` or `mysqldump`, whichever exists.
2. **`DATABASE_URL` is a URL; the clients do not accept one.** `mysqldump
   "mysql://user:pass@host/db"` treats the whole string as a *database name*. The documented
   restore command `mysql "$RESTORE_DATABASE_URL"` had the identical defect. Both now parse
   the URL via the shared `scripts/_db-conn.sh`, which writes a `0600` client defaults file
   so the password never appears on the process command line.
3. **No restore script and no confirmation guard.** Added `scripts/restore-db.sh`, which
   verifies the `.sha256` before piping and refuses to run unless `CONFIRM_RESTORE` equals
   the target database name.

## Still outstanding

- **Off-region copy.** The 14 daily / 4 weekly retention rotates on local disk only. There is
  no second copy in another region/provider yet — that requires the object-storage account
  (Wave 1C). Until then a host loss takes the backups with it.
- **Scheduler.** No cron/CI job runs `backup-db.sh` nightly. This is a manual drill until a
  scheduler is configured on the hosting platform.
- **`/app/uploads` and `/app/audit` are not in these backups** (filesystem assets). The
  Dockerfile creates them with no volume attached, so they are lost on redeploy — tracked as
  blocker #6.

## How to re-run this drill

```bash
# inside a container that has the MariaDB client tools
BACKUP_DIR=/tmp/backups DATABASE_URL="$DATABASE_URL" ./scripts/backup-db.sh

RESTORE_DATABASE_URL="$URL_TO_DISPOSIBLE_DB" \
CONFIRM_RESTORE=disposable_db \
  ./scripts/restore-db.sh /tmp/backups/northline-<ts>.sql.gz

DATABASE_URL="$URL_TO_DISPOSIBLE_DB" pnpm test
```

Record the date, backup identifier, table comparison and test result here.
