// tests/unit/worker.test.mjs
// NOTE: HOME is rooted under /tmp rather than tmpdir() because the worker's
// socket path ${HOME}/.claude/state/claude-adv/sessions/<id>/worker.sock can
// exceed macOS's 104-byte sun_path limit when tmpdir resolves to
// /var/folders/... The worker falls back to a short /tmp/cadv-*.sock path
// when the canonical socket path would exceed that limit.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { setConfig } from "../../scripts/lib/state.mjs";
import { connectAndRequest } from "../../scripts/lib/worker-ipc.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const WORKER = path.join(ROOT, "scripts/claude-adv-worker.mjs");
const MOCK = path.join(ROOT, "tests/fixtures/mock-claude.sh");

function makeMockBinDir() {
  const dir = mkdtempSync(join(tmpdir(), "claude-adv-bin-"));
  execSync(`ln -sf '${MOCK}' '${dir}/claude'`);
  return dir;
}

async function startWorker(sessionId, mockBinDir, mockScript, options = {}) {
  const home = options.home ?? mkdtempSync("/tmp/cw-");
  options.configureState?.(home);
  const env = {
    ...process.env,
    PATH: `${mockBinDir}:${process.env.PATH}`,
    ...(mockScript ? { MOCK_CLAUDE_SCRIPT: mockScript } : {}),
    ...(options.env ?? {}),
    HOME: home,
  };
  const worker = spawn(
    process.execPath,
    [WORKER, "--session-id", sessionId, "--workspace-root", env.HOME],
    { env, stdio: "inherit", detached: false }
  );
  // Wait for worker.json to appear.
  const wjPath = join(env.HOME, ".claude/state/claude-adv/sessions", sessionId, "worker.json");
  for (let i = 0; i < 50; i++) {
    try {
      const wj = JSON.parse(readFileSync(wjPath, "utf8"));
      return { worker, env, wj, wjPath };
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  worker.kill();
  throw new Error("worker did not write worker.json within 2.5s");
}

function request(wj, message, opts = {}) {
  return connectAndRequest(wj.sockPath, { ...message, nonce: wj.nonce }, opts);
}

test("worker: rejects requests that do not include the stored nonce", async () => {
  const mockDir = makeMockBinDir();
  const { worker, wj } = await startWorker(
    "sess-auth",
    mockDir,
    JSON.stringify({ events: [], exitCode: 0 })
  );
  try {
    const unauthPing = await connectAndRequest(
      wj.sockPath,
      { id: "bad-ping", type: "ping" },
      { timeoutMs: 2000 }
    );
    assert.equal(unauthPing.ok, false);
    assert.equal(unauthPing.code, "unauthorized");

    const unauthReview = await connectAndRequest(
      wj.sockPath,
      { id: "bad-review", type: "review", diff: "x" },
      { timeoutMs: 2000 }
    );
    assert.equal(unauthReview.ok, false);
    assert.equal(unauthReview.code, "unauthorized");

    const unauthShutdown = await connectAndRequest(
      wj.sockPath,
      { id: "bad-shutdown", type: "shutdown" },
      { timeoutMs: 2000 }
    );
    assert.equal(unauthShutdown.ok, false);
    assert.equal(unauthShutdown.code, "unauthorized");

    const authPing = await request(wj, { id: "good-ping", type: "ping" }, { timeoutMs: 2000 });
    assert.equal(authPing.ok, true);
  } finally {
    await request(wj, { id: "s-auth", type: "shutdown" }, { timeoutMs: 2000 }).catch(() => {});
    worker.kill();
  }
});

test("worker: ping returns the stored nonce", async () => {
  const mockDir = makeMockBinDir();
  const { worker, wj, wjPath } = await startWorker(
    "sess-1",
    mockDir,
    JSON.stringify({ events: [], exitCode: 0 })
  );
  try {
    assert.equal(statSync(wjPath).mode & 0o777, 0o600);
    const resp = await request(wj, { id: "p1", type: "ping" }, { timeoutMs: 2000 });
    assert.equal(resp.ok, true);
    assert.equal(resp.nonce, wj.nonce);
    assert.equal(resp.workerPid, wj.pid);
  } finally {
    await request(wj, { id: "s1", type: "shutdown" }, { timeoutMs: 2000 }).catch(() => {});
    worker.kill();
  }
});

test("worker: review request returns schema verdict from mock claude", async () => {
  const mockDir = makeMockBinDir();
  const mockScript = JSON.stringify({
    events: [
      { type: "system", subtype: "init", session_id: "mock" },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                verdict: "approve",
                summary: "all good",
                findings: [],
                next_steps: [],
              }),
            },
          ],
        },
      },
      { type: "result", subtype: "success", total_cost_usd: 0.01 },
    ],
    exitCode: 0,
  });
  const { worker, wj } = await startWorker("sess-2", mockDir, mockScript);
  try {
    const resp = await request(
      wj,
      {
        id: "r1",
        type: "review",
        target: "previous-turn",
        diff: "x",
      },
      { timeoutMs: 5000 }
    );
    assert.equal(resp.ok, true);
    assert.equal(resp.review.verdict, "approve");
  } finally {
    await request(wj, { id: "s2", type: "shutdown" }, { timeoutMs: 2000 }).catch(() => {});
    worker.kill();
  }
});

