#!/usr/bin/env node
// scripts/claude-adv-worker.mjs — Node supervisor for the stop-gate hook.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import process from "node:process";

import { createServer } from "./lib/worker-ipc.mjs";
import { buildReviewerArgs, detectReviewerAuthClass, spawnAndCollect } from "./lib/claude-cli.mjs";
import { getConfig } from "./lib/state.mjs";
import { getProcessStartTime } from "./lib/process.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");

async function main() {
  const { sessionId, workspaceRoot } = parseWorkerArgv(process.argv.slice(2));

  // Detach into its own process group.
  try {
    process.setsid?.();
  } catch {
    /* setsid not always available */
  }

  const sessionDir = path.join(
    process.env.HOME ?? "/tmp",
    ".claude",
    "state",
    "claude-adv",
    "sessions",
    sessionId
  );
  mkdirSync(sessionDir, { recursive: true });
  const canonicalSockPath = path.join(sessionDir, "worker.sock");
  // AF_UNIX sun_path is 104 bytes on macOS, 108 on Linux. Long $HOME paths
  // (e.g. tmpdir-mkdtempd test homes under /var/folders/...) blow the limit
  // and net.createServer fails with EINVAL. Fall back to a short /tmp path
  // when the canonical path is too long. Clients read sockPath from
  // worker.json, so the actual bind location propagates automatically.
  //
  // The fallback lives inside a per-worker mkdtemp dir (mode 0700) rather than
  // a bare /tmp/cadv-*.sock: on a shared host /tmp is world-traversable and a
  // bound Unix socket honors umask (0755 → connectable by any local user). A
  // 0700 parent dir denies other users traversal entirely, so only same-UID
  // processes can reach the socket — matching the protection the canonical
  // ~/.claude path already gets from home-dir perms. We hardcode /tmp (not
  // os.tmpdir()) because on macOS tmpdir() resolves to /var/folders/... which
  // would re-blow the sun_path limit we're trying to escape.
  let fallbackSockDir = null;
  let sockPath;
  if (canonicalSockPath.length <= 100) {
    sockPath = canonicalSockPath;
  } else {
    fallbackSockDir = mkdtempSync(path.join("/tmp", "cadv-"));
    sockPath = path.join(fallbackSockDir, "worker.sock");
  }
  const workerJsonPath = path.join(sessionDir, "worker.json");
  const logPath = path.join(sessionDir, "worker.log");

  const nonce = randomBytes(16).toString("hex");
  const pid = process.pid;
  const pgid = (() => {
    try {
      return process.getpgid?.(pid) ?? pid;
    } catch {
      return pid;
    }
  })();
  const startedAtMs = Date.now();
  const processStartTime = getProcessStartTime(pid);

  // Track in-flight subprocess for interrupt.
  let inFlight = null;
  let budgetUsedUsd = 0;

  const config = getConfig(workspaceRoot);
  const perRequestBudget = config.maxBudgetUsd ?? 5;
  // Worker session cap = per-request × multiplier.
  const workerBudgetMultiplier = config.workerBudgetMultiplier ?? 10;
  const sessionBudgetUsd = perRequestBudget * workerBudgetMultiplier;
  // Interruption state lives on inFlight (per-request), NOT as a worker-global,
  // so overlapping requests cannot cross-contaminate.

  const server = await createServer(sockPath, async (msg) => {
    // Authenticate EVERY request against the per-worker nonce. The nonce lives
    // in worker.json under the user's home dir; a legitimate client reads it
    // there (proving local filesystem access) before connecting. Without this
    // gate, any process that can reach the socket could drive the worker —
    // spending the user's API budget on an attacker-chosen diff, aborting an
    // in-flight review, or shutting the worker down. `ping` is gated too: it
    // returns the nonce, so leaving it open would let an unauthenticated peer
    // harvest the nonce and then authenticate everything else.
    if (msg.nonce !== nonce) {
      return { ok: false, code: "unauthorized", detail: "missing or invalid nonce" };
    }
    if (msg.type === "ping") {
      return {
        ok: true,
        workerPid: pid,
        claudePid: inFlight?.child?.pid ?? null,
        nonce,
        uptimeMs: Date.now() - startedAtMs,
        budgetUsedUsd,
        sessionBudgetUsd,
      };
    }
    if (msg.type === "shutdown") {
      // Schedule async shutdown after this response is flushed.
      setImmediate(async () => {
        // Kill any in-flight review child before exiting, mirroring the
        // interrupt handler. Without this the child is reparented at exit and
        // runs to completion spending budget with no receiver. SIGTERM
        // first, SIGKILL after 2s if it ignores the term.
        if (inFlight?.child && !inFlight.child.killed) {
          const targetChild = inFlight.child;
          try {
            targetChild.kill("SIGTERM");
          } catch {
            /* already dead */
          }
          setTimeout(() => {
            if (!targetChild.killed) {
              try {
                targetChild.kill("SIGKILL");
              } catch {
                /* */
              }
            }
          }, 2000);
        }
        await server.close();
        // Remove the 0700 fallback dir (server.close only unlinks the socket
        // file inside it). Best-effort — process is exiting regardless.
        if (fallbackSockDir) {
          try {
            rmSync(fallbackSockDir, { recursive: true, force: true });
          } catch {
            /* best-effort */
          }
        }
        process.exit(0);
      });
      return { ok: true };
    }
    if (msg.type === "interrupt") {
      if (inFlight?.child && !inFlight.child.killed) {
        // Per-request `interrupted` flag (replaces former global to survive
        // overlapping requests). The pending review handler reads this off
        // its own inFlight reference, so concurrent requests cannot confuse
        // which review was actually cancelled.
        inFlight.interrupted = true;
        const targetChild = inFlight.child;
        try {
          targetChild.kill("SIGTERM");
        } catch {
          /* already dead */
        }
        setTimeout(() => {
          if (!targetChild.killed) {
            try {
              targetChild.kill("SIGKILL");
            } catch {
              /* */
            }
          }
        }, 2000);
      }
      return { ok: true, restarted: true };
    }
    if (msg.type === "review") {
      // Serialize review requests. If another review
      // is already in flight, return `busy`; the hook treats this as a
      // fallback trigger to a fresh subprocess.
      if (inFlight) {
        return { ok: false, code: "busy", detail: "worker is already processing a review" };
      }
      // Enforce the cumulative session budget. Pass
      // the SMALLER of perRequestBudget and remainingBudget to claude so
      // total spend never exceeds the session cap, even if a single review
      // would otherwise consume the full per-request budget.
      const remainingBudget = sessionBudgetUsd - budgetUsedUsd;
      if (remainingBudget <= 0) {
        return {
          ok: false,
          code: "budget-exceeded",
          detail: `worker session budget $${sessionBudgetUsd} exhausted (used $${budgetUsedUsd.toFixed(4)})`,
        };
      }
      const reviewBudgetUsd = Math.min(perRequestBudget, remainingBudget);
      // Per-request interruption flag lives on the inFlight record reserved
      // below; there is no module-level `interrupted` variable.
      // Build a FRESH session id per review — never reuse.
      const reviewSessionId = randomUUID();
      const { useBare } = detectReviewerAuthClass();
      const argv = buildReviewerArgs({
        promptFile: path.join(ROOT, "prompts", "adversarial-review.md"),
        budgetUsd: reviewBudgetUsd,
        sessionId: reviewSessionId,
        useBare,
      });
      const promptBody = buildPromptBody(msg);
      // Reserve the slot synchronously BEFORE the await, so a concurrent
      // request observes inFlight set and short-circuits with `busy` above.
      inFlight = { child: null, pid: null, startedAt: Date.now(), interrupted: false };
      const result = await spawnAndCollect(argv, promptBody, {
        onSpawn: (child) => {
          if (inFlight) {
            inFlight.child = child;
            inFlight.pid = child.pid;
          }
        },
      });
      const wasInterrupted = inFlight?.interrupted === true;
      inFlight = null;
      // Debit the session budget for whatever cost the inner claude reported,
      // BEFORE the interrupted early-return. An interrupted review can still
      // have emitted a `result` event with a cost; skipping the debit
      // there let interrupted reviews spend budget without being counted,
      // which could push cumulative spend over the session cap.
      if (typeof result.costUsd === "number") budgetUsedUsd += result.costUsd;
      if (wasInterrupted) {
        // Cancel semantics: interrupted reviews become soft ALLOW.
        // We surface a distinct code so the hook can emit the correct reason.
        return { ok: false, code: "interrupted", detail: "review was cancelled mid-flight" };
      }
      if (!result.ok) {
        return {
          ok: false,
          code: "inner-dead",
          detail: result.error ?? `claude exited ${result.exitCode}`,
        };
      }
      if (
        !result.review ||
        !["approve", "approve-with-notes", "needs-attention"].includes(result.review.verdict)
      ) {
        return { ok: false, code: "schema-fail", detail: "no valid verdict" };
      }
      return {
        ok: true,
        review: result.review,
        elapsedMs: 0, // Could track in future.
        tokensIn: null,
        tokensOut: null,
        costUsd: result.costUsd,
      };
    }
    return { ok: false, code: "unknown-type" };
  });

  // Write worker.json AFTER the IPC server is listening so peers that detect
  // the file can connect immediately without racing the bind.
  writeFileSync(
    workerJsonPath,
    JSON.stringify(
      {
        pid,
        pgid,
        sockPath,
        logPath,
        startedAt: new Date(startedAtMs).toISOString(),
        processStartTime,
        nonce,
        claudeSessionId: sessionId,
      },
      null,
      2
    ),
    // 0600: worker.json carries the IPC nonce. On a shared host the default
    // 0644 would let other users read the nonce (and the canonical path's
    // intermediate dirs may be world-traversable), defeating the auth gate.
    { mode: 0o600 }
  );
}

function parseWorkerArgv(argv) {
  // Expected: --session-id <claude-session-id> --workspace-root <path>
  let sessionId, workspaceRoot;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--session-id") sessionId = argv[++i];
    if (argv[i] === "--workspace-root") workspaceRoot = argv[++i];
  }
  if (!sessionId) throw new Error("claude-adv-worker: --session-id is required");
  return { sessionId, workspaceRoot: workspaceRoot ?? process.cwd() };
}

function buildPromptBody(msg) {
  return [
    `Target: ${msg.target ?? "previous-turn"}`,
    msg.summary ? `Summary: ${msg.summary}` : "",
    msg.focus ? `Focus: ${msg.focus}` : "",
    "",
    "Diff:",
    msg.diff ?? "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

main().catch((err) => {
  process.stderr.write(`worker-fatal: ${err.message}\n`);
  process.exit(1);
});
