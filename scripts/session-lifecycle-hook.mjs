#!/usr/bin/env node
// scripts/session-lifecycle-hook.mjs — handles SessionStart and SessionEnd
// hook events. Called with one argv: "SessionStart" or "SessionEnd".

import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import process from "node:process";

import { connectAndRequest } from "./lib/worker-ipc.mjs";
import { getConfig } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { computeDigest } from "./lib/digest.mjs";
import { getProcessStartTime } from "./lib/process.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");

function sessionDir(sessionId) {
  return path.join(
    process.env.HOME ?? "/tmp",
    ".claude",
    "state",
    "claude-adv",
    "sessions",
    sessionId
  );
}

function readWorkerJson(sessionId) {
  const p = path.join(sessionDir(sessionId), "worker.json");
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

async function handleSessionStart() {
  // Read input from stdin if Claude Code provides session-id via env or stdin.
  const sessionId =
    process.env.CLAUDE_SESSION_ID ?? readSessionIdFromStdin() ?? `manual-${Date.now()}`;
  const workspaceRoot = resolveWorkspaceRoot(process.cwd());
  const config = getConfig(workspaceRoot);

  // Only start the worker if stop-time review gate is enabled.
  if (!config.stopReviewGate) return;

  mkdirSync(sessionDir(sessionId), { recursive: true });

  // Initialize last-reviewed.json from the
  // current digest with verdict="unset" so the first Stop hook sees a no-op
  // delta and skips the LLM call for pre-existing state.
  try {
    const initial = computeDigest(process.cwd());
    const lastReviewedPath = path.join(sessionDir(sessionId), "last-reviewed.json");
    if (!existsSync(lastReviewedPath)) {
      writeFileSync(
        lastReviewedPath,
        JSON.stringify(
          {
            digest: initial.digest,
            head: initial.head,
            indexTree: initial.indexTree,
            reviewedAt: new Date().toISOString(),
            verdict: "unset",
          },
          null,
          2
        )
      );
    }
  } catch (err) {
    // Don't block session start if digest fails — the hook will fail-open.
    process.stderr.write(`session-lifecycle-hook: initial digest failed: ${err.message}\n`);
  }

  // If a worker is already running for this session, do nothing more.
  const existing = readWorkerJson(sessionId);
  if (existing && (await isWorkerAlive(existing))) return;

  const workerScript = path.join(ROOT, "scripts/claude-adv-worker.mjs");
  const child = spawn(
    process.execPath,
    [workerScript, "--session-id", sessionId, "--workspace-root", workspaceRoot],
    { detached: true, stdio: "ignore" }
  );
  child.unref();
}

async function isWorkerAlive(workerJson) {
  // Channel 1: socket ping with nonce match.
  try {
    const resp = await connectAndRequest(
      workerJson.sockPath,
      { id: "alive", type: "ping", nonce: workerJson.nonce },
      { timeoutMs: 1000 }
    );
    if (resp.ok && resp.nonce === workerJson.nonce) return true;
  } catch {
    /* fall through */
  }
  return false;
}

async function handleSessionEnd() {
  const sessionId = process.env.CLAUDE_SESSION_ID ?? readSessionIdFromStdin();
  if (!sessionId) return;
  const wj = readWorkerJson(sessionId);
  if (!wj) return;

  let authenticated = false;

  // Channel 1: socket ping.
  try {
    const resp = await connectAndRequest(
      wj.sockPath,
      { id: "auth", type: "ping", nonce: wj.nonce },
      { timeoutMs: 1000 }
    );
    if (resp.ok && resp.nonce === wj.nonce) {
      authenticated = true;
      // Send shutdown.
      try {
        await connectAndRequest(
          wj.sockPath,
          { id: "shut", type: "shutdown", nonce: wj.nonce },
          { timeoutMs: 5000 }
        );
        return;
      } catch {
        /* fall through to group-kill */
      }
    }
  } catch {
    /* fall through */
  }

  // Channel 2: OS-level start-time check.
  if (!authenticated) {
    const currentStart = getProcessStartTime(wj.pid);
    if (currentStart && currentStart === wj.processStartTime) {
      authenticated = true;
    }
  }

  if (!authenticated) {
    // Both channels failed: worker is dead or PID has been reused.
    // Do NOT kill.
    try {
      unlinkSync(path.join(sessionDir(sessionId), "worker.json"));
    } catch {
      /* */
    }
    try {
      unlinkSync(wj.sockPath);
    } catch {
      /* */
    }
    return;
  }

  // Authenticated kill of the process group.
  try {
    process.kill(-wj.pgid, "SIGTERM");
  } catch {
    /* */
  }
  await new Promise((r) => setTimeout(r, 2000));
  try {
    process.kill(-wj.pgid, "SIGKILL");
  } catch {
    /* */
  }
  try {
    unlinkSync(path.join(sessionDir(sessionId), "worker.json"));
  } catch {
    /* */
  }
  try {
    unlinkSync(wj.sockPath);
  } catch {
    /* */
  }
}

function readSessionIdFromStdin() {
  // Claude Code may pipe JSON to hook stdin including session id.
  // For now, fall back to env var; stdin parsing can be added if needed.
  return null;
}

const event = process.argv[2];
if (event === "SessionStart") {
  await handleSessionStart();
} else if (event === "SessionEnd") {
  await handleSessionEnd();
} else {
  process.stderr.write(`session-lifecycle-hook: unknown event '${event}'\n`);
  process.exit(1);
}
