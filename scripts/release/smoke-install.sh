#!/usr/bin/env bash
# scripts/release/smoke-install.sh — pre-release smoke test against the
# installed plugin shell. Exercises the actual `claude` CLI loading the
# plugin (via --plugin-dir), the slash-command surface, and the mock-driven
# review pipeline. Catches plugin-shell failures that `npm test` cannot see.
#
# This script is intentionally OUTSIDE CI:
#   - it requires a working, authenticated `claude` binary
#   - it spawns short-lived `claude` subprocesses (cost: pennies on Haiku,
#     zero if the inner reviewer hits the mock fixture)
#
# Usage:
#   scripts/release/smoke-install.sh                   # run all checks
#   scripts/release/smoke-install.sh validate          # only `claude plugin validate`
#   scripts/release/smoke-install.sh setup             # only /claude-adv:setup
#   scripts/release/smoke-install.sh review            # only mock-driven review
#
# Exit code: 0 if every check passes, non-zero if any check fails.

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MOCK="$REPO_ROOT/tests/fixtures/mock-claude.sh"
PASS=0
FAIL=0

step() {
  printf "\n\033[1;36m== %s\033[0m\n" "$1"
}
ok() {
  PASS=$((PASS + 1))
  printf "\033[1;32m  ✓ %s\033[0m\n" "$1"
}
bad() {
  FAIL=$((FAIL + 1))
  printf "\033[1;31m  ✗ %s\033[0m\n" "$1"
}

require_claude() {
  if ! command -v claude >/dev/null 2>&1; then
    bad "claude binary not on PATH — install with: npm install -g @anthropic-ai/claude-code"
    return 1
  fi
  ok "claude binary present: $(command -v claude)"
}

check_validate() {
  step "1. claude plugin validate"
  require_claude || return
  # Validate BOTH manifests explicitly. `claude plugin validate <dir>` resolves
  # the marketplace manifest when one is present, so pointing at the directory
  # would skip the plugin-shell checks (hooks/commands/agents/skills). Name each
  # manifest path so both surfaces are exercised.
  if claude plugin validate "$REPO_ROOT/.claude-plugin/plugin.json" 2>&1 |
    tee /tmp/claude-adv-smoke-validate.log; then
    ok "plugin manifest validated"
  else
    bad "plugin manifest validation failed (see /tmp/claude-adv-smoke-validate.log)"
  fi
  if claude plugin validate "$REPO_ROOT/.claude-plugin/marketplace.json" 2>&1 |
    tee -a /tmp/claude-adv-smoke-validate.log; then
    ok "marketplace manifest validated"
  else
    bad "marketplace manifest validation failed (see /tmp/claude-adv-smoke-validate.log)"
  fi
}

check_setup() {
  step "2. /claude-adv:setup --json via --plugin-dir"
  require_claude || return
  # The slash-command path through `claude -p` may not be available in all
  # versions; fall back to invoking the companion directly to confirm the
  # entry-point works under the plugin layout.
  local out
  out="$(node "$REPO_ROOT/scripts/claude-companion.mjs" setup --json 2>&1)"
  local rc=$?
  if [ $rc -ne 0 ] && [ $rc -ne 1 ]; then
    bad "setup exited $rc"
    printf "%s\n" "$out"
    return
  fi
  if printf "%s" "$out" | node -e 'JSON.parse(require("node:fs").readFileSync(0, "utf8"))' 2>/dev/null; then
    ok "setup --json parsed cleanly"
    printf "%s\n" "$out" | head -20
  else
    bad "setup --json produced non-JSON output"
    printf "%s\n" "$out"
  fi
}

check_review() {
  step "3. mock-driven /claude-adv:adversarial-review --wait"
  local tmpdir
  tmpdir="$(mktemp -d /tmp/claude-adv-smoke-XXXXXX)"
  ( cd "$tmpdir"
    git init -q
    git config user.email t@t
    git config user.name t
    printf "old\n" > f.txt
    git add . && git commit -q -m init
    printf "new\n" > f.txt
  )
  local mockdir
  mockdir="$(mktemp -d /tmp/claude-adv-smoke-bin-XXXXXX)"
  ln -sf "$MOCK" "$mockdir/claude"
  local mock_script
  mock_script="$(cat <<'JSON'
{
  "events": [
    {"type":"system","subtype":"init","session_id":"smoke"},
    {"type":"assistant","message":{"role":"assistant","content":[
      {"type":"text","text":"{\"verdict\":\"needs-attention\",\"summary\":\"smoke-test issue\",\"findings\":[{\"severity\":\"high\",\"title\":\"smoke\",\"body\":\"detail\",\"file\":\"f.txt\",\"line_start\":1,\"line_end\":1,\"confidence\":0.9,\"recommendation\":\"fix\"}],\"next_steps\":[]}"}
    ]}},
    {"type":"result","subtype":"success","total_cost_usd":0.001}
  ],
  "exitCode": 0
}
JSON
  )"
  local out
  out="$(PATH="$mockdir:$PATH" MOCK_CLAUDE_SCRIPT="$mock_script" \
    node "$REPO_ROOT/scripts/claude-companion.mjs" adversarial-review \
    --wait --json --cwd "$tmpdir" 2>&1)"
  local rc=$?
  rm -rf "$tmpdir" "$mockdir"
  if [ $rc -ne 0 ]; then
    bad "adversarial-review exited $rc"
    printf "%s\n" "$out"
    return
  fi
  if printf "%s" "$out" | node -e '
    const r = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    if (r.review_output?.verdict !== "needs-attention") {
      console.error("unexpected verdict:", r.review_output?.verdict);
      process.exit(1);
    }
    if (!Array.isArray(r.review_output?.findings) || r.review_output.findings.length !== 1) {
      console.error("expected exactly one finding");
      process.exit(1);
    }
  ' 2>&1; then
    ok "mock-driven review produced needs-attention verdict with 1 finding"
  else
    bad "mock-driven review payload did not match expectations"
    printf "%s\n" "$out"
  fi
}

main() {
  local target="${1:-all}"
  case "$target" in
    validate) check_validate ;;
    setup)    check_setup ;;
    review)   check_review ;;
    all)
      check_validate
      check_setup
      check_review
      ;;
    *)
      printf "Unknown target: %s\n" "$target" >&2
      printf "Usage: %s [validate|setup|review|all]\n" "$0" >&2
      exit 2
      ;;
  esac
  printf "\n"
  printf "Summary: %d passed, %d failed\n" "$PASS" "$FAIL"
  [ "$FAIL" -eq 0 ]
}

main "$@"
