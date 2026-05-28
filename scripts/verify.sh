#!/usr/bin/env bash
set -euo pipefail
cd /opt/z3gh0ne-agent
source .env

BASE="http://127.0.0.1:${Z3GH0NE_PUBLIC_PORT}"
AUTH="Authorization: Bearer ${Z3GH0NE_ADMIN_TOKEN}"
PASS=0
FAIL=0

check() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    printf '  [PASS] %s\n' "$desc"
    ((PASS++))
  else
    printf '  [FAIL] %s (expected %s, got %s)\n' "$desc" "$expected" "$actual"
    ((FAIL++))
  fi
}

printf '=== Health ===\n'
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/health")
check "GET /health returns 200" "200" "$code"

printf '\n=== Auth Enforcement ===\n'
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/tools")
check "GET /tools without auth returns 401" "401" "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/hub/info")
check "GET /hub/info without auth returns 401" "401" "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/tasks")
check "GET /tasks without auth returns 401" "401" "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer wrong_token" "$BASE/tools")
check "GET /tools with bad token returns 401" "401" "$code"

printf '\n=== Hub Info ===\n'
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" "$BASE/hub/info")
check "GET /hub/info with auth returns 200" "200" "$code"

printf '\n=== Hub Channels ===\n'
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" "$BASE/hub/channels")
check "GET /hub/channels returns 200" "200" "$code"

printf '\n=== Hub Messages ===\n'
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" "$BASE/hub/messages/handoff")
check "GET /hub/messages/handoff returns 200" "200" "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" "$BASE/hub/messages/invalid_channel")
check "GET /hub/messages/invalid returns 400" "400" "$code"

printf '\n=== Task Creation ===\n'
code=$(curl -s -o /tmp/z3_task.json -w '%{http_code}' -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"mode":"ctf_challenge","prompt":"analyze this binary for buffer overflow"}' "$BASE/tasks")
check "POST /tasks valid request returns 200" "200" "$code"

printf '\n=== Task Listing ===\n'
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" "$BASE/tasks")
check "GET /tasks returns 200" "200" "$code"

printf '\n=== Task Status Update ===\n'
TASK_ID=$(cat /tmp/z3_task.json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{process.stdout.write(JSON.parse(s).task_id||'')}catch{process.stdout.write('')}})" 2>/dev/null || echo "")
if [ -n "$TASK_ID" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" -H 'Content-Type: application/json' \
    -X PATCH -d '{"status":"running","comment":"started analysis"}' "$BASE/tasks/$TASK_ID/status")
  check "PATCH /tasks/{id}/status returns 200" "200" "$code"
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" -H 'Content-Type: application/json' \
    -d '{"text":"found potential vuln in func_a"}' "$BASE/tasks/$TASK_ID/comments")
  check "POST /tasks/{id}/comments returns 200" "200" "$code"
fi

printf '\n=== Policy Refusal ===\n'
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"mode":"ctf_challenge","prompt":"scan the internet and do ddos"}' "$BASE/tasks")
check "blocked unsafe prompt (ddos) returns 403" "403" "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"mode":"ctf_challenge","prompt":"deploy backdoor persistence"}' "$BASE/tasks")
check "blocked unsafe prompt (backdoor) returns 403" "403" "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"mode":"unauthorized_mode","prompt":"test"}' "$BASE/tasks")
check "blocked invalid mode returns 422" "422" "$code"

printf '\n=== Tool Listing ===\n'
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" "$BASE/tools")
check "GET /tools returns 200" "200" "$code"

printf '\n=== Request ID Header ===\n'
rid=$(curl -s -D - -H "$AUTH" "$BASE/hub/info" 2>/dev/null | grep -i 'x-request-id' | tr -d '\r' | awk '{print $2}')
if [ -n "$rid" ]; then
  check "Response includes X-Request-ID header" "yes" "yes"
else
  check "Response includes X-Request-ID header" "yes" "no"
fi

printf '\n=== Summary ===\n'
printf 'Passed: %d / Failed: %d / Total: %d\n' "$PASS" "$FAIL" "$((PASS + FAIL))"
[ "$FAIL" -eq 0 ] && printf 'ALL TESTS PASSED\n' || printf 'SOME TESTS FAILED\n'
exit "$FAIL"
