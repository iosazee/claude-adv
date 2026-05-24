import { strict as assert } from "node:assert";
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const ADAPTER = path.join(ROOT, "codex/scripts/claude-adv-codex.mjs");
const MOCK_CLAUDE = path.join(ROOT, "tests/fixtures/mock-claude.sh");
const SMUGGLED_FLAGS = [
  "--allow-resume",
  "--session",
  "--mcp-config",
  "--input-format",
  "--replay-user-messages",
];

function makeRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-codex-invariants-repo-"));
  execSync("git init -q", { cwd: repo });
  execSync('git config user.email "t@example.com" && git config user.name test', {
    cwd: repo,
    shell: "/bin/bash",
  });
  writeFileSync(path.join(repo, "file.txt"), "old\n");
  execSync("git add . && git commit -q -m init", { cwd: repo, shell: "/bin/bash" });
  writeFileSync(path.join(repo, "file.txt"), "new\n");
  return repo;
}

function makeCodexHome() {
  return mkdtempSync(path.join(tmpdir(), "claude-adv-codex-invariants-home-"));
}

function makeHomeWithCodex() {
  const home = mkdtempSync(path.join(tmpdir(), "claude-adv-codex-invariants-user-home-"));
  mkdirSync(path.join(home, ".codex"));
  return home;
}

function makeToolPath() {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-adv-codex-invariants-tools-"));
  symlinkSync(process.execPath, path.join(dir, "node"));
  symlinkSync(MOCK_CLAUDE, path.join(dir, "claude"));
  return `${dir}:${process.env.PATH}`;
}

function mockScript() {
  return JSON.stringify({
    events: [
      { type: "system", session_id: "mock-session" },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                verdict: "approve",
                summary: "safe argv",
                findings: [],
                next_steps: [],
              }),
            },
          ],
        },
      },
      { type: "result", total_cost_usd: 0.001 },
    ],
    exitCode: 0,
  });
}

function runAdapter(args, options = {}) {
  const captureFile = path.join(
    mkdtempSync(path.join(tmpdir(), "claude-adv-codex-invariants-capture-")),
    "argv.jsonl"
  );
  // Auth-class control: by default tests run with NO API key, exercising the
  // subscription path (no --bare). Pass apiKey: "sk-ant-..." to exercise the
  // API-key path (--bare emitted).
  const apiKey = options.apiKey ?? "";
  const result = spawnSync(process.execPath, [ADAPTER, ...args], {
    cwd: options.cwd ?? makeRepo(),
    encoding: "utf8",
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: apiKey,
      CODEX_HOME: makeCodexHome(),
      CODEX_THREAD_ID: "invariants-thread",
      HOME: makeHomeWithCodex(),
      MOCK_CLAUDE_ARGV_CAPTURE: captureFile,
      MOCK_CLAUDE_SCRIPT: mockScript(),
      PATH: makeToolPath(),
    },
  });
  const captures = readFileSync(captureFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(captures.length, 1, result.stderr);
  return { result, argv: captures[0] };
}

function valuesAfter(argv, flag) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === flag) values.push(argv[index + 1]);
  }
  return values;
}

// --bare presence depends on auth class (API key vs subscription). Every
// OTHER invariant survives on both paths. The auth-class-specific check is
// kept in dedicated tests below; the shared assertion checks only what's
// invariant across both auth paths.
function assertLockedSharedInvariants(argv) {
  assert.ok(argv.includes("--print"));
  assert.ok(argv.includes("--verbose"));
  assert.ok(argv.includes("--no-session-persistence"));
  assert.deepEqual(valuesAfter(argv, "--setting-sources"), [""]);
  for (const flag of SMUGGLED_FLAGS) {
    assert.equal(argv.includes(flag), false, flag);
  }
}

function assertReviewerInvariants(argv) {
  assertLockedSharedInvariants(argv);
  assert.deepEqual(valuesAfter(argv, "--tools"), [""]);
  assert.deepEqual(valuesAfter(argv, "--permission-mode"), ["default"]);
}

function assertRescueInvariants(argv) {
  assertLockedSharedInvariants(argv);
  assert.equal(argv.includes("--tools"), false);
  assert.deepEqual(valuesAfter(argv, "--permission-mode"), ["bypassPermissions"]);
}

test("codex adversarial-review cannot smuggle unsafe claude argv", () => {
  const { result, argv } = runAdapter([
    "adversarial-review",
    "--wait",
    "--allow-resume",
    "--session",
    "bad",
    "--mcp-config",
    "bad",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assertReviewerInvariants(argv);
});

test("codex review preserves reviewer invariants against tool/settings smuggling", () => {
  const { result, argv } = runAdapter([
    "review",
    "--wait",
    "--tools",
    "danger",
    "--setting-sources",
    "project",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assertReviewerInvariants(argv);
});

test("codex task preserves rescue invariants against worker-mode smuggling", () => {
  const { result, argv } = runAdapter([
    "task",
    "--input-format",
    "stream-json",
    "--replay-user-messages",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assertRescueInvariants(argv);
});

// Auth-class branching tests: every other invariant is preserved on both
// paths; --bare specifically is emitted iff the API key path is taken.
test("subscription auth path (no API key): adversarial-review omits --bare", () => {
  const { result, argv } = runAdapter(["adversarial-review", "--wait"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(argv.includes("--bare"), false, "--bare must NOT appear without API key");
  assertReviewerInvariants(argv); // every other invariant survives
});

test("API-key auth path (ANTHROPIC_API_KEY set): adversarial-review emits --bare", () => {
  const { result, argv } = runAdapter(["adversarial-review", "--wait"], {
    apiKey: "sk-ant-fake-for-test",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(argv.includes("--bare"), "--bare must appear with API key");
  assertReviewerInvariants(argv);
});

test("subscription auth path: task (rescue) omits --bare", () => {
  const { result, argv } = runAdapter(["task", "--wait", "fix something"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(argv.includes("--bare"), false);
  assertRescueInvariants(argv);
});

test("API-key auth path: task (rescue) emits --bare", () => {
  const { result, argv } = runAdapter(["task", "--wait", "fix something"], {
    apiKey: "sk-ant-fake-for-test",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(argv.includes("--bare"));
  assertRescueInvariants(argv);
});
