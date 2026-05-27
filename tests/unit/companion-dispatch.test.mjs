import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, spawnSync, execSync } from "node:child_process";
import {
  writeFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  listJobs,
  readJobFile,
  resolveJobFile,
  upsertJob,
  writeJobFile,
} from "../../scripts/lib/state.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const COMPANION = path.join(ROOT, "scripts/claude-companion.mjs");

function run(args) {
  return spawnSync(process.execPath, [COMPANION, ...args], { encoding: "utf8" });
}

function makeSetupPathFixture(claudeScript = null) {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-adv-setup-path-"));
  symlinkSync(process.execPath, path.join(dir, "node"));
  if (claudeScript) {
    writeFileSync(path.join(dir, "claude"), claudeScript, { mode: 0o755 });
  }
  return dir;
}

function runSetupJsonWithPath(pathDir) {
  const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-setup-json-"));
  const env = {
    ...process.env,
    PATH: pathDir,
    CLAUDE_PLUGIN_DATA: mkdtempSync(path.join(tmpdir(), "claude-adv-setup-state-")),
  };
  return spawnSync(process.execPath, [COMPANION, "setup", "--json", "--cwd", repo], {
    encoding: "utf8",
    env,
  });
}

function withPluginData(pluginData, fn) {
  const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    return fn();
  } finally {
    if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  }
}

function readStoredJob(repo, pluginData, jobId) {
  return withPluginData(pluginData, () => readJobFile(resolveJobFile(repo, jobId)));
}

function readIndexedJob(repo, pluginData, jobId) {
  return withPluginData(pluginData, () => listJobs(repo).find((job) => job.id === jobId));
}

function writeSlowEmptyPsShim(binDir) {
  writeFileSync(
    path.join(binDir, "ps"),
    `#!/bin/sh
sleep 0.2
exit 0
`,
    { mode: 0o755 }
  );
}

function cleanupBackgroundJob(job) {
  if (job?.status !== "running" || !Number.isFinite(job.pid)) {
    return;
  }
  try {
    process.kill(-job.pid, "SIGTERM");
  } catch {
    // The worker may have already exited; cleanup is best-effort.
  }
}

function claudeFixture(authBody) {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' "fake claude 1.0"
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ] && [ "$3" = "--json" ]; then
${authBody}
fi
printf '%s\\n' "unexpected args: $*" >&2
exit 2
`;
}

test("companion: normalizes a single packed $ARGUMENTS string into argv", async () => {
  // Slash-command files pass `"$ARGUMENTS"` quoted, so multi-flag input
  // arrives as one argv element. The dispatcher must split it back.
  const { normalizeArgv } = await import("../../scripts/claude-companion.mjs");
  assert.deepEqual(normalizeArgv(["--base main --wait"]), ["--base", "main", "--wait"]);
  // Preserves shell-quoted focus segments.
  assert.deepEqual(normalizeArgv([`--scope working-tree "focus with spaces"`]), [
    "--scope",
    "working-tree",
    "focus with spaces",
  ]);
  // Multi-arg invocations (tests, direct CLI) pass through unchanged.
  assert.deepEqual(normalizeArgv(["--wait", "--base", "main"]), ["--wait", "--base", "main"]);
  // Single token without whitespace passes through unchanged.
  assert.deepEqual(normalizeArgv(["job-abc123"]), ["job-abc123"]);
  // setup.md sends `--json "$ARGUMENTS"`, so the packed token is the 2nd
  // element. Split it in place and flatten.
  assert.deepEqual(normalizeArgv(["--json", "--enable-review-gate"]), [
    "--json",
    "--enable-review-gate",
  ]);
  assert.deepEqual(normalizeArgv(["--json", "--set-budget-usd 3"]), [
    "--json",
    "--set-budget-usd",
    "3",
  ]);
  // Empty `$ARGUMENTS` substitution arrives as an empty token (preserved) or
  // a whitespace-only token (dropped) depending on the slash command's spacing.
  assert.deepEqual(normalizeArgv(["--json", ""]), ["--json", ""]);
  assert.deepEqual(normalizeArgv(["--json", "   "]), ["--json"]);
});

test("companion: result accepts packed-$ARGUMENTS single token", () => {
  // Regression: if the slash-command result.md ever passes a job id wrapped
  // with extra whitespace ("job-abc --json"), the dispatcher must split it
  // so result.mjs sees positionals=["job-abc"] options={json:true}.
  const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-norm-"));
  execSync("git init -q", { cwd: repo });
  // Invoke with a single packed string that includes a flag + bogus id.
  const r = spawnSync(
    process.execPath,
    [COMPANION, "result", "no-such-job --json", "--cwd", repo],
    { encoding: "utf8" }
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No finished job|No job found/);
});

test("companion: cancel does not signal a PID whose start-time mismatches the job record", async (t) => {
  const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-cancel-guard-"));
  const pluginData = mkdtempSync(path.join(tmpdir(), "claude-adv-cancel-guard-state-"));
  execSync("git init -q", { cwd: repo });

  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  t.after(() => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    rmSync(repo, { recursive: true, force: true });
    rmSync(pluginData, { recursive: true, force: true });
  });

  const timestamp = new Date().toISOString();
  const job = {
    id: "task-cancel-guard",
    kind: "task",
    kindLabel: "rescue",
    jobClass: "task",
    title: "Claude Task",
    status: "running",
    phase: "running",
    pid: child.pid,
    pgid: child.pid,
    startTime: "Mon Jan  1 00:00:00 1970",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  withPluginData(pluginData, () => {
    writeJobFile(repo, job.id, job);
    upsertJob(repo, job);
  });

  const r = spawnSync(process.execPath, [COMPANION, "cancel", "--json", "--cwd", repo, job.id], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData },
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.doesNotThrow(() => process.kill(child.pid, 0));
});

test("companion: --help prints usage", () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
  assert.match(r.stdout, /setup/);
});

test("companion: unknown subcommand fails with helpful error", () => {
  const r = run(["nonsense"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown subcommand/);
});

test("companion: setup --json returns a structured report", () => {
  const r = run(["setup", "--json"]);
  // Exit code may be 0 or 1 depending on auth status; either way the JSON
  // must be on stdout and parsable.
  const parsed = JSON.parse(r.stdout);
  assert.ok("ready" in parsed);
  assert.ok("node" in parsed);
  assert.ok("claude" in parsed);
});

test("companion: setup readinessReason is null when claude is authenticated", () => {
  const pathDir = makeSetupPathFixture(
    claudeFixture(`  printf '%s\\n' '{"logged_in":true,"auth_method":"test"}'
  exit 0`)
  );

  const r = runSetupJsonWithPath(pathDir);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ready, true);
  assert.equal(parsed.readinessReason, null);
});

test("companion: setup readinessReason is claude-missing when claude is absent", () => {
  const pathDir = makeSetupPathFixture();

  const r = runSetupJsonWithPath(pathDir);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ready, false);
  assert.equal(parsed.readinessReason, "claude-missing");
});

// As of 2026-05-16 subscription auth is a first-class supported path. The
// previous setup output had a warning for "subscription user without
// ANTHROPIC_API_KEY"; that warning is gone because the reviewer now drops
// --bare automatically for subscription users (and the CLI reads its own
// OAuth/keychain natively). Tests assert the warning is NOT emitted in
// either auth-class condition — both just work.
test("companion: setup does NOT warn about subscription auth (auto-handled by useBare detection)", () => {
  const pathDir = makeSetupPathFixture(
    claudeFixture(`  printf '%s\\n' '{"logged_in":true,"auth_method":"claude.ai"}'
  exit 0`)
  );
  const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-setup-claudeai-"));
  const env = {
    ...process.env,
    PATH: pathDir,
    CLAUDE_PLUGIN_DATA: mkdtempSync(path.join(tmpdir(), "claude-adv-setup-claudeai-state-")),
  };
  delete env.ANTHROPIC_API_KEY;
  const r = spawnSync(process.execPath, [COMPANION, "setup", "--json", "--cwd", repo], {
    encoding: "utf8",
    env,
  });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ready, true);
  assert.equal(parsed.auth.authMethod, "claude.ai");
  assert.ok(
    !parsed.nextSteps.some((s) => /subscription|claude\.ai|--bare|ANTHROPIC_API_KEY/i.test(s)),
    `subscription auth must NOT trigger a warning now; got: ${JSON.stringify(parsed.nextSteps)}`
  );
});

test("companion: setup does NOT warn when ANTHROPIC_API_KEY is externally set either", () => {
  const pathDir = makeSetupPathFixture(
    claudeFixture(`  printf '%s\\n' '{"logged_in":true,"auth_method":"claude.ai"}'
  exit 0`)
  );
  const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-setup-claudeai-ok-"));
  const env = {
    ...process.env,
    PATH: pathDir,
    CLAUDE_PLUGIN_DATA: mkdtempSync(path.join(tmpdir(), "claude-adv-setup-claudeai-ok-state-")),
    ANTHROPIC_API_KEY: "sk-ant-test-fake-key-only-for-presence-check",
  };
  const r = spawnSync(process.execPath, [COMPANION, "setup", "--json", "--cwd", repo], {
    encoding: "utf8",
    env,
  });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.ok(
    !parsed.nextSteps.some((s) => /subscription|claude\.ai|--bare/i.test(s)),
    `no subscription warning in either path, got: ${JSON.stringify(parsed.nextSteps)}`
  );
});

test("companion: setup readinessReason classifies auth probe outcomes", () => {
  const cases = [
    {
      name: "auth-missing",
      authBody: `  printf '%s\\n' 'not logged in' >&2
  exit 1`,
      readinessReason: "auth-missing",
      failureKind: "missing",
    },
    {
      name: "auth-invalid",
      authBody: `  printf '%s\\n' '401 unauthorized' >&2
  exit 1`,
      readinessReason: "auth-invalid",
      failureKind: "invalid",
    },
    {
      name: "auth-malformed",
      authBody: `  printf '%s\\n' 'not json'
  exit 0`,
      readinessReason: "auth-unknown",
      failureKind: "parse-error",
    },
    {
      name: "auth-unknown",
      authBody: `  printf '%s\\n' 'unexpected provider failure' >&2
  exit 1`,
      readinessReason: "auth-unknown",
      failureKind: "unknown",
    },
  ];

  for (const { name, authBody, readinessReason, failureKind } of cases) {
    const pathDir = makeSetupPathFixture(claudeFixture(authBody));
    const r = runSetupJsonWithPath(pathDir);
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ready, false, name);
    assert.equal(parsed.readinessReason, readinessReason, name);
    assert.equal(parsed.auth.failureKind, failureKind, name);
  }
});

test("companion: setup readinessReason treats auth probe spawn errors as auth-unknown", () => {
  const pathDir = makeSetupPathFixture(`#!/bin/sh
