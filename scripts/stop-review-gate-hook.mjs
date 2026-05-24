#!/usr/bin/env node
// scripts/stop-review-gate-hook.mjs — fires on Claude Code's Stop event.
// Implements the Stop-gate state machine.
// Fail-open semantics: any internal error → exit 0, no baseline
// update; only emit exit 2 when an LLM verdict explicitly says
// "needs-attention".

import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  lstatSync,
  readlinkSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";

import {
  computeDigest,
  isAncestor,
  lastReviewedIsUsable,
  getHeadTreeSha,
  worktreeAndIndexClean,
} from "./lib/digest.mjs";
import { connectAndRequest } from "./lib/worker-ipc.mjs";
import { buildReviewerArgs, detectReviewerAuthClass, spawnAndCollect } from "./lib/claude-cli.mjs";
import { getConfig } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");

// IPC timeout for the worker `review` request. Must comfortably exceed the
// longest budget-bounded review a real Opus reviewer can take. A 60s bound
// (the connectAndRequest default) routinely fires mid-review on real reviews,
// which made the hook abandon the worker's still-running review and spawn a
// SECOND fresh-subprocess review — a ~2x cost double-spend. The worker
// has no abort-on-disconnect, so the abandoned review kept debiting its
// session budget. 10 minutes is well above any budget-bounded review yet
// still preserves fail-open: if the worker truly hangs past this bound the
// hook throws and falls back to a fresh subprocess.
const REVIEW_IPC_TIMEOUT_MS = 600000;

