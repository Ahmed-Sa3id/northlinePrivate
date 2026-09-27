# Northline backup and restore runbook

Northline uses MariaDB/MySQL for tenant data. Backups must be encrypted, stored outside the application container, and tested regularly rather than assumed to be provided by the hosting platform.

## Recommended policy

Run a nightly logical backup with `scripts/backup-db.sh`, retain at least 14 daily copies and four weekly copies, and keep one encrypted copy in a separate region or provider. Use a persistent volume or managed object storage for uploads and operational audit files; database backups do not include those filesystem assets.

`.github/workflows/backup.yml` implements the nightly part of that policy. Its `backup` job runs at 03:00 UTC against whatever the `DATABASE_URL` repository secret names and uploads the dump with its checksum as an artifact for 30 days, reporting a clean skip while that secret is unset. Its `drill` job runs every night regardless: it seeds a database, dumps it with the same script, restores into an isolated copy with `CONFIRM_RESTORE` set, and then runs the **whole test suite against the restored data**. That keeps the monthly manual drill in [`docs/BACKUP_DRILL.md`](./docs/BACKUP_DRILL.md) from being the only thing standing between the team and a backup script that has quietly stopped working.

## Backup

From a trusted environment with `DATABASE_URL` configured:

```bash
BACKUP_DIR=/secure/northline-backups RETENTION_DAYS=14 ./scripts/backup-db.sh
```

The script resolves `mariadb-dump` or `mysqldump` (MariaDB 10.5 renamed the binary and not every image keeps the compatibility symlink), parses `DATABASE_URL` — which neither client understands natively — into a temporary `0600` client defaults file so the password never reaches the process command line, then dumps with `--single-transaction --quick --routines --triggers`, compresses the output, verifies it with `gzip -t`, and writes a `.sha256` checksum. It removes files older than the configured retention period. Do not place `DATABASE_URL` or backup files in Git.

## Restore drill

Restore into an isolated empty database first, never directly over production:

```bash
# create the disposable target, then grant the app user access to it
CONFIRM_RESTORE=northline_drill \
RESTORE_DATABASE_URL=mysql://user:pass@host:3306/northline_drill \
  ./scripts/restore-db.sh /secure/northline-backups/northline-YYYYMMDDTHHMMSSZ.sql.gz
```

`restore-db.sh` re-checks the `.sha256`, and **exits 2 unless `CONFIRM_RESTORE` matches the target database name** — that interlock is what stops a recovery from being run straight over production.

Run `pnpm db:push` only for additive schema changes, then run `pnpm db:seed:demo` if a non-production demonstration dataset is required. Verify `/health`, login, tenant-scoped project listing, and a cross-tenant access denial before considering the restore valid — running `DATABASE_URL=<restored db> pnpm test` covers all four at once. Record the restore date, backup identifier, schema version, and test result in the drill log.

Drill results are recorded in [`docs/BACKUP_DRILL.md`](./docs/BACKUP_DRILL.md). The drill must be repeated monthly; **drill #1 passed on 2026-09-26**, next due 2026-10-26.

## Operational checks

`GET /health` returns application and database status without credentials or connection details. A `503` means traffic should be kept away from the instance until the database connection is restored. Application logs must not contain passwords, JWTs, database URLs, or invitation tokens.
