#!/usr/bin/env bash
# Night Shift phase-0 verify: one command, labeled PASS/FAIL lines, exit 0 only
# when everything Night Shift depends on is in place. Default is offline (no
# network calls beyond localhost); --live steps outside (GitHub, outbound).
set -u

LIVE=0
[ "${1:-}" = "--live" ] && LIVE=1

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

STATUS=0

pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; STATUS=1; }

ver_ge() { printf '%s\n%s' "$2" "$1" | sort -V | head -n 1 | grep -qx "$2"; }

node_ver="$(node --version 2>/dev/null | sed 's/^v//')"
if [ -n "$node_ver" ] && ver_ge "$node_ver" "22.0"; then
    pass "node >=22 ($node_ver)"
else
    fail "node >=22 (got: ${node_ver:-none})"
fi

if command -v opencode >/dev/null 2>&1; then
    pass "worker cli opencode present ($(opencode --version 2>/dev/null | head -n1))"
else
    fail "worker cli opencode absent"
fi

if command -v gh >/dev/null 2>&1; then
    pass "gh present"
else
    fail "gh absent"
fi

git name-rev --name-only HEAD >/dev/null 2>&1 &&
    pass "workspace is a git repo" || fail "workspace is not a git repo"
git -C target rev-parse HEAD >/dev/null 2>&1 &&
    pass "target repo initialized" || fail "target repo missing"

gh_user="$(gh api user -q .login 2>/dev/null)"
if [ -n "$gh_user" ]; then
    pass "gh authenticated as $gh_user"
    if [ "$LIVE" -eq 1 ]; then
        gh api repos/shashwat558/nightshift-target >/dev/null 2>&1 &&
            pass "target repo visible on github" ||
            fail "target repo not visible on github"
        gh api /user --jq .login >/dev/null 2>&1 &&
            pass "outbound github reachable" || fail "outbound github unreachable"
    fi
else
    fail "gh not authenticated"
fi

docker ps >/dev/null 2>&1 &&
    pass "docker reachable" || fail "docker unreachable"

sw="$(curl -fsS --max-time 3 http://127.0.0.1:8000/health 2>/dev/null)"
case "$sw" in
*'"status":"ok"'*) pass "switch server healthy on :8000" ;;
*'{"status":"ok"'*) pass "switch server healthy on :8000" ;;
*ok*) pass "switch server healthy on :8000" ;;
*) fail "switch server unhealthy on :8000 ($sw)" ;;
esac

mm="$(curl -fsS --max-time 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:8065/ 2>/dev/null)"
[ "$mm" = "200" ] &&
    pass "mattermost reachable on :8065" || fail "mattermost (:8065) returned $mm"

gw="$(curl -fsS --max-time 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/ 2>/dev/null)"
[ "$gw" = "200" ] &&
    pass "gateway reachable on :3100" || fail "gateway (:3100) returned code ${gw:-none}"

if [ -f ops/.env ]; then
    pass "ops/.env present"
else
    fail "ops/.env missing"
fi

( cd target && npm test >/dev/null 2>&1 ) &&
    pass "target tests green" || fail "target tests failing"

( cd target && git status --porcelain | grep -q . ) && true
if [ -n "$(cd target && git status --porcelain)" ]; then
    fail "target worktree has uncommitted changes"
else
    pass "target worktree clean"
fi

if [ -n "$(git status --porcelain -- . ':!target' | head -n 1)" ]; then
    fail "workspace worktree has uncommitted changes"
else
    pass "workspace worktree clean"
fi

if [ "$STATUS" -eq 0 ]; then
    printf 'ALL %s: verify passed (offline)\n' "$(date -u +%FT%TZ)"
else
    printf 'ALL %s: verify FAILED\n' "$(date -u +%FT%TZ)"
fi
exit "$STATUS"
