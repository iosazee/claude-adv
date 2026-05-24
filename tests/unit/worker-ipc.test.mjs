// tests/unit/worker-ipc.test.mjs
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer, connectAndRequest } from "../../scripts/lib/worker-ipc.mjs";

test("worker-ipc: ping/response round-trip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-adv-ipc-"));
  const sock = join(dir, "test.sock");
  const server = await createServer(sock, async (msg) => {
    if (msg.type === "ping") {
      return {
        ok: true,
        workerPid: 12345,
        claudePid: null,
        nonce: "abc123",
        uptimeMs: 1000,
        budgetUsedUsd: 0,
      };
    }
    return { ok: false, code: "unknown" };
  });
  try {
    const resp = await connectAndRequest(sock, { id: "r1", type: "ping" }, { timeoutMs: 1000 });
    assert.equal(resp.id, "r1");
    assert.equal(resp.ok, true);
    assert.equal(resp.nonce, "abc123");
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker-ipc: server returns error shape", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-adv-ipc-"));
  const sock = join(dir, "err.sock");
  const server = await createServer(sock, async () => ({
    ok: false,
    code: "busy",
    detail: "another review in flight",
  }));
  try {
    const resp = await connectAndRequest(sock, { id: "r2", type: "review" }, { timeoutMs: 1000 });
    assert.equal(resp.ok, false);
    assert.equal(resp.code, "busy");
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker-ipc: connect to missing socket returns null/throws", async () => {
  const sock = join(tmpdir(), "claude-adv-nonexistent.sock");
  let threw = false;
  try {
    await connectAndRequest(sock, { id: "x", type: "ping" }, { timeoutMs: 500 });
  } catch {
    threw = true;
  }
  assert.equal(threw, true);
});

test("worker-ipc: timeout when server doesn't respond", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-adv-ipc-"));
  const sock = join(dir, "hang.sock");
  const server = await createServer(sock, () => new Promise(() => {})); // never resolves
  try {
    let threw = false;
    try {
      await connectAndRequest(sock, { id: "r3", type: "ping" }, { timeoutMs: 200 });
    } catch (e) {
      threw = /timeout/i.test(e.message);
    }
    assert.equal(threw, true);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