if [ "$1" = "--version" ]; then
  /bin/rm "$0"
  printf '%s\\n' "fake claude 1.0"
  exit 0
fi
printf '%s\\n' "unexpected args: $*" >&2
exit 2
`);

  const r = runSetupJsonWithPath(pathDir);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ready, false);
  assert.equal(parsed.readinessReason, "auth-unknown");
  assert.equal(parsed.auth.failureKind, "probe-error");
});

test("companion: adversarial-review runs against mock-claude and emits JSON", () => {
  // Create a tiny git repo with a tracked file modified in the working tree.
  const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-cmd-test-"));
  execSync("git init -q", { cwd: repo });
  execSync('git config user.email "t@t" && git config user.name t', {
    cwd: repo,
    shell: "/bin/bash",
  });
  writeFileSync(path.join(repo, "f.txt"), "old\n");
  execSync("git add . && git commit -q -m init", { cwd: repo, shell: "/bin/bash" });
  writeFileSync(path.join(repo, "f.txt"), "new\n");

  // Set MOCK_CLAUDE_SCRIPT and override PATH so the spawned `claude` is our mock.
  const mockBin = path.join(ROOT, "tests/fixtures/mock-claude.sh");
  const mockDir = mkdtempSync(path.join(tmpdir(), "claude-adv-bin-"));
  execSync(`ln -sf '${mockBin}' '${mockDir}/claude'`);

  const env = {
    ...process.env,
    PATH: `${mockDir}:${process.env.PATH}`,
    MOCK_CLAUDE_SCRIPT: JSON.stringify({
      events: [
        { type: "system", subtype: "init", session_id: "mock-sid" },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  verdict: "approve",
                  summary: "looks fine",
                  findings: [],
                  next_steps: [],
                }),
              },
            ],
          },
        },
        { type: "result", subtype: "success", total_cost_usd: 0.001 },
      ],
      exitCode: 0,
    }),
  };

  const r = spawnSync(
    process.execPath,
    [COMPANION, "adversarial-review", "--wait", "--json", "--cwd", repo],
    { encoding: "utf8", env }
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.review_output.verdict, "approve");
});

// Helper: build a stream-json events array that emits one review payload.
function reviewEvents(reviewPayload) {
  return [
    { type: "system", subtype: "init", session_id: "mock" },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: JSON.stringify(reviewPayload) }],
      },
    },
    { type: "result", subtype: "success", total_cost_usd: 0.001 },
  ];
}

function reviewScript(payload) {
  return JSON.stringify({ events: reviewEvents(payload), exitCode: 0 });
}

function makeRepoWithDirty() {
  const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-verify-"));
  execSync("git init -q", { cwd: repo });
  execSync('git config user.email "t@t" && git config user.name t', {
    cwd: repo,
    shell: "/bin/bash",
  });
  writeFileSync(path.join(repo, "f.txt"), "old\n");
  execSync("git add . && git commit -q -m init", { cwd: repo, shell: "/bin/bash" });
  writeFileSync(path.join(repo, "f.txt"), "new\n");
  return repo;
}

function mockBinDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-adv-bin-verify-"));
  execSync(`ln -sf '${path.join(ROOT, "tests/fixtures/mock-claude.sh")}' '${dir}/claude'`);
  return dir;
}

test("companion: --continue + approve triggers fresh verification (and the verification's verdict wins)", () => {
  // Primary (with --continue): says approve-with-notes (model softened a real
  // concern because it trusted the prior list to be addressed).
  // Verification (without --continue): finds a high-severity issue the
  // primary suppressed → needs-attention.
  // The final payload must surface the verification verdict + findings.
  const repo = makeRepoWithDirty();
  const mockDir = mockBinDir();
  const counterFile = path.join(mockDir, "counter");

  // Write a prior-report file the --continue arg can point at.
  const priorReport = path.join(mockDir, "prior.json");
  writeFileSync(
    priorReport,
    JSON.stringify({
      review_output: {
        verdict: "needs-attention",
        findings: [
          {
            severity: "high",
            title: "off-by-one in retry counter",
            body: "boundary check fires one past the intended limit",
            file: "f.txt",
            line_start: 1,
            line_end: 1,
            confidence: 0.85,
            recommendation: "use < not <=",
            fingerprint: "aaaaaaaaaaaaaaaa",
          },
        ],
      },
    })
  );

  const env = {
    ...process.env,
    PATH: `${mockDir}:${process.env.PATH}`,
    MOCK_CLAUDE_COUNTER_FILE: counterFile,
    MOCK_CLAUDE_SCRIPTS: JSON.stringify([
      // Primary (the --continue review) — model says approve-with-notes.
      reviewScript({
        verdict: "approve-with-notes",
        summary: "looks ok now",
        findings: [
          {
            severity: "medium",
            title: "minor naming nit",
            body: "the variable could be clearer",
            file: "f.txt",
            line_start: 1,
            line_end: 1,
            confidence: 0.5,
            recommendation: "rename",
          },
        ],
        next_steps: [],
      }),
      // Verification (fresh, no --continue context) — finds a real high.
      reviewScript({
        verdict: "needs-attention",
        summary: "real issue surfaced under independent review",
        findings: [
          {
            severity: "high",
            title: "unchecked null deref under empty input",
            body: "the function dereferences arr[0] without checking length",
            file: "f.txt",
            line_start: 1,
            line_end: 1,
            confidence: 0.9,
            recommendation: "guard with length check",
          },
        ],
        next_steps: [],
      }),
    ]),
  };

  const r = spawnSync(
    process.execPath,
    [COMPANION, "adversarial-review", "--wait", "--json", "--cwd", repo, "--continue", priorReport],
    { encoding: "utf8", env }
  );
  // Exit code for valid-schema reviews is 0 regardless of verdict (the existing
  // contract; CI consumers parse the JSON to decide blocking). What we assert
  // here is that the verification's verdict overrides the continue's.
  assert.equal(r.status, 0, `unexpected exit ${r.status}; stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  // Authoritative verdict is the verification's, not the --continue review's.
  assert.equal(parsed.review_output.verdict, "needs-attention");
  assert.equal(parsed.review_output.findings.length, 1);
  assert.equal(parsed.review_output.findings[0].severity, "high");
  // Trace fields surface both attempts.
  assert.equal(parsed.finalVerification.triggered, true);
  assert.equal(parsed.continueAttempt.verdict, "approve-with-notes");
  assert.equal(parsed.continueAttempt.n_findings, 1);
});