function log(line) {
  // Best-effort log to worker.log. Never throw.
  const sessionId = process.env.CLAUDE_SESSION_ID;
  if (!sessionId) return;
  const logPath = path.join(
    process.env.HOME ?? "/tmp",
    ".claude/state/claude-adv/sessions",
    sessionId,
    "worker.log"
  );
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    writeFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`, { flag: "a" });
  } catch {
    /* ignore */
  }
}

function failOpen(reason) {
  log(`fail-open: ${reason}`);
  process.exit(0);
}

// A legitimate no-op allow: the gate ran cleanly and there is nothing to
// review. Same exit-0 behavior as failOpen but logged as a normal allow so it
// is not mistaken for an error/fail-open path during incident triage.
function cleanAllow(reason) {
  log(`clean allow: ${reason}`);
  process.exit(0);
}

function readLastReviewed(sessionId) {
  const p = path.join(
    process.env.HOME ?? "/tmp",
    ".claude/state/claude-adv/sessions",
    sessionId,
    "last-reviewed.json"
  );
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeLastReviewed(sessionId, data) {
  const dir = path.join(process.env.HOME ?? "/tmp", ".claude/state/claude-adv/sessions", sessionId);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "last-reviewed.json"), JSON.stringify(data, null, 2));
  } catch {
    /* fail open if we can't write */
  }
}

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

async function main() {
  const cwd = process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  // Step 1: feature toggle.
  if (!config.stopReviewGate) process.exit(0);

  const sessionId = process.env.CLAUDE_SESSION_ID ?? "no-session";
  if (sessionId === "no-session") failOpen("no CLAUDE_SESSION_ID in env");

  // Step 2: compute current digest.
  let current;
  try {
    current = computeDigest(cwd);
  } catch (err) {
    return failOpen(`computeDigest threw: ${err.message}`);
  }

  // Step 3: pre-filter — bail if digest unchanged.
  const lastReviewed = readLastReviewed(sessionId);
  if (lastReviewed?.digest === current.digest) process.exit(0);

  // Step 4: baseline validity.
  const usable = lastReviewedIsUsable(cwd, lastReviewed);
  let baselineMode; // "normal" | "4a" | "4aPrime" | "4b" | "4c"
  let collectionBaseline;

  if (!usable.usable || !isAncestor(cwd, lastReviewed.head, current.head)) {
    // Ancestry break (or no usable baseline).
    log(`ancestry break: ${usable.usable ? "non-ancestor" : usable.reason}`);

    if (worktreeAndIndexClean(cwd)) {
      // Path 4a or 4a' — check tree-content equality.
      const headTree = getHeadTreeSha(cwd);
      if (
        usable.usable &&
        lastReviewed.indexTree &&
        lastReviewed.indexTree !== "unmerged" &&
        headTree === lastReviewed.indexTree
      ) {
        // 4a: clean + identical tree → silent reset, no LLM.
        writeLastReviewed(sessionId, {
          digest: current.digest,
          head: current.head,
          indexTree: current.indexTree,
          reviewedAt: new Date().toISOString(),
          verdict: "reset-clean-identical-tree",
        });
        return cleanAllow("4a: clean, identical tree, silent reset");
      }
      // 4a': clean tree but content differs OR indexTree unusable.
      // Use last-reviewed.indexTree if usable, else fall through to 4c.
      if (usable.usable && lastReviewed.indexTree && lastReviewed.indexTree !== "unmerged") {
        // Re-verify indexTree readable.
        const exists = git(cwd, ["cat-file", "-e", lastReviewed.indexTree]);
        if (exists.status === 0) {
          baselineMode = "4aPrime";
          collectionBaseline = lastReviewed.indexTree;
        } else {
          baselineMode = "4c";
          collectionBaseline = null; // signal: use HEAD^ or empty tree
        }
      } else {
        baselineMode = "4c";
        collectionBaseline = null;
      }
    } else {
      // Path 4b: dirty tree. Ignore last-reviewed entirely.
      baselineMode = "4b";
      collectionBaseline = null;
    }
  } else {
    baselineMode = "normal";
    collectionBaseline = lastReviewed;
  }

  // Step 5: collect changeset.
  const payload = collectChangeset(cwd, baselineMode, collectionBaseline, current);
  if (payload._failOpenReason) {
    return failOpen(payload._failOpenReason);
  }

  // Steps 6-7: try worker IPC first, fall back to fresh subprocess on EVERY
  // worker failure mode (throw, ok:false with any code, or invalid response).
  // The failure-mode codes the worker can emit are
  //   busy, inner-dead, schema-fail, budget-exceeded, internal
  // — and every one of these MUST route through
  // fresh-subprocess fallback before fail-open semantics apply.
  let review;
  let workerThrew = false;
  try {
    review = await runReviewViaWorker(sessionId, payload, cwd);
  } catch (err) {
    workerThrew = true;
    log(`worker IPC threw: ${err.message}; falling back to fresh subprocess`);
  }
  if (workerThrew || (review && review.ok === false)) {
    // Cancel semantics: `interrupted` is NOT a transient failure;
    // it's an explicit user cancel that becomes a soft ALLOW. Do NOT fall
    // back — that would defeat the cancel.
    if (review && review.ok === false && review.code === "interrupted") {
      log("worker reported interrupted; emitting soft ALLOW (no fallback)");
      // Write a new digest baseline so the next Stop sees this state as
      // already reviewed. Failure to write is non-fatal.
      writeLastReviewed(sessionId, {
        digest: current.digest,
        head: current.head,
        indexTree: current.indexTree,
        reviewedAt: new Date().toISOString(),
        verdict: "interrupted-soft-allow",
      });
      process.stderr.write(
        "claude-adv stop-gate: review interrupted by user; allowing this turn\n"
      );
      process.exit(0);
    }
    if (!workerThrew) {
      log(`worker returned ok:false code=${review.code}; falling back to fresh subprocess`);
    }
    review = await runReviewViaFreshSubprocess(payload, config, cwd);
  }

  // Step 8: verdict mapping. Fail open on any non-success outcome (i.e.
  // when even the fresh-subprocess fallback fails). Both `approve` and
  // `approve-with-notes` pass the gate; only `needs-attention` blocks.
  if (
    !review ||
    review.ok === false ||
    !review.review ||
    !["approve", "approve-with-notes", "needs-attention"].includes(review.review.verdict)
  ) {
    return failOpen(
      `invalid review response after fallback: ${JSON.stringify(review).slice(0, 200)}`
    );
  }
  if (review.review.verdict === "approve" || review.review.verdict === "approve-with-notes") {
    // Step 9: write new baseline, exit 0. approve-with-notes passes the gate
    // because by construction all findings are ≤ medium severity AND
    // confidence ≤ 0.7 — a careful engineer would not block on them.
    writeLastReviewed(sessionId, {
      digest: current.digest,
      head: current.head,
      indexTree: current.indexTree,
      reviewedAt: new Date().toISOString(),
      verdict: review.review.verdict,
    });
    process.exit(0);
  }
  // needs-attention → exit 2 with stderr message.
  const f = (review.review.findings ?? [])[0];
  const msg = [
    `claude-adv stop-gate: needs-attention`,
    review.review.summary ?? "",
    f ? `Top finding: ${f.title} (${f.file}:${f.line_start}-${f.line_end})` : "",
    f?.recommendation ? `→ ${f.recommendation}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  process.stderr.write(msg + "\n");
  process.exit(2);
}

