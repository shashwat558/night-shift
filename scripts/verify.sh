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

worker_provider="opencode"
if [ -f supervisor/.env ]; then
    configured_provider="$(sed -n 's/^WORKER_PROVIDER=//p' supervisor/.env | tail -n 1 | tr '[:upper:]' '[:lower:]')"
    [ -n "$configured_provider" ] && worker_provider="$configured_provider"
fi
case "$worker_provider" in
opencode|codex|claude)
    if command -v "$worker_provider" >/dev/null 2>&1; then
        worker_version="$("$worker_provider" --version 2>/dev/null | head -n1)"
        pass "selected worker cli $worker_provider present (${worker_version:-version unknown})"
    else
        fail "selected worker cli $worker_provider absent"
    fi
    ;;
*) fail "WORKER_PROVIDER invalid ($worker_provider; expected opencode, codex, or claude)" ;;
esac

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

# phase-1 additions: the crew SOP parses with the tiny provider (no YAML lib)
if node scripts/p1-checks.mjs; then
    pass "crew template keys + schemas + crew agents registered"
else
    fail "phase-1 crew checks failed (see node scripts/p1-checks.mjs)"
fi

# phase-2 additions: parser/renderer/ws unit tests + synthetic goal/receipt checks
if node scripts/p2-checks.mjs; then
    pass "phase-2 offline checks (slips parser, receipt renderer, unit tests)"
else
    fail "phase-2 checks failed (see node scripts/p2-checks.mjs)"
fi

# phase-3 additions: gate grammar/decision table/receipt validator/budget machine offline
if node scripts/p3-checks.mjs; then
    pass "phase-3 offline checks (gate logic, needs-eyes, budget state machine)"
else
    fail "phase-3 checks failed (see node scripts/p3-checks.mjs)"
fi

# phase-4 starting checks: branch overlap and claim decision state machine
if node scripts/p4-checks.mjs; then
    pass "phase-4 collision scanner and claim orderer"
else
    fail "phase-4 checks failed (see node scripts/p4-checks.mjs)"
fi

# phase-5 additions: deterministic report replay + append-only and clock checks
if node scripts/p5-checks.mjs; then
    pass "phase-5 report replay, append-only ledger, triggers, and scratch clone"
else
    fail "phase-5 checks failed (see node scripts/p5-checks.mjs)"
fi

# phase-6 additions: judge quickstart, deterministic demo schema, submission kit
if node scripts/p6-checks.mjs; then
    pass "phase-6 README quickstart, demo schema, and submission checklist"
else
    fail "phase-6 checks failed (see node scripts/p6-checks.mjs)"
fi

# trust-control additions: repository policy, independent review, SHA-bound gate
if node scripts/p7-checks.mjs; then
    pass "trust-control policy, reviewer challenge, evidence card, and exact-SHA merge"
else
    fail "trust-control checks failed (see node scripts/p7-checks.mjs)"
fi

# multi-platform additions: secure Slack onboarding + multi-room routing
if node scripts/messaging-checks.mjs; then
    pass "Slack connector, multi-room routing, and Dockerized messaging adapters"
else
    fail "messaging integration checks failed (see node scripts/messaging-checks.mjs)"
fi

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
