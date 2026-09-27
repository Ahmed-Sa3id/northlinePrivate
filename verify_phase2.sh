#!/usr/bin/env bash
set -euo pipefail
BASE_URL="${1:-http://localhost:3000}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

login() {
  curl -sS -H 'Content-Type: application/json' \
    -d '{"email":"admin@construction.local","password":"Admin123!"}' \
    "$BASE_URL/auth/login" | jq -r '.token'
}
TOKEN="$(login)"
AUTH=(-H "Authorization: Bearer $TOKEN")

get_status() {
  curl -sS "${AUTH[@]}" -o "$TMP_DIR/response.json" -w '%{http_code}' "$1"
}

projects_status="$(get_status "$BASE_URL/projects")"
[[ "$projects_status" == "200" ]] || { cat "$TMP_DIR/response.json"; exit 1; }
PROJECT_ID="$(jq -r '.projects[0].id' "$TMP_DIR/response.json")"
[[ "$PROJECT_ID" != "null" && -n "$PROJECT_ID" ]] || { echo "missing_sample_project"; exit 1; }
single_project_status="$(get_status "$BASE_URL/projects/$PROJECT_ID")"
[[ "$single_project_status" == "200" ]] || { cat "$TMP_DIR/response.json"; exit 1; }

expenses_status="$(get_status "$BASE_URL/expenses")"
materials_status="$(get_status "$BASE_URL/materials")"
issues_status="$(get_status "$BASE_URL/issues")"
[[ "$expenses_status" == "200" && "$materials_status" == "200" && "$issues_status" == "200" ]] || { echo "module_read_failed"; exit 1; }

create_status=$(curl -sS "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d '{"name":"Phase 2 Smoke Project","location":"Test Site","status":"planned","budget":1000}' \
  -o "$TMP_DIR/create-project.json" -w '%{http_code}' "$BASE_URL/projects")
[[ "$create_status" == "201" ]] || { cat "$TMP_DIR/create-project.json"; exit 1; }
CREATED_ID="$(jq -r '.project.id' "$TMP_DIR/create-project.json")"

patch_status=$(curl -sS "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d '{"status":"active"}' -o "$TMP_DIR/patch-project.json" -w '%{http_code}' \
  -X PATCH "$BASE_URL/projects/$CREATED_ID")
[[ "$patch_status" == "200" ]] || { cat "$TMP_DIR/patch-project.json"; exit 1; }

delete_status=$(curl -sS "${AUTH[@]}" -o /dev/null -w '%{http_code}' -X DELETE \
  "$BASE_URL/projects/$CREATED_ID")
[[ "$delete_status" == "204" ]] || { echo "delete_project_status=$delete_status"; exit 1; }

echo "projects_status=$projects_status"
echo "single_project_status=$single_project_status"
echo "expenses_status=$expenses_status"
echo "materials_status=$materials_status"
echo "issues_status=$issues_status"
echo "project_create_status=$create_status"
echo "project_patch_status=$patch_status"
echo "project_delete_status=$delete_status"
