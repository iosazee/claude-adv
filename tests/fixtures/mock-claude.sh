#!/bin/sh
# Simulate `claude` for unit tests. Reads scripted behavior from
# MOCK_CLAUDE_SCRIPT (single) or MOCK_CLAUDE_SCRIPTS (sequence), emits
# events line-by-line.
#
# Single-script mode: set MOCK_CLAUDE_SCRIPT. Every invocation replays it.
# Sequence mode: set MOCK_CLAUDE_SCRIPTS (JSON array of scripts) +
#                MOCK_CLAUDE_COUNTER_FILE (writable path). Invocation N
#                consumes scripts[N]; once exhausted, the last script
#                repeats. Used by tests that exercise retry paths.
#
# This script intentionally ignores its CLI arguments (the spawn layer
# is responsible for argv correctness; that's covered by builder tests).
# It also drains stdin so the parent can write a prompt without blocking.

if [ -n "$MOCK_CLAUDE_PID_FILE" ]; then
  printf '%s\n' "$$" > "$MOCK_CLAUDE_PID_FILE"
fi

if [ "$MOCK_CLAUDE_IGNORE_SIGTERM" = "1" ]; then
  trap '' TERM
fi

if [ -n "$MOCK_CLAUDE_ARGV_CAPTURE" ]; then
  node -e 'const fs = require("node:fs"); fs.appendFileSync(process.env.MOCK_CLAUDE_ARGV_CAPTURE, JSON.stringify(process.argv.slice(1)) + "\n");' -- "$@"
fi

if [ -n "$MOCK_CLAUDE_CWD_CAPTURE" ]; then
  node -e 'require("node:fs").writeFileSync(process.env.MOCK_CLAUDE_CWD_CAPTURE, process.cwd());'
fi

# Drain stdin in background.
cat > /dev/null &
DRAIN_PID=$!

if [ -z "$MOCK_CLAUDE_SCRIPT" ] && [ -z "$MOCK_CLAUDE_SCRIPTS" ]; then
  echo "mock-claude.sh: MOCK_CLAUDE_SCRIPT or MOCK_CLAUDE_SCRIPTS env var must be set" >&2
  exit 99
fi

if [ -n "$MOCK_CLAUDE_SLEEP_SECONDS" ]; then
  sleep "$MOCK_CLAUDE_SLEEP_SECONDS"
fi

# Emit each event as a separate line. We use node for JSON parsing
# because /bin/sh has no built-in.
node -e '
  const fs = require("node:fs");
  let script;
  if (process.env.MOCK_CLAUDE_SCRIPTS) {
    const scripts = JSON.parse(process.env.MOCK_CLAUDE_SCRIPTS);
    const counterFile = process.env.MOCK_CLAUDE_COUNTER_FILE;
    if (!counterFile) {
      process.stderr.write("mock-claude.sh: MOCK_CLAUDE_SCRIPTS requires MOCK_CLAUDE_COUNTER_FILE\n");
      process.exit(98);
    }
    let n = 0;
    try { n = parseInt(fs.readFileSync(counterFile, "utf8"), 10) || 0; } catch { /* first call */ }
    const idx = Math.min(n, scripts.length - 1);
    script = typeof scripts[idx] === "string" ? JSON.parse(scripts[idx]) : scripts[idx];
    fs.writeFileSync(counterFile, String(n + 1));
  } else {
    script = JSON.parse(process.env.MOCK_CLAUDE_SCRIPT);
  }
  for (const ev of script.events ?? []) {
    process.stdout.write(JSON.stringify(ev) + "\n");
  }
  if (script.stderr) process.stderr.write(script.stderr);
  process.exit(script.exitCode ?? 0);
'
EXIT=$?

# Wait for stdin drain so we don't leave a zombie.
wait $DRAIN_PID 2>/dev/null
exit $EXIT