test("worker: concurrent review requests — second receives code='busy'", async () => {
  // Mock claude that hangs so the first request stays in flight. `exec sleep`
  // replaces the shell with sleep so SIGTERM kills sleep directly — no
  // shell-trap propagation issues, no orphaned `cat` holding stdout open.
  const hangBin = mkdtempSync(join(tmpdir(), "claude-adv-busy-"));
  writeFileSync(join(hangBin, "claude"), "#!/bin/sh\nexec sleep 30\n");
  execSync(`chmod +x '${hangBin}/claude'`);
  const env = {
    ...process.env,
    PATH: `${hangBin}:${process.env.PATH}`,
    HOME: mkdtempSync("/tmp/cw-"),
  };
  const worker = spawn(
    process.execPath,
    [WORKER, "--session-id", "sess-busy", "--workspace-root", env.HOME],
    { env, stdio: "inherit" }
  );
  const wjPath = join(env.HOME, ".claude/state/claude-adv/sessions/sess-busy/worker.json");
  for (let i = 0; i < 50; i++) {
    try {
      JSON.parse(readFileSync(wjPath, "utf8"));
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const wj = JSON.parse(readFileSync(wjPath, "utf8"));
  try {
    // Fire two reviews concurrently. The first should stay in flight; the
    // second must return code="busy" promptly.
    const first = request(
      wj,
      { id: "first", type: "review", diff: "x" },
      { timeoutMs: 30000 }
    ).catch((e) => ({ error: e.message }));
    await new Promise((r) => setTimeout(r, 300)); // ensure first claims slot
    const second = await request(
      wj,
      { id: "second", type: "review", diff: "y" },
      { timeoutMs: 5000 }
    );
    assert.equal(second.ok, false);
    assert.equal(second.code, "busy");
    // Clean up the hanging first request via interrupt then shutdown.
    await request(wj, { id: "int", type: "interrupt" }, { timeoutMs: 2000 });
    await first;
  } finally {
    await request(wj, { id: "s", type: "shutdown" }, { timeoutMs: 2000 }).catch(() => {});
    worker.kill();
  }
});

test("worker: cumulative budget — next review after near-cap returns budget-exceeded", async () => {
  const mockDir = makeMockBinDir();
  const mockScript = JSON.stringify({
    events: [
      { type: "system", subtype: "init", session_id: "mock" },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                verdict: "approve",
                summary: "all good",
                findings: [],
                next_steps: [],
              }),
            },
          ],
        },
      },
      { type: "result", subtype: "success", total_cost_usd: 2 },
    ],
    exitCode: 0,
  });
  const { worker, wj } = await startWorker("sess-budget", mockDir, mockScript, {
    configureState(home) {
      setConfig(home, "maxBudgetUsd", 1);
      setConfig(home, "workerBudgetMultiplier", 2);
    },
  });
  try {
    const first = await request(
      wj,
      { id: "budget-1", type: "review", target: "previous-turn", diff: "x" },
      { timeoutMs: 5000 }
    );
    assert.equal(first.ok, true);
    assert.equal(first.costUsd, 2);

    const ping = await request(wj, { id: "budget-ping", type: "ping" }, { timeoutMs: 2000 });
    assert.equal(ping.budgetUsedUsd, 2);
    assert.equal(ping.sessionBudgetUsd, 2);

    const second = await request(
      wj,
      { id: "budget-2", type: "review", target: "previous-turn", diff: "y" },
      { timeoutMs: 5000 }
    );
    assert.equal(second.ok, false);
    assert.equal(second.code, "budget-exceeded");
  } finally {
    await request(wj, { id: "s-budget", type: "shutdown" }, { timeoutMs: 2000 }).catch(() => {});
    worker.kill();
  }
});

