#!/usr/bin/env bash
set -euo pipefail
BASE_URL="${1:-http://localhost:3000}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

login_status=$(curl -sS -o "$TMP_DIR/login.json" -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@construction.local","password":"Admin123!"}' \
  "$BASE_URL/auth/login")
[[ "$login_status" == "200" ]] || { echo "login_status=$login_status"; cat "$TMP_DIR/login.json"; exit 1; }

token=$(jq -r '.token' "$TMP_DIR/login.json")
[[ -n "$token" && "$token" != "null" ]] || { echo "missing_token"; exit 1; }

users_status=$(curl -sS -o "$TMP_DIR/users.json" -w '%{http_code}' \
  -H "Authorization: Bearer $token" "$BASE_URL/users")
[[ "$users_status" == "200" ]] || { echo "users_status=$users_status"; cat "$TMP_DIR/users.json"; exit 1; }

if jq -e '.. | objects | has("passwordHash")' "$TMP_DIR/users.json" >/dev/null; then
  echo "password_hash_redaction=failed"
  exit 1
fi

invalid_status=$(curl -sS -o "$TMP_DIR/invalid.json" -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@construction.local","password":"wrong-password"}' \
  "$BASE_URL/auth/login")
[[ "$invalid_status" == "401" ]] || { echo "invalid_login_status=$invalid_status"; exit 1; }

worker_token=$(curl -sS \
  -H 'Content-Type: application/json' \
  -d '{"email":"worker@construction.local","password":"Worker123!"}' \
  "$BASE_URL/auth/login" | jq -r '.token')
forbidden_status=$(curl -sS -o "$TMP_DIR/forbidden.json" -w '%{http_code}' \
  -H "Authorization: Bearer $worker_token" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Should Fail","email":"should-fail@construction.local","password":"ShouldFail123!","role":"worker"}' \
  "$BASE_URL/users")
[[ "$forbidden_status" == "403" ]] || { echo "non_admin_create_status=$forbidden_status"; exit 1; }

echo "login_status=$login_status"
echo "admin_users_status=$users_status"
echo "password_hash_redaction=passed"
echo "invalid_login_status=$invalid_status"
echo "non_admin_create_status=$forbidden_status"
echo "sample_project_present=$(jq '[.users[] | select(.name == "Ahmed Said")] | length > 0' "$TMP_DIR/users.json")"