function collectChangeset(cwd, mode, baseline, current) {
  // Returns { committed, staged, unstaged, untracked, unmerged }.
  const out = { committed: "", staged: "", unstaged: "", untracked: [], unmerged: [] };

  // Detect unborn HEAD once so every mode falls back to the empty tree hash
  // rather than referring to a HEAD that doesn't exist. Compute the empty
  // tree at runtime via `git hash-object -t tree --stdin </dev/null` so the
  // value is correct for both SHA-1 and SHA-256 repos.
  const headIsUnborn = current.head === "unborn";
  // Compute repo's empty-tree object id at runtime (SHA-1/SHA-256 agnostic).
  // No silent SHA-1 fallback — if hash-object fails, surface a sentinel so
  // the caller can route this hook firing to failOpen instead of computing
  // a meaningless diff.
  function repoEmptyTreeOrNull() {
    const r = git(cwd, ["hash-object", "-t", "tree", "--stdin"]);
    if (r.status !== 0) return null;
    const out = (r.stdout ?? "").trim();
    return /^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(out) ? out : null;
  }
  const repoEmptyTree = headIsUnborn ? repoEmptyTreeOrNull() : null;
  if (headIsUnborn && !repoEmptyTree) {
    // Cannot safely diff against an unknown empty tree. Fail open via the
    // caller — return a sentinel payload that the hook treats as "abort".
    return { ...out, _failOpenReason: "could not compute repo empty tree" };
  }
  const stagedBaseRef = headIsUnborn ? repoEmptyTree : "HEAD";

  if (mode === "normal") {
    out.committed = git(cwd, ["diff", `${baseline.head}..HEAD`]).stdout;
    out.staged = git(cwd, ["diff", "--cached", baseline.indexTree]).stdout;
  } else if (mode === "4aPrime") {
    out.staged = git(cwd, ["diff", "--cached", baseline]).stdout;
  } else if (mode === "4b") {
    // Path 4b (dirty tree, ancestry break OR no baseline). Use HEAD when it
    // exists; on unborn repos, use the empty tree so the initial scaffolding
    // appears in Section B.
    out.staged = git(cwd, ["diff", "--cached", stagedBaseRef]).stdout;
  } else if (mode === "4c") {
    // No usable baseline. Use HEAD^ if it exists, else the runtime-computed
    // repo-format-aware empty tree. No silent SHA-1 fallback.
    let parent;
    if (!headIsUnborn && git(cwd, ["rev-parse", "HEAD^"]).status === 0) {
      parent = "HEAD^";
    } else {
      parent = repoEmptyTreeOrNull();
      if (!parent) {
        return { ...out, _failOpenReason: "could not compute repo empty tree for 4c" };
      }
    }
    out.staged = git(cwd, ["diff", "--cached", parent]).stdout;
  }

  out.unstaged = git(cwd, ["diff"]).stdout;
  const untrackedR = git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  out.untracked = untrackedR.stdout.split("\n").filter(Boolean);

  if (current.indexTree === "unmerged") {
    const lsu = git(cwd, ["ls-files", "-u", "-z"]);
    out.unmerged = lsu.stdout.split("\0").filter(Boolean);
  }

  return out;
}

async function runReviewViaWorker(sessionId, payload, repoRoot) {
  const wjPath = path.join(
    process.env.HOME ?? "/tmp",
    ".claude/state/claude-adv/sessions",
    sessionId,
    "worker.json"
  );
  if (!existsSync(wjPath)) throw new Error("worker not present");
  const wj = JSON.parse(readFileSync(wjPath, "utf8"));
  return await connectAndRequest(
    wj.sockPath,
    {
      id: "stop-gate",
      type: "review",
      nonce: wj.nonce,
      target: "previous-turn",
      diff: formatPayload(payload, repoRoot),
      summary: "Stop event review",
    },
    { timeoutMs: REVIEW_IPC_TIMEOUT_MS }
  );
}

async function runReviewViaFreshSubprocess(payload, config, repoRoot) {
  const { useBare } = detectReviewerAuthClass();
  const argv = buildReviewerArgs({
    promptFile: path.join(ROOT, "prompts", "adversarial-review.md"),
    budgetUsd: config.maxBudgetUsd ?? 5,
    sessionId: randomUUID(),
    useBare,
  });
  const result = await spawnAndCollect(argv, formatPayload(payload, repoRoot));
  if (result.ok && result.review) return { ok: true, review: result.review };
  return { ok: false, code: "fresh-fallback-failed", detail: result.error };
}

