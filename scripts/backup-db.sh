#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
mkdir -p "$BACKUP_DIR"

# shellcheck source=_db-conn.sh
source "$(dirname "$0")/_db-conn.sh"

# MariaDB 10.5 renamed mysqldump to mariadb-dump, and the official image does
# not always ship the compatibility symlink: the previous version of this
# script exited 127 with "mysqldump: command not found". Resolve whichever
# client is present.
if command -v mariadb-dump >/dev/null 2>&1; then
  DUMP_BIN="mariadb-dump"
elif command -v mysqldump >/dev/null 2>&1; then
  DUMP_BIN="mysqldump"
else
  printf 'Neither mariadb-dump nor mysqldump is on PATH\n' >&2
  exit 127
fi

resolve_db_url "$DATABASE_URL"

filename="$BACKUP_DIR/northline-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
tmpfile="${filename}.partial"
trap 'rm -f "$tmpfile"' EXIT
# resolve_db_url installed its own EXIT trap for the credentials file; layer
# the backup temp file onto it rather than clobbering it.
trap 'rm -f "$tmpfile"; _db_cleanup_defaults_file' EXIT

"${DUMP_BIN}" "${DB_CLIENT_ARGS[@]+"${DB_CLIENT_ARGS[@]}"}" \
  --single-transaction --quick --routines --triggers --skip-lock-tables \
  "$DB_NAME" | gzip -9 >"$tmpfile"

# A dump that failed mid-pipe still leaves a file behind, so assert on content
# rather than on the exit status of the pipeline alone.
test -s "$tmpfile"
gzip -t "$tmpfile"
mv "$tmpfile" "$filename"
sha256sum "$filename" >"${filename}.sha256"
find "$BACKUP_DIR" -type f -name 'northline-*.sql.gz' -mtime "+$RETENTION_DAYS" -delete
printf 'Created and verified %s\nChecksum: %s.sha256\n' "$filename" "$filename"