test("companion: --continue + needs-attention does NOT trigger verification (already blocking)", () => {
  // No point spending a second model call when the primary already blocks.
  const repo = makeRepoWithDirty();
  const mockDir = mockBinDir();
  const counterFile = path.join(mockDir, "counter");
  const priorReport = path.join(mockDir, "prior.json");
  writeFileSync(priorReport, JSON.stringify({ review_output: { findings: [] } }));

  const env = {
    ...process.env,
    PATH: `${mockDir}:${process.env.PATH}`,
    MOCK_CLAUDE_COUNTER_FILE: counterFile,
    MOCK_CLAUDE_SCRIPTS: JSON.stringify([
      reviewScript({
        verdict: "needs-attention",
        summary: "blocker",
        findings: [
          {
            severity: "critical",
            title: "real critical",
            body: "x",
            file: "f.txt",
            line_start: 1,
            line_end: 1,
            confidence: 0.95,
            recommendation: "fix",
          },
        ],
        next_steps: [],
      }),
      // Second script SHOULD NOT BE CONSUMED. If it is, the test catches it
      // because the counter advances and the assertion below fails.
      reviewScript({
        verdict: "approve",
        summary: "should never run",
        findings: [],
        next_steps: [],
      }),
    ]),
  };

  const r = spawnSync(
    process.execPath,
    [COMPANION, "adversarial-review", "--wait", "--json", "--cwd", repo, "--continue", priorReport],
    { encoding: "utf8", env }
  );
  assert.equal(r.status, 0, `unexpected exit ${r.status}; stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.review_output.verdict, "needs-attention");
  assert.equal(parsed.finalVerification.triggered, false);
  assert.equal(parsed.continueAttempt, null);
  // Verify the second script was NOT consumed (counter at exactly 1).
  const counter = parseInt(readFileSync(counterFile, "utf8"), 10);
  assert.equal(counter, 1, "verification should not have run; primary was needs-attention");
});

test("companion: --continue + approve-with-notes + verification ALSO approve-with-notes returns approve-with-notes", () => {
  // Happy convergence case: both passes agree, the loop terminates honestly.
  const repo = makeRepoWithDirty();
  const mockDir = mockBinDir();
  const counterFile = path.join(mockDir, "counter");
  const priorReport = path.join(mockDir, "prior.json");
  writeFileSync(priorReport, JSON.stringify({ review_output: { findings: [] } }));

  const minor = {
    severity: "low",
    title: "style nit",
    body: "x",
    file: "f.txt",
    line_start: 1,
    line_end: 1,
    confidence: 0.4,
    recommendation: "y",
  };

  const env = {
    ...process.env,
    PATH: `${mockDir}:${process.env.PATH}`,
    MOCK_CLAUDE_COUNTER_FILE: counterFile,
    MOCK_CLAUDE_SCRIPTS: JSON.stringify([
      reviewScript({
        verdict: "approve-with-notes",
        summary: "minor only",
        findings: [minor],
        next_steps: [],
      }),
      reviewScript({
        verdict: "approve-with-notes",
        summary: "verified independently",
        findings: [minor],
        next_steps: [],
      }),
    ]),
  };

  const r = spawnSync(
    process.execPath,
    [COMPANION, "adversarial-review", "--wait", "--json", "--cwd", repo, "--continue", priorReport],
    { encoding: "utf8", env }
  );
  assert.equal(r.status, 0, `should exit 0 on approve-with-notes; stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.review_output.verdict, "approve-with-notes");
  assert.equal(parsed.finalVerification.triggered, true);
  assert.equal(parsed.continueAttempt.verdict, "approve-with-notes");
});

