import { strict as assert } from "node:assert";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const ADAPTER = path.join(ROOT, "codex/scripts/claude-adv-codex.mjs");
const COMPANION = path.join(ROOT, "scripts/claude-companion.mjs");
const MOCK_CLAUDE = path.join(ROOT, "tests/fixtures/mock-claude.sh");
const SIGNAL_CODES = Object.freeze({
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
});

const posixTest = process.platform === "win32" ? test.skip : test;

function makeRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-signal-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  return repo;
}

function makeCodexHome() {
  return mkdtempSync(path.join(tmpdir(), "claude-adv-signal-codex-home-"));
}

function makeToolPath() {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-adv-signal-tools-"));
  symlinkSync(process.execPath, path.join(dir, "node"));
  symlinkSync(MOCK_CLAUDE, path.join(dir, "claude"));
  return `${dir}:${process.env.PATH}`;
}

function mockScript() {
  return JSON.stringify({
    events: [
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "done" }] },
      },
    ],
    exitCode: 0,
  });
}

function processTable() {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,command="], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        command: match[4],
      };
    })
    .filter(Boolean);
}

function findCompanionChild(adapterPid) {
  return processTable().find(
    (entry) => entry.ppid === adapterPid && entry.command.includes(COMPANION)
  );
}

function companionProcessesForPrompt(prompt) {
  return processTable().filter(
    (entry) => entry.command.includes(COMPANION) && entry.command.includes(prompt)
  );
}

function findProcess(pid) {
  return processTable().find((entry) => entry.pid === pid);
}

