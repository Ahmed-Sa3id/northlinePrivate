#!/usr/bin/env bash
set -euo pipefail

# Restores a backup produced by backup-db.sh into a target database.
#
#   CONFIRM_RESTORE=<dbname> RESTORE_DATABASE_URL=mysql://... ./scripts/restore-db.sh backups/northline-....sql.gz
#
# CONFIRM_RESTORE must equal the database name in RESTORE_DATABASE_URL. The
# runbook requires restoring into an isolated database first and never over
# production, and a forgotten interlock is cheaper than an overwritten tenant.
#
# This replaces the previous documented command, which piped into
# `mysql "$RESTORE_DATABASE_URL"` — the mysql client does not understand URLs
# and would have failed the same way the backup script did.

: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL is required}"

backup_file="${1:?Usage: restore-db.sh <backup.sql.gz>}"

test -f "$backup_file"
gzip -t "$backup_file"

if [ -f "${backup_file}.sha256" ]; then
  # The checksum file records an absolute path, so verify from its directory.
  (cd "$(dirname "$backup_file")" && sha256sum -c "$(basename "$backup_file").sha256")
else
  printf 'Warning: no .sha256 alongside %s; integrity is unverified\n' "$backup_file" >&2
fi

if command -v mariadb >/dev/null 2>&1; then
  CLIENT_BIN="mariadb"
elif command -v mysql >/dev/null 2>&1; then
  CLIENT_BIN="mysql"
else
  printf 'Neither mariadb nor mysql is on PATH\n' >&2
  exit 127
fi

# shellcheck source=_db-conn.sh
source "$(dirname "$0")/_db-conn.sh"
resolve_db_url "$RESTORE_DATABASE_URL"

if [ "${CONFIRM_RESTORE:-}" != "$DB_NAME" ]; then
  printf 'Refusing to restore into "%s".\n' "$DB_NAME" >&2
  printf 'Set CONFIRM_RESTORE=%s to confirm this is a disposable database,\n' "$DB_NAME" >&2
  printf 'not production.\n' >&2
  exit 2
fi

gunzip -c "$backup_file" | "$CLIENT_BIN" "${DB_CLIENT_ARGS[@]+"${DB_CLIENT_ARGS[@]}"}" "$DB_NAME"

printf 'Restored %s into %s@%s:%s/%s\n' "$backup_file" "$DB_USER" "$DB_HOST" "$DB_PORT" "$DB_NAME"