test("companion: without --continue, no verification runs even for approve verdict", () => {
  // Single-shot mode is unchanged: no --continue means no verification.
  const repo = makeRepoWithDirty();
  const mockDir = mockBinDir();
  const counterFile = path.join(mockDir, "counter");

  const env = {
    ...process.env,
    PATH: `${mockDir}:${process.env.PATH}`,
    MOCK_CLAUDE_COUNTER_FILE: counterFile,
    MOCK_CLAUDE_SCRIPTS: JSON.stringify([
      reviewScript({
        verdict: "approve",
        summary: "clean",
        findings: [],
        next_steps: [],
      }),
      reviewScript({
        verdict: "needs-attention",
        summary: "should never run",
        findings: [],
        next_steps: [],
      }),
    ]),
  };

  const r = spawnSync(
    process.execPath,
    [COMPANION, "adversarial-review", "--wait", "--json", "--cwd", repo],
    { encoding: "utf8", env }
  );
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.review_output.verdict, "approve");
  assert.equal(parsed.finalVerification.triggered, false);
  const counter = parseInt(readFileSync(counterFile, "utf8"), 10);
  assert.equal(counter, 1, "single-shot must consume exactly one script");
});

test("companion: adversarial-review schema-repair retry recovers a valid review", () => {
  // First inner-claude call returns a finding missing `severity` — that gets
  // rejected by validateAndNormalizeReview. Second call (driven by the
  // repair prompt) returns a valid review. The handler should surface the
  // recovered review with retryAttempted=true in the payload.
  const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-retry-"));
  execSync("git init -q", { cwd: repo });
  execSync('git config user.email "t@t" && git config user.name t', {
    cwd: repo,
    shell: "/bin/bash",
  });
  writeFileSync(path.join(repo, "f.txt"), "old\n");
  execSync("git add . && git commit -q -m init", { cwd: repo, shell: "/bin/bash" });
  writeFileSync(path.join(repo, "f.txt"), "new\n");

  const mockBin = path.join(ROOT, "tests/fixtures/mock-claude.sh");
  const mockDir = mkdtempSync(path.join(tmpdir(), "claude-adv-bin-retry-"));
  execSync(`ln -sf '${mockBin}' '${mockDir}/claude'`);
  const counterFile = path.join(mockDir, "counter");

  const badFinding = {
    // missing severity — exactly the live-test failure mode
    title: "off-by-one",
    body: "loop boundary is wrong",
    file: "f.txt",
    line_start: 1,
    line_end: 1,
    confidence: 0.9,
    recommendation: "use < instead of <=",
  };
  const goodFinding = { ...badFinding, severity: "high" };

  const env = {
    ...process.env,
    PATH: `${mockDir}:${process.env.PATH}`,
    MOCK_CLAUDE_COUNTER_FILE: counterFile,
    MOCK_CLAUDE_SCRIPTS: JSON.stringify([
      JSON.stringify({
        events: [
          { type: "system", subtype: "init", session_id: "first" },
          {
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    verdict: "needs-attention",
                    summary: "issue found",
                    findings: [badFinding],
                    next_steps: [],
                  }),
                },
              ],
            },
          },
          { type: "result", subtype: "success", total_cost_usd: 0.002 },
        ],
        exitCode: 0,
      }),
      JSON.stringify({
        events: [
          { type: "system", subtype: "init", session_id: "second" },
          {
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    verdict: "needs-attention",
                    summary: "issue found",
                    findings: [goodFinding],
                    next_steps: [],
                  }),
                },
              ],
            },
          },
          { type: "result", subtype: "success", total_cost_usd: 0.003 },
        ],
        exitCode: 0,
      }),
    ]),
  };

  const r = spawnSync(
    process.execPath,
    [COMPANION, "adversarial-review", "--wait", "--json", "--cwd", repo],
    { encoding: "utf8", env }
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.review_output.verdict, "needs-attention");
  assert.equal(parsed.review_output.findings.length, 1);
  assert.equal(parsed.review_output.findings[0].severity, "high");
  assert.equal(parsed.claude.retryAttempted, true);
  // The first attempt's raw output is preserved as a diagnostic breadcrumb.
  assert.ok(
    typeof parsed.claude.firstAttemptRawOutput === "string" &&
      parsed.claude.firstAttemptRawOutput.includes("off-by-one")
  );
});