function groupMembers(pgid) {
  return processTable().filter((entry) => entry.pgid === pgid);
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

function killGroup(pgid, signal = "SIGKILL") {
  try {
    process.kill(-pgid, signal);
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
  let lastValue;
  while (Date.now() - started < timeoutMs) {
    lastValue = predicate();
    if (lastValue) return lastValue;
    await delay(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForClose(child, options = {}) {
  const timeoutMs = options.timeoutMs ?? 7000;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      killPid(child.pid);
      reject(new Error(`timed out waiting for adapter ${child.pid} to close`));
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

function spawnAdapter(options = {}) {
  const repo = makeRepo();
  const scratch = mkdtempSync(path.join(tmpdir(), "claude-adv-signal-run-"));
  const mockPidFile = path.join(scratch, "mock.pid");
  const env = {
    ...process.env,
    ANTHROPIC_API_KEY: "",
    CODEX_HOME: makeCodexHome(),
    CODEX_THREAD_ID: "signal-thread",
    MOCK_CLAUDE_PID_FILE: mockPidFile,
    MOCK_CLAUDE_SCRIPT: mockScript(),
    MOCK_CLAUDE_SLEEP_SECONDS: "60",
    PATH: makeToolPath(),
    ...options.env,
  };
  const child = spawn(
    process.execPath,
    [ADAPTER, "task", "--cwd", repo, options.prompt ?? "signal test"],
    {
      cwd: ROOT,
      env,
      stdio: "ignore",
    }
  );
  return { child, mockPidFile, repo };
}

async function observeRunningAdapter(run) {
  const companion = await waitFor(
    () => findCompanionChild(run.child.pid),
    "delegated companion child"
  );
  const mockPid = await waitFor(() => readPidFile(run.mockPidFile), "mock claude pid");
  const mock = await waitFor(() => findProcess(mockPid), "mock claude process");
  return { companion, mock, mockPid };
}

async function cleanupRun(run, observed) {
  if (observed?.companion?.pgid) {
    killGroup(observed.companion.pgid);
  }
  const mockPid = observed?.mockPid ?? readPidFile(run.mockPidFile);
  if (mockPid) {
    killPid(mockPid);
  }
  if (run.child?.pid && processExists(run.child.pid)) {
    killPid(run.child.pid);
  }
  await Promise.race([waitForClose(run.child, { timeoutMs: 1000 }).catch(() => null), delay(1000)]);
}

posixTest("codex adapter spawns delegated runtime as its own process group leader", async () => {
  const run = spawnAdapter();
  let observed;
  try {
    observed = await observeRunningAdapter(run);

    assert.equal(observed.companion.pgid, observed.companion.pid);
    assert.equal(observed.mock.pgid, observed.companion.pid);
  } finally {
    await cleanupRun(run, observed);
  }
});

posixTest("adapter SIGTERM forwards SIGTERM to the delegated process group", async () => {
  const run = spawnAdapter();
  let observed;
  try {
    observed = await observeRunningAdapter(run);
    process.kill(run.child.pid, "SIGTERM");

    const result = await waitForClose(run.child, { timeoutMs: 4000 });
    assert.deepEqual(result, { code: SIGNAL_CODES.SIGTERM, signal: null });
    await waitFor(() => !processExists(observed.mockPid), "mock claude to exit");
    assert.deepEqual(groupMembers(observed.companion.pgid), []);
  } finally {
    await cleanupRun(run, observed);
  }
});

posixTest("adapter SIGINT exits 130 when the child is killed by SIGINT", async () => {
  const run = spawnAdapter();
  let observed;
  try {
    observed = await observeRunningAdapter(run);
    process.kill(run.child.pid, "SIGINT");

    const result = await waitForClose(run.child, { timeoutMs: 4000 });
    assert.deepEqual(result, { code: SIGNAL_CODES.SIGINT, signal: null });
    await waitFor(() => !processExists(observed.mockPid), "mock claude to exit");
  } finally {
    await cleanupRun(run, observed);
  }
});

posixTest("adapter SIGHUP forwards SIGHUP and exits 129 before escalation", async () => {
  const run = spawnAdapter();
  let observed;
  try {
    observed = await observeRunningAdapter(run);
    process.kill(run.child.pid, "SIGHUP");

    const result = await waitForClose(run.child, { timeoutMs: 4000 });
    assert.deepEqual(result, { code: SIGNAL_CODES.SIGHUP, signal: null });
    await waitFor(() => !processExists(observed.mockPid), "mock claude to exit");
  } finally {
    await cleanupRun(run, observed);
  }
});

posixTest("adapter signal path probes a child pid before the spawn event", () => {
  const source = readFileSync(ADAPTER, "utf8");

  assert.match(source, /childState\s*=\s*\{\s*child:\s*null,\s*childSpawned:\s*false/s);
  assert.match(source, /childState\.child\s*=\s*child/);
  assert.match(source, /child\.on\("spawn",\s*\(\)\s*=>\s*\{[\s\S]*childSpawned\s*=\s*true/s);
  assert.match(source, /process\.kill\(child\.pid,\s*0\)/);
  assert.match(source, /process\.kill\(-child\.pid,\s*signal\)/);
});

posixTest(
  "mock claude that ignores SIGTERM is killed by SIGKILL after escalation",
  { timeout: 10_000 },
  async () => {
    const run = spawnAdapter({
      env: {
        MOCK_CLAUDE_IGNORE_SIGTERM: "1",
      },
    });
    let observed;
    try {
      observed = await observeRunningAdapter(run);
      const started = Date.now();
      process.kill(run.child.pid, "SIGTERM");

      const result = await waitForClose(run.child, { timeoutMs: 8000 });
      assert.equal(result.code, 137);
      assert.equal(result.signal, null);
      assert.ok(Date.now() - started >= 5000, "expected 5s escalation delay before SIGKILL");
      await waitFor(() => !processExists(observed.mockPid), "mock claude to be SIGKILLed");
      assert.deepEqual(groupMembers(observed.companion.pgid), []);
    } finally {
      await cleanupRun(run, observed);
    }
  }
);

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  posixTest(`early ${signal} within 10ms leaves no adapter descendants`, async () => {
    const prompt = `early ${signal}`;
    const run = spawnAdapter({ prompt });
    let observed;
    try {
      setTimeout(() => {
        if (processExists(run.child.pid)) {
          process.kill(run.child.pid, signal);
        }
      }, 10);

      const result = await waitForClose(run.child, { timeoutMs: 8000 });
      if (result.signal) {
        assert.equal(result.signal, signal);
      } else {
        assert.equal(result.code, SIGNAL_CODES[signal]);
      }

      const companion = findCompanionChild(run.child.pid) ?? companionProcessesForPrompt(prompt)[0];
      if (companion) observed = { companion };
      await delay(100);
      assert.deepEqual(
        processTable().filter((entry) => entry.ppid === run.child.pid),
        []
      );
      assert.deepEqual(companionProcessesForPrompt(prompt), []);
      const mockPid = readPidFile(run.mockPidFile);
      if (mockPid) assert.equal(processExists(mockPid), false);
      if (observed?.companion?.pgid) {
        assert.deepEqual(groupMembers(observed.companion.pgid), []);
      }
    } finally {
      await cleanupRun(run, observed);
    }
  });
}
