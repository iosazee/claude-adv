import { strict as assert } from "node:assert";
import { execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { upsertJob, writeJobFile } from "../../scripts/lib/state.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const ADAPTER = path.join(ROOT, "plugins/claude-adv/scripts/claude-adv-codex.mjs");
const COMPANION = path.join(ROOT, "plugins/claude-adv/scripts/claude-companion.mjs");
const OTHER_CODEX_SESSION = "codex:thread-B@bbbbbbbb";
const LEGACY_CLAUDE_SESSION = "thread-A";

function makeRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-codex-state-repo-"));
  execSync("git init -q", { cwd: repo });
  return repo;
}

function makeCodexHome() {
  return mkdtempSync(path.join(tmpdir(), "claude-adv-codex-state-home-"));
}

function makeHomeWithCodex() {
  const home = mkdtempSync(path.join(tmpdir(), "claude-adv-codex-state-user-home-"));
  mkdirSync(path.join(home, ".codex"));
  return home;
}

function makeToolPath() {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-adv-codex-state-tools-"));
  symlinkSync(process.execPath, path.join(dir, "node"));
  writeFileSync(
    path.join(dir, "claude"),
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' "fake claude 1.0"
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ] && [ "$3" = "--json" ]; then
  printf '%s\\n' '{"logged_in":true,"auth_method":"test"}'
  exit 0
fi
printf '%s\\n' "unexpected claude args: $*" >&2
exit 2
`,
    { mode: 0o755 }
  );
  return `${dir}:${process.env.PATH}`;
}

function makeCaptureImport() {
  const file = path.join(
    mkdtempSync(path.join(tmpdir(), "claude-adv-codex-state-capture-")),
    "capture.mjs"
  );
  const log = path.join(
    mkdtempSync(path.join(tmpdir(), "claude-adv-codex-state-capture-log-")),
    "env.jsonl"
  );
  writeFileSync(
    file,
    `import { appendFileSync } from "node:fs";
const keys = [
  "CLAUDE_PLUGIN_DATA",
  "CODEX_PLUGIN_DATA",
  "CLAUDE_ADV_SESSION_ID",
  "CLAUDE_ADV_WARN_CROSS_SESSION",
  "CLAUDE_SESSION_ID"
];
appendFileSync(process.env.CAPTURE_FILE, JSON.stringify({
  argv: process.argv,
  cwd: process.cwd(),
  env: Object.fromEntries(keys.map((key) => [key, process.env[key]]))
}) + "\\n");
`
  );
  return { file, log };
}

function runAdapter(args, options = {}) {
  return spawnSync(process.execPath, [ADAPTER, ...args], {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_CI: "0",
      CODEX_HOME: options.codexHome ?? makeCodexHome(),
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "",
      HOME: options.home ?? makeHomeWithCodex(),
      PATH: options.pathValue ?? makeToolPath(),
      ...options.env,
    },
  });
}

function runAdapterWithCapture(args, options = {}) {
  const capture = makeCaptureImport();
  const nodeOptions = `${process.env.NODE_OPTIONS ?? ""} --import=${capture.file}`.trim();
  const result = runAdapter(args, {
    ...options,
    env: {
      ...options.env,
      CAPTURE_FILE: capture.log,
      NODE_OPTIONS: nodeOptions,
    },
  });
  const records = existsSync(capture.log)
    ? readFileSync(capture.log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  return { result, records };
}

function companionRecord(records) {
  return records.find((record) => record.argv[1] && path.resolve(record.argv[1]) === COMPANION);
}

function pluginDataForCodexHome(codexHome) {
  return path.join(realpathSync(codexHome), "state", "claude-adv");
}

function withPluginData(pluginData, fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

function captureCurrentSession(repo, codexHome) {
  const { result, records } = runAdapterWithCapture(["status", "--json"], {
    cwd: repo,
    codexHome,
    env: {
      CODEX_THREAD_ID: "thread-A",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const companion = companionRecord(records);
  assert.ok(companion, "expected delegated companion process");
  const sessionId = companion.env.CLAUDE_ADV_SESSION_ID;
  assert.match(sessionId, /^codex:thread-A@[0-9a-f]{8}$/);
  assert.equal(companion.env.CLAUDE_SESSION_ID, undefined);
  return sessionId;
}

function seedJobs(repo, codexHome, currentSession) {
  withPluginData(pluginDataForCodexHome(codexHome), () => {
    for (const job of [
      { id: "done-current", status: "completed", sessionId: currentSession },
      { id: "done-other", status: "completed", sessionId: OTHER_CODEX_SESSION },
      { id: "done-legacy", status: "completed", sessionId: LEGACY_CLAUDE_SESSION },
      { id: "active-current", status: "running", sessionId: currentSession },
      { id: "active-other", status: "running", sessionId: OTHER_CODEX_SESSION },
      { id: "active-legacy", status: "running", sessionId: LEGACY_CLAUDE_SESSION },
    ]) {
      upsertJob(repo, {
        id: job.id,
        status: job.status,
        phase: job.status,
        kind: "task",
        jobClass: "task",
        title: job.id,
        sessionId: job.sessionId,
        pid: null,
      });
      writeJobFile(repo, job.id, {
        id: job.id,
        status: job.status,
        sessionId: job.sessionId,
        result: { rawOutput: `${job.id} output` },
      });
    }
  });
}

function makeSeededJobFixture() {
  const repo = makeRepo();
  const codexHome = makeCodexHome();
  const currentSession = captureCurrentSession(repo, codexHome);
  seedJobs(repo, codexHome, currentSession);
  return { repo, codexHome, currentSession };
}

function parseJson(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function assertNoCrossSessionWarning(result) {
  assert.doesNotMatch(result.stderr, /cross-session (result|cancel)/);
}

test("codex adapter ignores inherited plugin-data env and writes state under CODEX_HOME", () => {
  const repo = makeRepo();
  const codexHome = makeCodexHome();
  const inheritedClaudeA = mkdtempSync(path.join(tmpdir(), "claude-adv-divergent-claude-a-"));
  const inheritedClaudeB = mkdtempSync(path.join(tmpdir(), "claude-adv-divergent-claude-b-"));
  const inheritedCodex = path.join(
    mkdtempSync(path.join(tmpdir(), "claude-adv-divergent-codex-")),
    "state-root"
  );

  const first = runAdapter(["setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    codexHome,
    env: {
      CLAUDE_PLUGIN_DATA: inheritedClaudeA,
      CODEX_PLUGIN_DATA: inheritedCodex,
      CODEX_THREAD_ID: "",
    },
  });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).config.stopReviewGate, true);

  const second = runAdapter(["setup", "--disable-review-gate", "--json"], {
    cwd: repo,
    codexHome,
    env: {
      CLAUDE_PLUGIN_DATA: inheritedClaudeB,
      CODEX_PLUGIN_DATA: inheritedCodex,
      CODEX_THREAD_ID: "",
    },
  });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).config.stopReviewGate, false);

  const stateRoot = path.join(pluginDataForCodexHome(codexHome), "state");
  const workspaceDirs = readdirSync(stateRoot);
  assert.equal(workspaceDirs.length, 1);
  const stateFile = path.join(stateRoot, workspaceDirs[0], "state.json");
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(state.config.stopReviewGate, false);
  assert.equal(stateFile.startsWith(`${pluginDataForCodexHome(codexHome)}${path.sep}`), true);
  assert.equal(existsSync(path.join(inheritedClaudeA, "state")), false);
  assert.equal(existsSync(path.join(inheritedClaudeB, "state")), false);
  assert.equal(existsSync(inheritedCodex), false);
});

test("codex default status, result, and cancel are scoped to the current Codex session", () => {
  const { repo, codexHome } = makeSeededJobFixture();
  const env = { CODEX_THREAD_ID: "thread-A" };

  const status = parseJson(runAdapter(["status", "--json"], { cwd: repo, codexHome, env }));
  assert.deepEqual(
    status.running.map((job) => job.id),
    ["active-current"]
  );
  assert.equal(status.latestFinished.id, "done-current");
  assert.doesNotMatch(JSON.stringify(status), /done-other|done-legacy|active-other|active-legacy/);

  const result = runAdapter(["result", "--json"], { cwd: repo, codexHome, env });
  const resultPayload = parseJson(result);
  assert.equal(resultPayload.job.id, "done-current");
  assert.equal(resultPayload.storedJob.result.rawOutput, "done-current output");
  assertNoCrossSessionWarning(result);

  const cancel = runAdapter(["cancel", "--json"], { cwd: repo, codexHome, env });
  const cancelPayload = parseJson(cancel);
  assert.equal(cancelPayload.jobId, "active-current");
  assertNoCrossSessionWarning(cancel);
});

test("codex explicit job references resolve outside the current session and warn for result/cancel", () => {
  const { repo, codexHome, currentSession } = makeSeededJobFixture();
  const env = { CODEX_THREAD_ID: "thread-A" };

  const status = parseJson(
    runAdapter(["status", "done-other", "--json"], { cwd: repo, codexHome, env })
  );
  assert.equal(status.job.id, "done-other");
  assert.equal(status.job.sessionId, OTHER_CODEX_SESSION);

  const result = runAdapter(["result", "done-other", "--json"], { cwd: repo, codexHome, env });
  const resultPayload = parseJson(result);
  assert.equal(resultPayload.job.id, "done-other");
  assert.ok(
    result.stderr.includes(
      `claude-adv-runtime: warning: cross-session result ` +
        `(expected=${currentSession} target=${OTHER_CODEX_SESSION} job=done-other)`
    ),
    result.stderr
  );

  const cancel = runAdapter(["cancel", "active-other", "--json"], { cwd: repo, codexHome, env });
  const cancelPayload = parseJson(cancel);
  assert.equal(cancelPayload.jobId, "active-other");
  assert.ok(
    cancel.stderr.includes(
      `claude-adv-runtime: warning: cross-session cancel ` +
        `(expected=${currentSession} target=${OTHER_CODEX_SESSION} job=active-other)`
    ),
    cancel.stderr
  );
});

test("explicit cross-session result and cancel do not warn without adapter warning env", () => {
  const { repo, codexHome } = makeSeededJobFixture();
  const env = { CODEX_THREAD_ID: "" };

  const result = runAdapter(["result", "done-other", "--json"], { cwd: repo, codexHome, env });
  assert.equal(parseJson(result).job.id, "done-other");
  assertNoCrossSessionWarning(result);

  const cancel = runAdapter(["cancel", "active-other", "--json"], { cwd: repo, codexHome, env });
  assert.equal(parseJson(cancel).jobId, "active-other");
  assertNoCrossSessionWarning(cancel);
});