function formatPayload(p, repoRoot) {
  // Always render Sections A-D even when empty;
  // Section D includes untracked file contents; Section E carries structured
  // unmerged metadata plus current worktree content for each conflict path.
  const sections = [];

  sections.push(
    "## A — Committed delta\n\n" + (p.committed ? "```diff\n" + p.committed + "\n```" : "_(empty)_")
  );

  sections.push(
    "## B — Staged delta\n\n" + (p.staged ? "```diff\n" + p.staged + "\n```" : "_(empty)_")
  );

  sections.push(
    "## C — Unstaged delta\n\n" + (p.unstaged ? "```diff\n" + p.unstaged + "\n```" : "_(empty)_")
  );

  // Section D — untracked files WITH contents (the digest reflects
  // their bytes, so the reviewer must see them too).
  if (p.untracked.length === 0) {
    sections.push("## D — Untracked files\n\n_(none)_");
  } else {
    const parts = ["## D — Untracked files\n"];
    for (const rel of p.untracked) {
      parts.push(`### ${rel}\n`);
      let body;
      try {
        const stat = lstatSync(join(repoRoot, rel));
        if (stat.isSymbolicLink()) {
          body = `_(symlink → ${readlinkSync(join(repoRoot, rel))})_`;
        } else {
          // Section D: include content. Use head+tail when very large
          // so the reviewer sees both ends; never elide entirely.
          const buf = readFileSync(join(repoRoot, rel));
          if (looksBinary(buf)) {
            body = `_[binary, ${buf.length} bytes]_`;
          } else if (buf.length > 256 * 1024) {
            const HEAD = 96 * 1024,
              TAIL = 96 * 1024;
            const head = buf.subarray(0, HEAD).toString("utf8");
            const tail = buf.subarray(buf.length - TAIL).toString("utf8");
            body =
              "```\n" +
              head +
              `\n\n[... ${buf.length - HEAD - TAIL} bytes omitted from middle ...]\n\n` +
              tail +
              "\n```";
          } else {
            body = "```\n" + buf.toString("utf8") + "\n```";
          }
        }
      } catch (err) {
        body = `_[unreadable: ${err.message}]_`;
      }
      parts.push(body + "\n");
    }
    sections.push(parts.join("\n"));
  }

  // Section E — structured unmerged records + conflict worktree content.
  if (p.unmerged.length === 0) {
    // Spec says Section E is "only present when index is unmerged" — so we
    // omit it entirely rather than emitting an empty placeholder.
  } else {
    const parts = ["## E — Unmerged index records\n"];
    // Each unmerged record from `git ls-files -u -z` is "<mode> <sha> <stage>\t<path>".
    const seen = new Set();
    for (const rec of p.unmerged) {
      const m = rec.match(/^(\d+)\s+([a-f0-9]+)\s+(\d)\t(.+)$/);
      if (!m) continue;
      const [, mode, blob, stage, p2] = m;
      parts.push(`- path=\`${p2}\` stage=${stage} mode=${mode} blob=${blob}`);
      seen.add(p2);
    }
    parts.push("\n### Worktree at conflict paths\n");
    for (const p2 of seen) {
      parts.push(`#### ${p2}\n`);
      try {
        const buf = readFileSync(join(repoRoot, p2));
        if (looksBinary(buf)) {
          parts.push(`_[binary, ${buf.length} bytes]_\n`);
        } else if (buf.length > 256 * 1024) {
          const HEAD = 96 * 1024,
            TAIL = 96 * 1024;
          const head = buf.subarray(0, HEAD).toString("utf8");
          const tail = buf.subarray(buf.length - TAIL).toString("utf8");
          parts.push(
            "```\n" +
              head +
              `\n\n[... ${buf.length - HEAD - TAIL} bytes omitted from middle ...]\n\n` +
              tail +
              "\n```\n"
          );
        } else {
          parts.push("```\n" + buf.toString("utf8") + "\n```\n");
        }
      } catch (err) {
        parts.push(`_[unreadable: ${err.message}]_\n`);
      }
    }
    sections.push(parts.join("\n"));
  }

  return sections.join("\n\n");
}

function looksBinary(buf) {
  // Heuristic: presence of NUL in first 8KB → binary.
  const slice = buf.subarray(0, Math.min(buf.length, 8192));
  return slice.includes(0);
}

main().catch((err) => failOpen(`uncaught: ${err.message}`));