test("companion: adversarial-review schema-violation after retry surfaces raw output", () => {
  // Both inner-claude attempts emit a malformed review. The handler should
  // exit non-zero AND include the model's raw final text in the payload so
  // the user can recover the content manually.
  const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-noretry-"));
  execSync("git init -q", { cwd: repo });
  execSync('git config user.email "t@t" && git config user.name t', {
    cwd: repo,
    shell: "/bin/bash",
  });
  writeFileSync(path.join(repo, "f.txt"), "old\n");
  execSync("git add . && git commit -q -m init", { cwd: repo, shell: "/bin/bash" });
  writeFileSync(path.join(repo, "f.txt"), "new\n");

  const mockBin = path.join(ROOT, "tests/fixtures/mock-claude.sh");
  const mockDir = mkdtempSync(path.join(tmpdir(), "claude-adv-bin-noretry-"));
  execSync(`ln -sf '${mockBin}' '${mockDir}/claude'`);
  const counterFile = path.join(mockDir, "counter");

  // Same malformed payload twice — model keeps returning the same shape.
  const badText = JSON.stringify({
    verdict: "needs-attention",
    summary: "broken",
    findings: [{ title: "x", body: "y", file: "f", line_start: 1, line_end: 1 }],
    next_steps: [],
  });
  const oneScript = JSON.stringify({
    events: [
      { type: "system", subtype: "init", session_id: "x" },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: badText }] },
      },
      { type: "result", subtype: "success", total_cost_usd: 0.001 },
    ],
    exitCode: 0,
  });

  const env = {
    ...process.env,
    PATH: `${mockDir}:${process.env.PATH}`,
    MOCK_CLAUDE_COUNTER_FILE: counterFile,
    MOCK_CLAUDE_SCRIPTS: JSON.stringify([oneScript, oneScript]),
  };

  const r = spawnSync(
    process.execPath,
    [COMPANION, "adversarial-review", "--wait", "--json", "--cwd", repo],
    { encoding: "utf8", env }
  );
  assert.equal(r.status, 1);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.review_output, null);
  assert.match(parsed.claude.error, /schema-violation/);
  assert.equal(parsed.claude.retryAttempted, true);
  assert.ok(typeof parsed.claude.rawOutput === "string" && parsed.claude.rawOutput.length > 0);
  assert.ok(parsed.claude.rawOutput.includes('"title":"x"'));
});

// Live failure mode 2026-05-14: grounded reviews where the model is asked to
// inspect files tend to emit a short conversational preamble ("I'll inspect
// these files...") instead of structured output. Strict JSON.parse rejected
// this entirely, and the retry trigger was gated only on "schema-violation:"
// errors — so parse failures bypassed retry AND raw-output preservation. The
// runtime now treats parse-failure as a recoverable schema-repair case.
test("companion: adversarial-review retries on parse-failure (model emits prose, not JSON)", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-parse-retry-"));
  execSync("git init -q", { cwd: repo });
  execSync('git config user.email "t@t" && git config user.name t', {
    cwd: repo,
    shell: "/bin/bash",
  });
  writeFileSync(path.join(repo, "f.txt"), "old\n");
  execSync("git add . && git commit -q -m init", { cwd: repo, shell: "/bin/bash" });
  writeFileSync(path.join(repo, "f.txt"), "new\n");

  const mockBin = path.join(ROOT, "tests/fixtures/mock-claude.sh");
  const mockDir = mkdtempSync(path.join(tmpdir(), "claude-adv-bin-parse-retry-"));
  execSync(`ln -sf '${mockBin}' '${mockDir}/claude'`);
  const counterFile = path.join(mockDir, "counter");

  const proseScript = JSON.stringify({
    events: [
      { type: "system", subtype: "init", session_id: "first" },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I'll inspect these files and analyze the diff first..." },
          ],
        },
      },
      { type: "result", subtype: "success", total_cost_usd: 0.002 },
    ],
    exitCode: 0,
  });
  const goodScript = JSON.stringify({
    events: [
      { type: "system", subtype: "init", session_id: "second" },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                verdict: "approve",
                summary: "looks clean on the retry pass",
                findings: [],
                next_steps: [],
              }),
            },
          ],
        },
      },
      { type: "result", subtype: "success", total_cost_usd: 0.003 },
    ],
    exitCode: 0,
  });

  const env = {
    ...process.env,
    PATH: `${mockDir}:${process.env.PATH}`,
    MOCK_CLAUDE_COUNTER_FILE: counterFile,
    MOCK_CLAUDE_SCRIPTS: JSON.stringify([proseScript, goodScript]),
  };

  const r = spawnSync(
    process.execPath,
    [COMPANION, "adversarial-review", "--wait", "--json", "--cwd", repo],
    { encoding: "utf8", env }
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.review_output.verdict, "approve");
  assert.equal(parsed.claude.retryAttempted, true);
  assert.ok(
    typeof parsed.claude.firstAttemptRawOutput === "string" &&
      parsed.claude.firstAttemptRawOutput.includes("inspect these files"),
    "first attempt's conversational text should be preserved as a diagnostic"
  );
});

test("companion: adversarial-review parse-failure after retry surfaces raw output", () => {
  // Both attempts emit purely conversational text. The handler should exit
  // non-zero AND include the model's raw final text so /result can show the
  // user what actually came back (not the bare parse-failure message).
  const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-parse-noretry-"));
  execSync("git init -q", { cwd: repo });
  execSync('git config user.email "t@t" && git config user.name t', {
    cwd: repo,
    shell: "/bin/bash",
  });
  writeFileSync(path.join(repo, "f.txt"), "old\n");
  execSync("git add . && git commit -q -m init", { cwd: repo, shell: "/bin/bash" });
  writeFileSync(path.join(repo, "f.txt"), "new\n");

  const mockBin = path.join(ROOT, "tests/fixtures/mock-claude.sh");
  const mockDir = mkdtempSync(path.join(tmpdir(), "claude-adv-bin-parse-noretry-"));
  execSync(`ln -sf '${mockBin}' '${mockDir}/claude'`);
  const counterFile = path.join(mockDir, "counter");

  const proseText = "I'll inspect these files and analyze the diff carefully before responding.";
  const proseScript = JSON.stringify({
    events: [
      { type: "system", subtype: "init", session_id: "x" },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: proseText }] },
      },
      { type: "result", subtype: "success", total_cost_usd: 0.001 },
    ],
    exitCode: 0,
  });

  const env = {
    ...process.env,
    PATH: `${mockDir}:${process.env.PATH}`,
    MOCK_CLAUDE_COUNTER_FILE: counterFile,
    MOCK_CLAUDE_SCRIPTS: JSON.stringify([proseScript, proseScript]),
  };

  const r = spawnSync(
    process.execPath,
    [COMPANION, "adversarial-review", "--wait", "--json", "--cwd", repo],
    { encoding: "utf8", env }
  );
  assert.equal(r.status, 1);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.review_output, null);
  assert.match(parsed.claude.error, /failed to parse/);
  assert.equal(parsed.claude.retryAttempted, true);
  assert.ok(
    typeof parsed.claude.rawOutput === "string" && parsed.claude.rawOutput.length > 0,
    "raw output must be preserved on parse failure for user diagnostics"
  );
  assert.ok(parsed.claude.rawOutput.includes("inspect these files"));
});

