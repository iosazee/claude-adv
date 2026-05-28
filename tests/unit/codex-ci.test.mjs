import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const ADAPTER = path.join(ROOT, "plugins/claude-adv/scripts/claude-adv-codex.mjs");
const COMPANION = path.join(ROOT, "plugins/claude-adv/scripts/claude-companion.mjs");
const MOCK_CLAUDE = path.join(ROOT, "tests/fixtures/mock-claude.sh");
const CI_REASON_PAYLOADS = Object.freeze({
  "claude-missing": {
    ready: false,
    readinessReason: "claude-missing",
    claude: { available: false },
    auth: { loggedIn: false, failureKind: "probe-error" },
  },
  "auth-missing": {
    ready: false,
    readinessReason: "auth-missing",
    claude: { available: true },
    auth: {
      available: true,
      loggedIn: false,
      failureKind: "missing",
      detail: "not logged in",
    },
  },
  "auth-invalid": {
    ready: false,
    readinessReason: "auth-invalid",
    claude: { available: true },
    auth: {
      available: true,
      loggedIn: false,
      failureKind: "invalid",
      detail: "401 unauthorized",
    },
  },
  "auth-unknown-parse": {
    ready: false,
    readinessReason: "auth-unknown",
    claude: { available: true },
    auth: {
      available: true,
      loggedIn: false,
      failureKind: "parse-error",
      detail: "malformed auth status JSON",
    },
  },
  "auth-unknown-provider": {
    ready: false,
    readinessReason: "auth-unknown",
    claude: { available: true },
    auth: {
      available: true,
      loggedIn: false,
      failureKind: "unknown",
      detail: "unexpected provider failure",
    },
  },
  "auth-unknown-probe": {
    ready: false,
    readinessReason: "auth-unknown",
    claude: { available: true },
    auth: {
      available: true,
      loggedIn: false,
      failureKind: "probe-error",
      detail: "auth probe failed",
    },
  },
  ready: {
    ready: true,
    readinessReason: null,
    claude: { available: true },
    auth: { available: true, loggedIn: true },
  },
});
const SIGNAL_CODES = Object.freeze({
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
});

function makeRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-ci-repo-"));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  return repo;
}

function makeCodexHome() {
  return mkdtempSync(path.join(tmpdir(), "claude-adv-ci-codex-home-"));
}

function makeHomeWithCodex() {
  const home = mkdtempSync(path.join(tmpdir(), "claude-adv-ci-home-"));
  mkdirSync(path.join(home, ".codex"));
  return home;
}

function makeToolPath() {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-adv-ci-tools-"));
  symlinkSync(process.execPath, path.join(dir, "node"));
  symlinkSync(MOCK_CLAUDE, path.join(dir, "claude"));
  return `${dir}:${process.env.PATH}`;
}