test("worker: interrupt during in-flight review actually kills the subprocess", async () => {
  // A mock script that emits init then sleeps to simulate a slow review.
  // `exec sleep` replaces the shell so SIGTERM from the worker hits sleep
  // directly (no shell-trap propagation issues, no orphaned process holding
  // stdout open after the kill).
  const hangBin = mkdtempSync(join(tmpdir(), "claude-adv-hang-"));
  writeFileSync(
    join(hangBin, "claude"),
    "#!/bin/sh\n" + 'echo \'{"type":"system","subtype":"init"}\'\n' + "exec sleep 60\n"
  );
  execSync(`chmod +x '${hangBin}/claude'`);

  const env = {
    ...process.env,
    PATH: `${hangBin}:${process.env.PATH}`,
    HOME: mkdtempSync("/tmp/cw-"),
  };
  const worker = spawn(
    process.execPath,
    [WORKER, "--session-id", "sess-interrupt", "--workspace-root", env.HOME],
    { env, stdio: "inherit" }
  );
  const wjPath = join(env.HOME, ".claude/state/claude-adv/sessions/sess-interrupt/worker.json");
  for (let i = 0; i < 50; i++) {
    try {
      JSON.parse(readFileSync(wjPath, "utf8"));
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const wj = JSON.parse(readFileSync(wjPath, "utf8"));

  // Fire a review request without awaiting; it will hang on the mock sleep.
  const reviewPromise = request(
    wj,
    {
      id: "r-hang",
      type: "review",
      diff: "x",
    },
    { timeoutMs: 30000 }
  ).catch((e) => ({ error: e.message }));

  // Give the subprocess a moment to spawn.
  await new Promise((r) => setTimeout(r, 500));

  // Send interrupt.
  const interruptResp = await request(wj, { id: "int", type: "interrupt" }, { timeoutMs: 5000 });
  assert.equal(interruptResp.ok, true);
  assert.equal(interruptResp.restarted, true);

  // The review request should now resolve with an error (subprocess killed).
  const reviewResult = await reviewPromise;
  assert.ok(
    reviewResult.error || reviewResult.ok === false,
    `review should have failed after interrupt: ${JSON.stringify(reviewResult)}`
  );

  // Shutdown.
  await request(wj, { id: "s", type: "shutdown" }, { timeoutMs: 2000 }).catch(() => {});
  worker.kill();
});

test("worker: shutdown response then process exits", async () => {
  const mockDir = makeMockBinDir();
  const { worker, wj } = await startWorker(
    "sess-3",
    mockDir,
    JSON.stringify({ events: [], exitCode: 0 })
  );
  const resp = await request(wj, { id: "s", type: "shutdown" }, { timeoutMs: 2000 });
  assert.equal(resp.ok, true);
  const exitCode = await new Promise((r) => worker.once("close", r));
  assert.equal(exitCode, 0);
});

test("worker: shutdown kills the in-flight review child", async () => {
  // Mock writes its own PID then sleeps, so the test can observe whether the
  // child survives the worker's exit. The worker's shutdown handler must
  // SIGTERM the in-flight child; without that, the reparented child keeps
  // running after the worker exits.
  const pidFile = join(mkdtempSync("/tmp/cw-pid-"), "child.pid");
  const hangBin = mkdtempSync(join(tmpdir(), "claude-adv-shutdown-"));
  writeFileSync(
    join(hangBin, "claude"),
    "#!/bin/sh\n" +
      'printf "%s\\n" "$$" > "' +
      pidFile +
      '"\n' +
      'echo \'{"type":"system","subtype":"init"}\'\n' +
      "exec sleep 60\n"
  );
  execSync(`chmod +x '${hangBin}/claude'`);

  const env = {
    ...process.env,
    PATH: `${hangBin}:${process.env.PATH}`,
    HOME: mkdtempSync("/tmp/cw-"),
  };
  const worker = spawn(
    process.execPath,
    [WORKER, "--session-id", "sess-shutdown-kill", "--workspace-root", env.HOME],
    { env, stdio: "inherit" }
  );
  const wjPath = join(env.HOME, ".claude/state/claude-adv/sessions/sess-shutdown-kill/worker.json");
  for (let i = 0; i < 50; i++) {
    try {
      JSON.parse(readFileSync(wjPath, "utf8"));
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const wj = JSON.parse(readFileSync(wjPath, "utf8"));

  // Fire a review that will hang in the mock sleep.
  const reviewPromise = request(
    wj,
    { id: "r-hang", type: "review", diff: "x" },
    { timeoutMs: 30000 }
  ).catch((e) => ({ error: e.message }));

  // Wait for the child to record its PID.
  let childPid;
  for (let i = 0; i < 60; i++) {
    try {
      childPid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
      if (childPid) break;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(childPid, "mock child should have written its PID");

  // Shutdown while the review is in flight.
  await request(wj, { id: "s", type: "shutdown" }, { timeoutMs: 2000 });
  await new Promise((r) => worker.once("close", r));
  await reviewPromise;

  // Give the SIGTERM a moment to land, then confirm the child is gone.
  await new Promise((r) => setTimeout(r, 500));
  let alive = true;
  try {
    process.kill(childPid, 0);
  } catch {
    alive = false;
  }
  assert.equal(
    alive,
    false,
    `in-flight review child (pid ${childPid}) should be dead after shutdown`
  );
  worker.kill();
});

test("worker: interrupted review still debits a cost it emitted", async () => {
  // Mock emits init + a result event carrying a cost, THEN sleeps. The worker
  // interrupts (SIGTERM) it after the cost line is on the wire; spawnAndCollect
  // resolves on the child's death having already parsed the cost. The budget
  // debit must happen regardless of the interrupt — verified via ping's
  // budgetUsedUsd afterward.
  const hangBin = mkdtempSync(join(tmpdir(), "claude-adv-m1-"));
  writeFileSync(
    join(hangBin, "claude"),
    "#!/bin/sh\n" +
      'echo \'{"type":"system","subtype":"init"}\'\n' +
      'echo \'{"type":"result","subtype":"success","total_cost_usd":0.5}\'\n' +
      "exec sleep 60\n"
  );
  execSync(`chmod +x '${hangBin}/claude'`);

  const env = {
    ...process.env,
    PATH: `${hangBin}:${process.env.PATH}`,
    HOME: mkdtempSync("/tmp/cw-"),
  };
  const worker = spawn(
    process.execPath,
    [WORKER, "--session-id", "sess-m1", "--workspace-root", env.HOME],
    { env, stdio: "inherit" }
  );
  const wjPath = join(env.HOME, ".claude/state/claude-adv/sessions/sess-m1/worker.json");
  for (let i = 0; i < 50; i++) {
    try {
      JSON.parse(readFileSync(wjPath, "utf8"));
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const wj = JSON.parse(readFileSync(wjPath, "utf8"));

  const reviewPromise = request(
    wj,
    { id: "r-m1", type: "review", diff: "x" },
    { timeoutMs: 30000 }
  ).catch((e) => ({ error: e.message }));

  // Let the cost line flush, then interrupt.
  await new Promise((r) => setTimeout(r, 500));
  await request(wj, { id: "int", type: "interrupt" }, { timeoutMs: 5000 });
  const reviewResult = await reviewPromise;
  assert.equal(reviewResult.ok, false);
  assert.equal(reviewResult.code, "interrupted");

  // Budget must reflect the emitted cost even though the review was interrupted.
  const ping = await request(wj, { id: "p", type: "ping" }, { timeoutMs: 2000 });
  assert.equal(ping.ok, true);
  assert.ok(
    ping.budgetUsedUsd >= 0.5,
    `interrupted review must still debit its emitted cost; got budgetUsedUsd=${ping.budgetUsedUsd}`
  );

  await request(wj, { id: "s", type: "shutdown" }, { timeoutMs: 2000 }).catch(() => {});
  worker.kill();
});

test("worker: sun_path fallback — long HOME produces a /tmp/cadv-* sockPath", async () => {
  // Force a HOME long enough that the canonical sockPath would exceed the
  // 100-byte threshold. The worker should fall back to a socket inside a
  // private /tmp/cadv-* directory.
  const longHome = mkdtempSync("/tmp/cw-long-" + "x".repeat(50) + "-");
  const env = {
    ...process.env,
    PATH: `${makeMockBinDir()}:${process.env.PATH}`,
    MOCK_CLAUDE_SCRIPT: JSON.stringify({ events: [], exitCode: 0 }),
    HOME: longHome,
  };
  const worker = spawn(
    process.execPath,
    [WORKER, "--session-id", "sess-long", "--workspace-root", longHome],
    { env, stdio: "inherit" }
  );
  const wjPath = join(longHome, ".claude/state/claude-adv/sessions/sess-long/worker.json");
  for (let i = 0; i < 50; i++) {
    try {
      JSON.parse(readFileSync(wjPath, "utf8"));
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const wj = JSON.parse(readFileSync(wjPath, "utf8"));
  try {
    assert.match(
      wj.sockPath,
      /^\/tmp\/cadv-[^/]+\/worker\.sock$/,
      `expected /tmp/cadv-*/worker.sock fallback, got ${wj.sockPath}`
    );
    assert.equal(path.basename(wj.sockPath), "worker.sock");
    assert.equal(statSync(path.dirname(wj.sockPath)).mode & 0o777, 0o700);
    // Verify the fallback socket actually works.
    const resp = await request(wj, { id: "p", type: "ping" }, { timeoutMs: 2000 });
    assert.equal(resp.ok, true);
    assert.equal(resp.nonce, wj.nonce);
  } finally {
    await request(wj, { id: "s", type: "shutdown" }, { timeoutMs: 2000 }).catch(() => {});
    worker.kill();
  }
});