// When the diff exceeds the inline byte caps, the reviewer is given file-
// list/stats only. The reviewer cannot self-collect (locked --tools "") so
// any verdict it produces is a paper review. The runtime detects
// inputMode=self-collect AND a non-blocking verdict, and force-promotes to
// needs-attention with a synthetic finding. This test exercises that
// safeguard end-to-end by creating a diff larger than the 256KB total cap.
test("companion: paper-approve safeguard fires when self-collect verdict is approve", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-paper-approve-"));
  execSync("git init -q", { cwd: repo });
  execSync('git config user.email "t@t" && git config user.name t', {
    cwd: repo,
    shell: "/bin/bash",
  });
  // Create a 300KB file (over the 256KB total inline-diff byte cap).
  const bigContent = "old line\n".repeat(40000); // ~320KB
  writeFileSync(path.join(repo, "big.txt"), bigContent);
  execSync("git add . && git commit -q -m init", { cwd: repo, shell: "/bin/bash" });
  // Change every line so the diff is roughly the same size.
  writeFileSync(path.join(repo, "big.txt"), bigContent.replace(/old/g, "new"));

  const mockBin = path.join(ROOT, "tests/fixtures/mock-claude.sh");
  const mockDir = mkdtempSync(path.join(tmpdir(), "claude-adv-paper-bin-"));
  execSync(`ln -sf '${mockBin}' '${mockDir}/claude'`);

  // Model produces a paper approve (no findings) — simulating it ignoring
  // the new prompt instruction to refuse.
  const paperScript = JSON.stringify({
    events: [
      { type: "system", subtype: "init", session_id: "paper" },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                verdict: "approve",
                summary: "Looks fine based on file list",
                findings: [],
                next_steps: [],
              }),
            },
          ],
        },
      },
      { type: "result", subtype: "success", total_cost_usd: 0.001 },
    ],
    exitCode: 0,
  });

  const env = {
    ...process.env,
    PATH: `${mockDir}:${process.env.PATH}`,
    MOCK_CLAUDE_SCRIPT: paperScript,
  };

  const r = spawnSync(
    process.execPath,
    [COMPANION, "adversarial-review", "--wait", "--json", "--cwd", repo],
    { encoding: "utf8", env }
  );
  const parsed = JSON.parse(r.stdout);
  assert.equal(
    parsed.review_output.verdict,
    "needs-attention",
    "paper approve from self-collect must be demoted"
  );
  assert.ok(
    parsed.review_output._verdictDemoted &&
      /paper-approve safeguard/i.test(parsed.review_output._verdictDemoted),
    "demotion reason should mention the safeguard"
  );
  assert.ok(
    parsed.review_output.findings.some((f) =>
      /exceeded inline byte caps|paper review/i.test(`${f.title} ${f.body}`)
    ),
    "synthetic finding describing the condition should be present"
  );
});