function reviewScript() {
  return JSON.stringify({
    events: [
      { type: "system", session_id: "mock-claude-session" },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                verdict: "approve",
                summary: "CI-ready review",
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

function makeCaptureImport() {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-adv-ci-capture-"));
  const file = path.join(dir, "capture.mjs");
  const log = path.join(dir, "capture.jsonl");
  writeFileSync(
    file,
    `import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
const isCompanion = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(process.env.CAPTURE_COMPANION);
appendFileSync(process.env.CAPTURE_FILE, JSON.stringify({
  argv: process.argv,
  cwd: process.cwd(),
  isCompanion
}) + "\\n");
if (isCompanion && process.argv[2] === "setup" && process.env.CI_SETUP_TIMEOUT === "1") {
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore"
  });
  if (process.env.CI_PREFLIGHT_GRANDCHILD_PID_FILE) {
    writeFileSync(process.env.CI_PREFLIGHT_GRANDCHILD_PID_FILE, String(grandchild.pid));
  }
  setInterval(() => {}, 1000);
}
if (isCompanion && process.argv[2] === "setup" && process.env.CI_SETUP_STDOUT !== undefined) {
  process.stdout.write(process.env.CI_SETUP_STDOUT);
  if (!process.env.CI_SETUP_STDOUT.endsWith("\\n")) process.stdout.write("\\n");
  if (process.env.CI_SETUP_STDERR) process.stderr.write(process.env.CI_SETUP_STDERR);
  process.exit(Number(process.env.CI_SETUP_EXIT_CODE ?? "0"));
}
if (isCompanion && process.env.CAPTURE_EXIT_COMPANION) {
  process.exit(Number(process.env.CAPTURE_EXIT_COMPANION));
}
`
  );
  return { file, log };
}

function runAdapter(args, options = {}) {
  const capture = makeCaptureImport();
  const nodeOptions = `${process.env.NODE_OPTIONS ?? ""} --import=${capture.file}`.trim();
  const env = {
    ...process.env,
    ANTHROPIC_API_KEY: "",
    CODEX_CI: "1",
    CODEX_HOME: options.codexHome ?? makeCodexHome(),
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "",
    CODEX_THREAD_ID: "ci-thread",
    HOME: options.home ?? makeHomeWithCodex(),
    CAPTURE_COMPANION: COMPANION,
    CAPTURE_EXIT_COMPANION: options.exitCompanion === false ? "" : "42",
    CAPTURE_FILE: capture.log,
    CI_SETUP_STDOUT:
      options.setupStdout ?? JSON.stringify(options.setupPayload ?? CI_REASON_PAYLOADS.ready),
    CI_SETUP_EXIT_CODE: String(options.setupExitCode ?? 0),
    NODE_OPTIONS: nodeOptions,
    PATH: options.pathValue ?? process.env.PATH,
    ...options.env,
  };
  if (options.setupStdout === null) {
    delete env.CI_SETUP_STDOUT;
  }
  if (options.exitCompanion === false) {
    delete env.CAPTURE_EXIT_COMPANION;
  }

  const result = spawnSync(process.execPath, [ADAPTER, ...args], {
    cwd: options.cwd ?? makeRepo(),
    encoding: "utf8",
    env,
    timeout: options.timeout ?? 15_000,
  });
  const records = existsSync(capture.log)
    ? readFileSync(capture.log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  return { result, records, capture };
}

function companionRecords(records) {
  return records.filter(
    (record) => record.isCompanion && record.argv[1] && path.resolve(record.argv[1]) === COMPANION
  );
}

function companionSubcommands(records) {
  return companionRecords(records).map((record) => record.argv[2]);
}

function assertCiPrecondition(result, reason) {
  assert.equal(result.status, 78, result.stderr);
  assert.match(
    result.stderr,
    new RegExp(`claude-adv-codex: ci-precondition-failed \\(reason=${reason}\\)`)
  );
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function killPid(pid, signal = "SIGKILL") {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, label, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 25;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await delay(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForClose(child, timeoutMs = 15_000) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      killPid(child.pid);
      reject(new Error(`timed out waiting for adapter ${child.pid}`));
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function readPidFile(file) {
  if (!existsSync(file)) return null;
  const pid = Number(readFileSync(file, "utf8").trim());
  return Number.isFinite(pid) ? pid : null;
}

function spawnAdapterWithHangingPreflight(signalName = null) {
  const capture = makeCaptureImport();
  const scratch = mkdtempSync(path.join(tmpdir(), "claude-adv-ci-hang-"));
  const grandchildPidFile = path.join(scratch, "grandchild.pid");
  const nodeOptions = `${process.env.NODE_OPTIONS ?? ""} --import=${capture.file}`.trim();
  const env = {
    ...process.env,
    ANTHROPIC_API_KEY: "",
    CODEX_CI: "1",
    CODEX_HOME: makeCodexHome(),
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "",
    CODEX_THREAD_ID: "ci-thread",
    HOME: makeHomeWithCodex(),
    CAPTURE_COMPANION: COMPANION,
    CAPTURE_FILE: capture.log,
    CI_PREFLIGHT_GRANDCHILD_PID_FILE: grandchildPidFile,
    CI_SETUP_TIMEOUT: "1",
    NODE_OPTIONS: nodeOptions,
  };
  const child = spawn(process.execPath, [ADAPTER, "review", "--wait"], {
    cwd: makeRepo(),
    env,
    stdio: "ignore",
  });
  return { child, grandchildPidFile, signalName };
}

test("truthy CODEX_CI values enable setup preflight outside Codex Desktop", () => {
  for (const value of ["1", "true", "yes", "TRUE", "YES"]) {
    const { result, records } = runAdapter(["review", "--wait"], {
      env: { CODEX_CI: value, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "" },
    });

    assert.equal(result.status, 42, value);
    assert.deepEqual(companionSubcommands(records), ["setup", "review"], value);
  }
});

test("Codex Desktop origin disables CI behavior even when CODEX_CI is present", () => {
  const { result, records } = runAdapter(["status"], {
    env: {
      CODEX_CI: "1",
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop",
    },
  });

  assert.equal(result.status, 42);
  assert.deepEqual(companionSubcommands(records), ["status"]);
  assert.doesNotMatch(result.stderr, /ci-mode-requires-explicit-job-id/);
});

test("CI status/result/cancel require explicit job ids", () => {
  for (const subcommand of ["status", "result", "cancel"]) {
    const { result, records } = runAdapter([subcommand, "--json"]);

    assert.notEqual(result.status, 0, subcommand);
    assert.match(
      result.stderr,
      new RegExp(
        `claude-adv-codex: ci-mode-requires-explicit-job-id \\(subcommand=${subcommand}\\)`
      )
    );
    assert.deepEqual(companionRecords(records), [], subcommand);
  }
});

test("CI status/result/cancel delegate with explicit job ids", () => {
  for (const subcommand of ["status", "result", "cancel"]) {
    const { result, records } = runAdapter([subcommand, "job-123", "--json"]);

    assert.equal(result.status, 42, subcommand);
    assert.deepEqual(companionSubcommands(records), [subcommand], subcommand);
  }
});

test("CI review, adversarial-review, and task run setup preflight before delegation", () => {
  for (const subcommand of ["review", "adversarial-review", "task"]) {
    const args = subcommand === "task" ? [subcommand, "fix it"] : [subcommand, "--wait"];
    const { result, records } = runAdapter(args);

    assert.equal(result.status, 42, subcommand);
    assert.deepEqual(companionSubcommands(records), ["setup", subcommand], subcommand);
  }
});

test("CI setup readiness reasons map to precondition failures", () => {
  const cases = [
    ["claude-missing", "claude-missing"],
    ["auth-missing", "auth-missing"],
    ["auth-invalid", "auth-invalid"],
    ["auth-unknown-parse", "auth-unknown"],
    ["auth-unknown-provider", "auth-unknown"],
    ["auth-unknown-probe", "auth-unknown"],
  ];

  for (const [fixtureName, reason] of cases) {
    const { result, records } = runAdapter(["review", "--wait"], {
      setupPayload: CI_REASON_PAYLOADS[fixtureName],
    });

    assertCiPrecondition(result, reason);
    assert.deepEqual(companionSubcommands(records), ["setup"], fixtureName);
  }
});

test("CI malformed setup outcomes map to setup-malformed", () => {
  const cases = [
    { name: "non-zero setup", setupPayload: CI_REASON_PAYLOADS.ready, setupExitCode: 2 },
    { name: "malformed JSON", setupStdout: "not json" },
    { name: "missing ready", setupPayload: { readinessReason: null } },
    {
      name: "node missing contradiction",
      setupPayload: { ready: false, readinessReason: "node-missing" },
    },
    { name: "unknown reason", setupPayload: { ready: false, readinessReason: "surprise" } },
  ];

  for (const testCase of cases) {
    const { result, records } = runAdapter(["review", "--wait"], testCase);

    assertCiPrecondition(result, "setup-malformed");
    assert.deepEqual(companionSubcommands(records), ["setup"], testCase.name);
  }
});

test("CI setup preflight timeout exits 78 and kills the preflight process group", {
  timeout: 16_000,
}, async () => {
  const run = spawnAdapterWithHangingPreflight();
  let grandchildPid;
  try {
    grandchildPid = await waitFor(
      () => readPidFile(run.grandchildPidFile),
      "preflight grandchild pid"
    );

    const result = await waitForClose(run.child, 14_000);
    assert.equal(result.code, 78);
    assert.equal(result.signal, null);
    await waitFor(() => !processExists(grandchildPid), "preflight grandchild cleanup");
  } finally {
    if (grandchildPid) killPid(grandchildPid);
    if (processExists(run.child.pid)) killPid(run.child.pid);
  }
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  test(`adapter ${signal} during CI preflight cleans up the preflight process group`, async () => {
    const run = spawnAdapterWithHangingPreflight(signal);
    let grandchildPid;
    try {
      grandchildPid = await waitFor(
        () => readPidFile(run.grandchildPidFile),
        "preflight grandchild pid"
      );
      process.kill(run.child.pid, signal);

      const result = await waitForClose(run.child, 8000);
      assert.deepEqual(result, { code: SIGNAL_CODES[signal], signal: null });
      await waitFor(() => !processExists(grandchildPid), "preflight grandchild cleanup");
    } finally {
      if (grandchildPid) killPid(grandchildPid);
      if (processExists(run.child.pid)) killPid(run.child.pid);
    }
  });
}

test("ready CI setup allows mock-driven adversarial-review --wait to run", () => {
  const { result, records } = runAdapter(
    ["adversarial-review", "--wait", "--scope", "working-tree", "--json"],
    {
      cwd: makeRepo(),
      exitCompanion: false,
      pathValue: makeToolPath(),
      setupPayload: CI_REASON_PAYLOADS.ready,
      env: {
        MOCK_CLAUDE_SCRIPT: reviewScript(),
      },
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).review, "Adversarial Review");
  assert.deepEqual(companionSubcommands(records), ["setup", "adversarial-review"]);
});

test("CI setup, status, result, and cancel do not run setup preflight", () => {
  const setupRun = runAdapter(["setup", "--json"], {
    setupPayload: CI_REASON_PAYLOADS.ready,
  });
  assert.equal(setupRun.result.status, 0, setupRun.result.stderr);
  assert.deepEqual(companionSubcommands(setupRun.records), ["setup"]);

  for (const subcommand of ["status", "result", "cancel"]) {
    const { result, records } = runAdapter([subcommand, "job-123", "--json"]);

    assert.equal(result.status, 42, subcommand);
    assert.deepEqual(companionSubcommands(records), [subcommand], subcommand);
  }
});
