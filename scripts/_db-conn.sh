# shellcheck shell=bash
#
# Resolves a mysql:// or mariadb:// connection URL into the flags that the
# mysql-family clients actually understand.
#
# Why this exists: the application's DATABASE_URL is a URL, but mariadb-dump,
# mysqldump, mariadb and mysql all take positional database names plus
# --host/--port/--user flags. Passing the URL straight through makes them treat
# the entire string as a database name and fail, which is why the previous
# backup script had never successfully produced a backup.
#
# Usage:  source "$(dirname "$0")/_db-conn.sh"
#         resolve_db_url "$DATABASE_URL"     # sets the DB_* variables below
#
# Output variables: DB_HOST DB_PORT DB_USER DB_PASSWORD DB_NAME
#                   DB_CLIENT_ARGS (array, must be the FIRST arguments)

DB_HOST=""
DB_PORT="3306"
DB_USER=""
DB_PASSWORD=""
DB_NAME=""
DB_CLIENT_ARGS=()

# Writes the credential block to a 0600 defaults file so the password never
# appears on the process command line, and registers its removal on exit.
_db_write_defaults_file() {
  DB_DEFAULTS_FILE="$(mktemp)"
  chmod 600 "$DB_DEFAULTS_FILE"
  {
    printf '[client]\n'
    printf 'host=%s\n' "$DB_HOST"
    printf 'port=%s\n' "$DB_PORT"
    if [ -n "$DB_USER" ]; then printf 'user=%s\n' "$DB_USER"; fi
    if [ -n "$DB_PASSWORD" ]; then printf 'password=%s\n' "$DB_PASSWORD"; fi
  } >"$DB_DEFAULTS_FILE"
  DB_CLIENT_ARGS=("--defaults-extra-file=$DB_DEFAULTS_FILE")
  # `return` rather than exit: callers own the process and their own trap.
  trap '_db_cleanup_defaults_file' EXIT
}

_db_cleanup_defaults_file() {
  if [ -n "${DB_DEFAULTS_FILE:-}" ] && [ -f "$DB_DEFAULTS_FILE" ]; then
    rm -f "$DB_DEFAULTS_FILE"
  fi
}

resolve_db_url() {
  local url="$1"
  local rest authority credentials host_port

  DB_CLIENT_ARGS=()

  case "$url" in
    *"://") printf 'DATABASE_URL is missing a database name\n' >&2; return 1 ;;
    *"://"*/*) ;;
    *"://"*) printf 'DATABASE_URL is missing a database name\n' >&2; return 1 ;;
    *)
      # Not a URL: preserve the original behaviour of passing a bare database
      # name straight through, relying on socket authentication.
      DB_NAME="$url"
      return 0
      ;;
  esac

  rest="${url#*://}"
  # The password may itself contain '@', so split on the LAST '@' — the part
  # after it is unambiguously host[:port]/database.
  authority="${rest##*@}"
  credentials="${rest%"$authority"}"
  credentials="${credentials%@}"

  host_port="${authority%%/*}"
  DB_NAME="${authority#*/}"
  DB_NAME="${DB_NAME%%\?*}"

  case "$credentials" in
    *":"*) DB_USER="${credentials%%:*}"; DB_PASSWORD="${credentials#*:}" ;;
    *) DB_USER="$credentials"; DB_PASSWORD="" ;;
  esac

  case "$host_port" in
    *":"*) DB_HOST="${host_port%%:*}"; DB_PORT="${host_port##*:}" ;;
    *) DB_HOST="$host_port"; DB_PORT="3306" ;;
  esac

  if [ -z "$DB_NAME" ] || [ "$DB_NAME" = "$host_port" ]; then
    printf 'DATABASE_URL is missing a database name\n' >&2
    return 1
  fi

  _db_write_defaults_file
}