// Companion: --max-inline-bytes lets a diff that would otherwise drop to
// self-collect mode stay in inline-diff mode. We construct a diff just over
// the 256 KiB default total cap, then re-run with --max-inline-bytes raised
// past its size and confirm the paper-approve safeguard does NOT fire.
test("companion: --max-inline-bytes raises the inline cap so a >256KB diff inlines and the model verdict passes through", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-maxinline-"));
  execSync("git init -q", { cwd: repo });
  execSync('git config user.email "t@t" && git config user.name t', {
    cwd: repo,
    shell: "/bin/bash",
  });
  // ~320 KiB — above the 256 KiB default total cap, but comfortably below
  // the raised cap we'll set via the new flag. Per-file size is also above
  // the 64 KiB default per-file cap, so we raise that too.
  const bigContent = "old line\n".repeat(40000);
  writeFileSync(path.join(repo, "big.txt"), bigContent);
  execSync("git add . && git commit -q -m init", { cwd: repo, shell: "/bin/bash" });
  writeFileSync(path.join(repo, "big.txt"), bigContent.replace(/old/g, "new"));

  const mockBin = path.join(ROOT, "tests/fixtures/mock-claude.sh");
  const mockDir = mkdtempSync(path.join(tmpdir(), "claude-adv-maxinline-bin-"));
  execSync(`ln -sf '${mockBin}' '${mockDir}/claude'`);

  // Model approves cleanly — under inline-diff mode this should pass through;
  // under self-collect mode the runtime would demote it.
  const approveScript = JSON.stringify({
    events: [
      { type: "system", subtype: "init", session_id: "maxinline" },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                verdict: "approve",
                summary: "Mechanical rename across one file; no issues.",
                findings: [],
                next_steps: [],
              }),
            },
          ],
        },
      },
      { type: "result", subtype: "success", total_cost_usd: 0.001 },
    ],
    exitCode: 0,
  });

  const env = {
    ...process.env,
    PATH: `${mockDir}:${process.env.PATH}`,
    MOCK_CLAUDE_SCRIPT: approveScript,
  };

  const r = spawnSync(
    process.execPath,
    [
      COMPANION,
      "adversarial-review",
      "--wait",
      "--json",
      "--cwd",
      repo,
      "--max-inline-bytes",
      String(2 * 1024 * 1024),
      "--max-inline-file-bytes",
      String(1 * 1024 * 1024),
    ],
    { encoding: "utf8", env }
  );
  assert.equal(r.status, 0, `companion exited ${r.status}; stderr=${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(
    parsed.review_output.verdict,
    "approve",
    "with raised caps the model's approve verdict should pass through (no paper-approve demotion)"
  );
  assert.equal(
    parsed.review_output._verdictDemoted,
    undefined,
    "no demotion should occur when the diff fits the raised cap"
  );
});

test("companion: adversarial-review rejects non-positive --max-inline-bytes loudly", () => {
  // A typo silently absorbing to default would be the worst outcome — the
  // user thinks they raised the cap and gets a self-collect demotion anyway.
  const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-badcap-"));
  execSync("git init -q", { cwd: repo });
  execSync('git config user.email "t@t" && git config user.name t', {
    cwd: repo,
    shell: "/bin/bash",
  });
  writeFileSync(path.join(repo, "f.txt"), "x\n");
  execSync("git add . && git commit -q -m init", { cwd: repo, shell: "/bin/bash" });

  const r = spawnSync(
    process.execPath,
    [COMPANION, "adversarial-review", "--wait", "--json", "--cwd", repo, "--max-inline-bytes", "0"],
    { encoding: "utf8" }
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--max-inline-bytes must be a positive number/);
});

test("companion: status with no jobs returns empty snapshot", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-status-"));
  execSync("git init -q", { cwd: repo });
  const r = run(["status", "--json", "--cwd", repo]);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed.jobs ?? parsed.queued ?? parsed.recent ?? []));
});

test("companion: result with unknown job-id surfaces an error", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-result-"));
  execSync("git init -q", { cwd: repo });
  const r = run(["result", "no-such-job", "--cwd", repo]);
  assert.equal(r.status, 1);
});

test("companion: setup persists --set-rescue-budget-usd and --set-worker-budget-multiplier", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-budget-"));
  execSync("git init -q", { cwd: repo });
  const r = spawnSync(
    process.execPath,
    [
      COMPANION,
      "setup",
      "--json",
      "--cwd",
      repo,
      "--set-rescue-budget-usd",
      "37",
      "--set-worker-budget-multiplier",
      "8",
    ],
    { encoding: "utf8" }
  );
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.config.rescueBudgetUsd, 37);
  assert.equal(parsed.config.workerBudgetMultiplier, 8);
  // Surviving a second invocation confirms it actually persisted.
  const r2 = spawnSync(process.execPath, [COMPANION, "setup", "--json", "--cwd", repo], {
    encoding: "utf8",
  });
  const parsed2 = JSON.parse(r2.stdout);
  assert.equal(parsed2.config.rescueBudgetUsd, 37);
  assert.equal(parsed2.config.workerBudgetMultiplier, 8);
});

test("companion: setup rejects non-positive budget values", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-badbudget-"));
  execSync("git init -q", { cwd: repo });
  const r = spawnSync(
    process.execPath,
    [COMPANION, "setup", "--cwd", repo, "--set-rescue-budget-usd", "0"],
    { encoding: "utf8" }
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must be a positive number/);
});

test("companion: task runs rescue subprocess via mock-claude and returns the text", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-task-test-"));
  execSync("git init -q", { cwd: repo });
  const mockDir = mkdtempSync(path.join(tmpdir(), "claude-adv-bin-task-"));
  execSync(`ln -sf '${path.join(ROOT, "tests/fixtures/mock-claude.sh")}' '${mockDir}/claude'`);
  const env = {
    ...process.env,
    PATH: `${mockDir}:${process.env.PATH}`,
    MOCK_CLAUDE_SCRIPT: JSON.stringify({
      events: [
        { type: "system", subtype: "init", session_id: "mock-task" },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Task complete: edited foo.js" }],
          },
        },
        { type: "result", subtype: "success", total_cost_usd: 0.02 },
      ],
      exitCode: 0,
    }),
  };
  const r = spawnSync(
    process.execPath,
    [COMPANION, "task", "--json", "--cwd", repo, "fix the bug in foo.js"],
    { encoding: "utf8", env }
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.ok(parsed.rawOutput.includes("edited foo.js"));
});

// Regression: rescue must run IN the workspace, not a throwaway temp cwd. On
// subscription auth (no ANTHROPIC_API_KEY, no apiKeyHelper) the shared
// spawnAndCollect temp-cwd redirect — correct for the read-only reviewer —
// would otherwise spawn the write-capable rescue subprocess in an empty
// /tmp dir, breaking every relative-path edit it makes. The fix passes the
// workspace cwd + controlCwd:false from task.mjs.
test("companion: task rescue spawns in the workspace cwd on subscription auth (not a temp dir)", () => {
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), "claude-adv-task-cwd-")));
  execSync("git init -q", { cwd: repo });
  const fakeHome = mkdtempSync(path.join(tmpdir(), "claude-adv-task-cwd-home-"));
  const mockDir = mkdtempSync(path.join(tmpdir(), "claude-adv-bin-task-cwd-"));
  execSync(`ln -sf '${path.join(ROOT, "tests/fixtures/mock-claude.sh")}' '${mockDir}/claude'`);
  const cwdCapture = path.join(mockDir, "rescue-cwd.txt");

  const env = {
    ...process.env,
    // Force the subscription auth path (useBare=false): this is the path that
    // triggers the temp-cwd redirect inside spawnAndCollect.
    HOME: fakeHome,
    PATH: `${mockDir}:${process.env.PATH}`,
    MOCK_CLAUDE_CWD_CAPTURE: cwdCapture,
    MOCK_CLAUDE_SCRIPT: JSON.stringify({
      events: [
        { type: "system", subtype: "init", session_id: "mock-task-cwd" },
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        },
        { type: "result", subtype: "success", total_cost_usd: 0.01 },
      ],
      exitCode: 0,
    }),
  };
  delete env.ANTHROPIC_API_KEY;

  const r = spawnSync(
    process.execPath,
    [COMPANION, "task", "--json", "--cwd", repo, "fix the bug in foo.js"],
    { encoding: "utf8", env }
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);

  const spawnedCwd = realpathSync(readFileSync(cwdCapture, "utf8").trim());
  assert.equal(
    spawnedCwd,
    repo,
    `rescue subprocess must run in the workspace (${repo}), not ${spawnedCwd}`
  );

  rmSync(repo, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(mockDir, { recursive: true, force: true });
});

test("companion: background task records process start time for PID-reuse-safe liveness", (t) => {
  const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-task-background-start-"));
  const pluginData = mkdtempSync(path.join(tmpdir(), "claude-adv-task-background-state-"));
  execSync("git init -q", { cwd: repo });
  const mockDir = mkdtempSync(path.join(tmpdir(), "claude-adv-bin-task-background-"));
  execSync(`ln -sf '${path.join(ROOT, "tests/fixtures/mock-claude.sh")}' '${mockDir}/claude'`);
  let jobPid = null;
  t.after(() => {
    if (Number.isFinite(jobPid)) {
      try {
        process.kill(-jobPid, "SIGTERM");
      } catch {
        // The worker may have already exited; cleanup is best-effort.
      }
    }
    rmSync(repo, { recursive: true, force: true });
    rmSync(pluginData, { recursive: true, force: true });
    rmSync(mockDir, { recursive: true, force: true });
  });
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: pluginData,
    PATH: `${mockDir}:${process.env.PATH}`,
    MOCK_CLAUDE_SLEEP_SECONDS: "5",
    MOCK_CLAUDE_SCRIPT: JSON.stringify({
      events: [
        { type: "system", subtype: "init", session_id: "mock-task-bg" },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Task complete" }],
          },
        },
        { type: "result", subtype: "success", total_cost_usd: 0.02 },
      ],
      exitCode: 0,
    }),
  };

  const r = spawnSync(
    process.execPath,
    [COMPANION, "task", "--background", "--json", "--cwd", repo, "fix the bug in foo.js"],
    { encoding: "utf8", env }
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);

  const job = readStoredJob(repo, pluginData, parsed.jobId);

  jobPid = job.pid;
  assert.equal(job.status, "running");
  assert.equal(Number.isFinite(job.pid), true);
  assert.equal(Object.hasOwn(job, "startTime"), true);
  assert.ok(job.startTime === null || typeof job.startTime === "string");
  assert.ok(["captured", "unavailable", "pending"].includes(job.startTimeCapture));
});

test("companion: background task records a reason when start-time capture is unavailable", (t) => {
  const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-task-background-start-missing-"));
  const pluginData = mkdtempSync(
    path.join(tmpdir(), "claude-adv-task-background-start-missing-state-")
  );
  execSync("git init -q", { cwd: repo });
  const mockDir = mkdtempSync(path.join(tmpdir(), "claude-adv-bin-task-background-start-missing-"));
  execSync(`ln -sf '${path.join(ROOT, "tests/fixtures/mock-claude.sh")}' '${mockDir}/claude'`);
  writeSlowEmptyPsShim(mockDir);
  let job = null;
  t.after(() => {
    cleanupBackgroundJob(job);
    rmSync(repo, { recursive: true, force: true });
    rmSync(pluginData, { recursive: true, force: true });
    rmSync(mockDir, { recursive: true, force: true });
  });
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: pluginData,
    PATH: `${mockDir}:${process.env.PATH}`,
    MOCK_CLAUDE_SLEEP_SECONDS: "5",
    MOCK_CLAUDE_SCRIPT: JSON.stringify({
      events: [
        { type: "system", subtype: "init", session_id: "mock-task-missing-start" },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Task complete" }],
          },
        },
        { type: "result", subtype: "success", total_cost_usd: 0.02 },
      ],
      exitCode: 0,
    }),
  };

  const r = spawnSync(
    process.execPath,
    [COMPANION, "task", "--background", "--json", "--cwd", repo, "fix the bug in foo.js"],
    { encoding: "utf8", env }
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  job = readStoredJob(repo, pluginData, parsed.jobId);

  assert.equal(job.status, "running");
  assert.equal(job.startTime, null);
  assert.equal(job.startTimeCapture, "unavailable");
  assert.match(job.startTimeCaptureError, /PID-only liveness fallback/);
});

test("companion: background task does not overwrite fast completion after delayed start-time capture", (t) => {
  const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-task-background-race-"));
  const pluginData = mkdtempSync(path.join(tmpdir(), "claude-adv-task-background-race-state-"));
  execSync("git init -q", { cwd: repo });
  const mockDir = mkdtempSync(path.join(tmpdir(), "claude-adv-bin-task-background-race-"));
  execSync(`ln -sf '${path.join(ROOT, "tests/fixtures/mock-claude.sh")}' '${mockDir}/claude'`);
  writeSlowEmptyPsShim(mockDir);
  let job = null;
  t.after(() => {
    cleanupBackgroundJob(job);
    rmSync(repo, { recursive: true, force: true });
    rmSync(pluginData, { recursive: true, force: true });
    rmSync(mockDir, { recursive: true, force: true });
  });
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: pluginData,
    PATH: `${mockDir}:${process.env.PATH}`,
    MOCK_CLAUDE_SCRIPT: JSON.stringify({
      events: [
        { type: "system", subtype: "init", session_id: "mock-task-race" },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Task complete" }],
          },
        },
        { type: "result", subtype: "success", total_cost_usd: 0.02 },
      ],
      exitCode: 0,
    }),
  };

  const r = spawnSync(
    process.execPath,
    [COMPANION, "task", "--background", "--json", "--cwd", repo, "fix the bug in foo.js"],
    { encoding: "utf8", env }
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  // The task subprocess is detached; the parent returns as soon as the
  // running-record handshake completes. Poll for terminal status so we
  // observe the no-overwrite invariant (parent's "running" write loses to
  // the child's "completed" write via writeJobFileUnlessStatus) rather than
  // racing the detached child. Deadline is generous because the full-suite
  // parallelism can starve a detached child for several seconds.
  // Detached child writes the per-job file then upserts the state.json index;
  // poll BOTH so we don't observe the small write-then-upsert window.
  const deadline = Date.now() + 20000;
  let indexedJob = null;
  while (Date.now() < deadline) {
    job = readStoredJob(repo, pluginData, parsed.jobId);
    indexedJob = readIndexedJob(repo, pluginData, parsed.jobId);
    if (
      (job?.status === "completed" || job?.status === "failed") &&
      (indexedJob?.status === "completed" || indexedJob?.status === "failed")
    ) {
      break;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }

  assert.equal(job.status, "completed");
  assert.equal(job.phase, "completed");
  assert.equal(indexedJob.status, "completed");
  assert.equal(indexedJob.phase, "completed");
  assert.ok(job.rawPayload.rawOutput.includes("Task complete"));
});

test("companion: background review does not overwrite fast completion after delayed start-time capture", (t) => {
  const repo = makeRepoWithDirty();
  const pluginData = mkdtempSync(path.join(tmpdir(), "claude-adv-review-background-race-state-"));
  const mockDir = mockBinDir();
  writeSlowEmptyPsShim(mockDir);
  let job = null;
  t.after(() => {
    cleanupBackgroundJob(job);
    rmSync(repo, { recursive: true, force: true });
    rmSync(pluginData, { recursive: true, force: true });
    rmSync(mockDir, { recursive: true, force: true });
  });
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: pluginData,
    PATH: `${mockDir}:${process.env.PATH}`,
    MOCK_CLAUDE_SCRIPT: reviewScript({
      verdict: "approve",
      summary: "clean",
      findings: [],
      next_steps: [],
    }),
  };

  const r = spawnSync(
    process.execPath,
    [
      COMPANION,
      "adversarial-review",
      "--background",
      "--json",
      "--scope",
      "working-tree",
      "--cwd",
      repo,
    ],
    { encoding: "utf8", env }
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  // The review subprocess is detached; the parent returns as soon as the
  // running-record handshake completes. Poll for terminal status so we
  // observe the no-overwrite invariant (parent's "running" write loses to
  // the child's "completed" write via writeJobFileUnlessStatus) rather than
  // racing the detached child. Deadline is generous because the full-suite
  // parallelism can starve a detached child for several seconds.
  // Detached child writes the per-job file then upserts the state.json index;
  // poll BOTH so we don't observe the small write-then-upsert window.
  const deadline = Date.now() + 20000;
  let indexedJob = null;
  while (Date.now() < deadline) {
    job = readStoredJob(repo, pluginData, parsed.jobId);
    indexedJob = readIndexedJob(repo, pluginData, parsed.jobId);
    if (
      (job?.status === "completed" || job?.status === "failed") &&
      (indexedJob?.status === "completed" || indexedJob?.status === "failed")
    ) {
      break;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }

  assert.equal(job.status, "completed");
  assert.equal(job.phase, "completed");
  assert.equal(indexedJob.status, "completed");
  assert.equal(indexedJob.phase, "completed");
  assert.equal(job.review_output.verdict, "approve");
});
