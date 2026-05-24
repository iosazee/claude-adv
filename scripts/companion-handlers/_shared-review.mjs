// scripts/companion-handlers/_shared-review.mjs
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

import { parseArgs } from "../lib/args.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "../lib/git.mjs";
import { loadPromptTemplate, interpolateTemplate } from "../lib/prompts.mjs";
import { buildReviewerArgs, detectReviewerAuthClass, spawnAndCollect } from "../lib/claude-cli.mjs";
import { captureProcessStartTime } from "../lib/process.mjs";
import {
  generateJobId,
  getConfig,
  upsertJob,
  upsertJobUnlessStatus,
  writeJobFile,
  writeJobFileUnlessStatus,
} from "../lib/state.mjs";
import { createJobRecord } from "../lib/tracked-jobs.mjs";
import { readStoredJob as readStoredJobRecord } from "../lib/job-control.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);

function isTerminalJob(job) {
  return TERMINAL_JOB_STATUSES.has(job?.status);
}

function startTimeCaptureState(startTime) {
  return startTime ? "captured" : "unavailable";
}

function startTimeCaptureError(label, startTime) {
  if (startTime) {
    return null;
  }
  return `could not capture process start-time for ${label}; PID-only liveness fallback is active`;
}

export async function runReview(argv, { promptFile, reviewName }) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: [
      "base",
      "scope",
      "model",
      "cwd",
      "job-id",
      "continue",
      "max-inline-bytes",
      "max-inline-file-bytes",
    ],
    booleanOptions: ["json", "wait", "background"],
  });

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  ensureGitRepository(cwd);

  const inlineDiffOptions = parseInlineDiffOptions(options);

  // Background dispatch path — --background creates a
  // tracked job and returns immediately. The actual review runs in a detached
  // companion-handlers/task-worker subprocess that updates the job record.
  if (options.background && !options["job-id"]) {
    return await enqueueBackgroundReview({
      argv,
      options,
      positionals,
      cwd,
      promptFile,
      reviewName,
    });
  }

  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope,
  });
  const focusText = positionals.join(" ").trim();
  // File-count cap was removed 2026-05-16: byte caps (256KB total / 64KB per
  // file in git.mjs) are the authoritative inline-diff bound. Users may raise
  // the defaults per-invocation via --max-inline-bytes / --max-inline-file-bytes
  // when a large feature branch would otherwise drop to self-collect mode; see
  // docs/HOW-TO.md for the size→quality trade-off.
  const context = collectReviewContext(cwd, target, inlineDiffOptions);

  // Load prior findings from the --continue file if provided. The file is
  // the JSON payload written by a previous review of this same artifact
  // (typically the last iteration's report). We interpolate the findings
  // into the prompt as a `<previously_addressed>` block so the model can
  // (a) verify whether each was actually resolved by the edits since,
  // (b) suppress re-litigation when the issue is fixed, and (c) focus on
  // new issues. Without this, every iteration is a fresh adversarial pass
  // with no convergence force — see HOW-TO §"Iterating a review to approval".
  const previouslyAddressed = options.continue
    ? buildPreviouslyAddressedBlock(options.continue, cwd)
    : "(no prior iteration; this is a first-pass review)";

  const promptTemplate = loadPromptTemplate(ROOT, path.basename(promptFile, ".md"));
  const renderedPrompt = interpolateTemplate(promptTemplate, {
    REVIEW_KIND: reviewName,
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance ?? "",
    REVIEW_INPUT: context.content,
    PREVIOUSLY_ADDRESSED: previouslyAddressed,
  });

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const budgetUsd = config.maxBudgetUsd ?? 5;

  // Primary review (uses --continue context if --continue is set).
  const primary = await runOneReview({
    promptFile,
    prompt: renderedPrompt,
    budgetUsd,
    model: options.model,
  });

  // Final independent verification: when --continue was used AND the primary
  // review's verdict is `approve` or `approve-with-notes`, run one fresh
  // single-shot review WITHOUT the previously-addressed context. The
  // --continue prompt biases the reviewer toward suppressing re-litigated
  // concerns; without verification, a finding the model would normally raise
  // can be hidden behind "this was probably resolved." The fresh verification
  // is the actual approval gate. Its verdict overrides the primary's; both
  // attempts are preserved in the payload for transparency.
  //
  // Skipped when: --continue was not used (no bias to correct), the primary
  // failed (no verdict to verify), or the primary's verdict is needs-attention
  // (already blocking; no need to spend another model call).
  let verification = null;
  let result = primary.result;
  if (
    options.continue &&
    primary.result.ok &&
    primary.result.review &&
    (primary.result.review.verdict === "approve" ||
      primary.result.review.verdict === "approve-with-notes")
  ) {
    const verificationPrompt = interpolateTemplate(promptTemplate, {
      REVIEW_KIND: reviewName,
      TARGET_LABEL: context.target.label,
      USER_FOCUS: focusText || "No extra focus provided.",
      REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance ?? "",
      REVIEW_INPUT: context.content,
      PREVIOUSLY_ADDRESSED:
        "(this is a clean independent verification pass; no prior-iteration context is provided so the reviewer's skepticism is not biased by a previously-addressed list)",
    });
    verification = await runOneReview({
      promptFile,
      prompt: verificationPrompt,
      budgetUsd,
      model: options.model,
    });
    // The fresh verification is authoritative. Its result becomes the payload's
    // review_output. The primary review is preserved under `continueAttempt`.
    result = verification.result;
  }

  // Paper-approve safeguard: when the diff exceeded inline byte caps and the
  // reviewer was given file-list/stats only (`inputMode === "self-collect"`),
  // it CANNOT have meaningfully reviewed the code (locked `--tools ""`).
  // The prompt instructs refusal, but a model may still produce a verdict
  // based on file names alone. The runtime overrides paper approvals to
  // needs-attention with a synthetic finding describing the condition.
  // Spawn / schema / parse failures aren't affected (no review object).
  if (
    context.inputMode === "self-collect" &&
    result.ok &&
    result.review &&
    (result.review.verdict === "approve" || result.review.verdict === "approve-with-notes")
  ) {
    const original = result.review.verdict;
    result.review = {
      ...result.review,
      verdict: "needs-attention",
      _verdictDemoted: `paper-approve safeguard: original verdict was \`${original}\` but the reviewer was given file-list/stats only (diff exceeded inline byte caps); a verdict based on file names is not a real review`,
      findings: [
        ...(result.review.findings ?? []),
        {
          severity: "high",
          confidence: 1.0,
          title:
            "Diff exceeded inline byte caps — adversarial review could not see the implementation",
          file: "(runtime)",
          line_start: 1,
          line_end: 1,
          body:
            'The reviewer subprocess runs with locked `--tools ""` and cannot fetch the diff itself. ' +
            "When the diff exceeds the inline byte caps (256KB total / 64KB per file), only file names and stats are inlined, " +
            "and any verdict produced from that alone is a paper review. " +
            `Original model verdict: \`${original}\`. Promoted to needs-attention by the runtime safeguard.`,
          recommendation:
            "Re-run claude-adv on a smaller, scoped subset of the changes (narrow --base, or per-commit), OR raise the inline byte caps via --max-inline-bytes / --max-inline-file-bytes (defaults 262144 / 65536), OR review by hand.",
        },
      ],
    };
  }

  // If the (possibly-retried) attempt still failed in a way that produced
  // assistant text (schema-violation or JSON parse-failure), capture the raw
  // final text so /result and the renderer can show it instead of the bare
  // error message. Spawn failures and "no final assistant message" cases have
  // nothing useful to capture.
  const finalRawOutput =
    !result.ok && isRecoverableModelOutputError(result.error)
      ? extractFinalAssistantText(result.events)
      : null;

  // Authoritative attempt = verification when it ran, else primary.
  const authoritative = verification ?? primary;

  const payload = {
    review: reviewName,
    target,
    sessionId: authoritative.sessionId,
    claudeSessionId:
      result.events.find((e) => e.type === "system" && e.session_id)?.session_id ?? null,
    context: { repoRoot: context.repoRoot, branch: context.branch, summary: context.summary },
    claude: {
      ok: result.ok,
      exitCode: result.exitCode,
      costUsd: result.costUsd,
      stderr: result.stderr,
      error: result.error,
      retryAttempted: authoritative.retryAttempted,
      firstAttemptRawOutput: authoritative.firstAttemptRawOutput,
      rawOutput: finalRawOutput,
    },
    review_output: result.review,
    // Verification trace: when --continue triggered a fresh verification
    // pass, both attempts are surfaced so the user can see what the biased
    // and unbiased reviewers found.
    continueAttempt: verification
      ? {
          sessionId: primary.sessionId,
          ok: primary.result.ok,
          costUsd: primary.result.costUsd,
          verdict: primary.result.review?.verdict ?? null,
          n_findings: primary.result.review?.findings?.length ?? 0,
          review_output: primary.result.review,
        }
      : null,
    finalVerification: verification
      ? {
          triggered: true,
          sessionId: verification.sessionId,
          ok: verification.result.ok,
          costUsd: verification.result.costUsd,
        }
      : { triggered: false },
  };

  // If this is running as a background task-worker, update the job record
  // instead of writing to stdout. The original /claude-adv:status, /result,
  // /cancel commands read these records.
  if (options["job-id"]) {
    persistJobResult(cwd, options["job-id"], payload, result.ok ? "completed" : "failed");
    return;
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else {
    renderTextReview(payload);
  }
  if (!result.ok) process.exitCode = 1;
}

async function enqueueBackgroundReview({
  argv,
  options,
  positionals,
  cwd,
  promptFile,
  reviewName,
}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobId = generateJobId(
    reviewName === "Adversarial Review" ? "adversarial-review" : "review"
  );
  const focusText = positionals.join(" ").trim();
  const initialRecord = createJobRecord({
    id: jobId,
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    kindLabel: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: `Claude ${reviewName}`,
    workspaceRoot,
    jobClass: "review",
    summary: `${reviewName} ${options.scope ?? "auto"}${focusText ? ` — ${focusText.slice(0, 60)}` : ""}`,
  });
  initialRecord.status = "queued";
  initialRecord.phase = "queued";
  writeJobFile(workspaceRoot, jobId, {
    ...initialRecord,
    request: { argv, promptFile, reviewName, cwd },
  });
  upsertJob(workspaceRoot, initialRecord);

  // Spawn the task-worker subprocess detached. It calls back into this
  // companion with --job-id so the same code path runs in foreground mode
  // but writes results to the job record.
  const scriptPath = path.join(ROOT, "scripts/claude-companion.mjs");
  const reviewerSubcommand = reviewName === "Adversarial Review" ? "adversarial-review" : "review";
  const child = spawn(
    process.execPath,
    [
      scriptPath,
      reviewerSubcommand,
      ...argv.filter((a) => a !== "--background"),
      "--wait",
      "--job-id",
      jobId,
    ],
    { detached: true, stdio: "ignore", env: process.env }
  );
  child.unref();

  // Persist the live PID/PGID so /claude-adv:cancel can actually kill it.
  // Without this, the job record has pid=null and cancel becomes a no-op.
  const childPgid = (() => {
    try {
      return process.getpgid?.(child.pid) ?? child.pid;
    } catch {
      return child.pid;
    }
  })();
  const startTimeLabel = "background review worker";
  // Capture the OS-level start identifier before the job is advertised as
  // running. If ps is unavailable, the persisted job is marked degraded with
  // startTimeCapture="unavailable" and the reaper falls back to PID-only
  // liveness.
  const startTime = await captureProcessStartTime(child.pid, {
    label: startTimeLabel,
  });
  const startedAt = new Date().toISOString();
  const runningRecord = {
    ...initialRecord,
    status: "running",
    phase: "running",
    pid: child.pid,
    pgid: childPgid,
    startTime,
    startTimeCapture: startTimeCaptureState(startTime),
    startTimeCaptureError: startTimeCaptureError(startTimeLabel, startTime),
    startedAt,
    request: { argv, promptFile, reviewName, cwd },
  };
  const storedRunningJob = writeJobFileUnlessStatus(
    workspaceRoot,
    jobId,
    runningRecord,
    TERMINAL_JOB_STATUSES
  );
  if (!isTerminalJob(storedRunningJob)) {
    upsertJobUnlessStatus(
      workspaceRoot,
      {
        id: jobId,
        status: "running",
        phase: "running",
        pid: child.pid,
        pgid: childPgid,
        startTime,
        startTimeCapture: startTimeCaptureState(startTime),
        startTimeCaptureError: startTimeCaptureError(startTimeLabel, startTime),
        startedAt,
      },
      TERMINAL_JOB_STATUSES
    );
  } else {
    upsertJob(workspaceRoot, {
      id: jobId,
      status: storedRunningJob.status,
      phase: storedRunningJob.phase,
    });
  }

  const out = {
    jobId,
    status: "queued",
    title: initialRecord.title,
    summary: initialRecord.summary,
    logFile: initialRecord.logFile ?? null,
  };
  if (options.json) {
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  } else {
    process.stdout.write(
      `${initialRecord.title} started in the background as ${jobId}. Check /claude-adv:status ${jobId} for progress.\n`
    );
  }
}

function persistJobResult(cwd, jobId, payload, status) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const existing = readStoredJobRecord(workspaceRoot, jobId);
  if (!existing) return;
  const completedAt = new Date().toISOString();
  const next = {
    ...existing,
    status,
    phase: status,
    completedAt,
    review_output: payload.review_output,
    rawPayload: payload,
  };
  writeJobFile(workspaceRoot, jobId, next);
  upsertJob(workspaceRoot, { id: jobId, status, phase: status, completedAt });
}

function renderTextReview(p) {
  const r = p.review_output;
  process.stdout.write(`# ${p.review} — ${p.target.label}\n\n`);
  if (!r) {
    process.stdout.write(`Review failed: ${p.claude.error ?? "no output"}\n`);
    if (p.claude.retryAttempted) {
      process.stdout.write(`\nA single schema-repair retry was attempted and also failed.\n`);
    }
    if (p.claude.rawOutput) {
      process.stdout.write(
        `\nThe model's raw final response is shown below. You can re-run the review (the inner Claude is non-deterministic), or copy the content here and use it directly.\n`
      );
      process.stdout.write("\n```text\n");
      process.stdout.write(p.claude.rawOutput);
      process.stdout.write("\n```\n");
    }
    return;
  }
  process.stdout.write(`Verdict: **${r.verdict}**\n\n${r.summary}\n\n`);
  if (r._verdictDemoted) {
    process.stdout.write(`_Note: ${r._verdictDemoted}_\n\n`);
  }
  // Verification trace: when --continue triggered a fresh verification, the
  // displayed verdict is the verification's, not the --continue review's.
  // Surface this so the user knows the verdict is authoritative.
  if (p.finalVerification?.triggered) {
    const c = p.continueAttempt ?? {};
    process.stdout.write(
      `_Final verification ran (fresh single-shot review without prior context). ` +
        `Continue-attempt verdict was \`${c.verdict ?? "unknown"}\` with ${c.n_findings ?? 0} ` +
        `finding(s); the verdict above is the verification result and is authoritative._\n\n`
    );
  }
  if (r.findings?.length) {
    process.stdout.write(`## Findings\n\n`);
    for (const f of r.findings) {
      const fp = f.fingerprint ? ` [${f.fingerprint}]` : "";
      process.stdout.write(`- **${f.severity}**: ${f.title}${fp}\n`);
      process.stdout.write(
        `  ${f.file}:${f.line_start}-${f.line_end} (confidence ${f.confidence})\n`
      );
      process.stdout.write(`  ${f.body}\n`);
      if (f.recommendation) process.stdout.write(`  → ${f.recommendation}\n`);
    }
  }
  if (typeof p.claude.costUsd === "number") {
    process.stdout.write(`\nCost: $${p.claude.costUsd.toFixed(4)}\n`);
  }
}

// Spawn one review attempt with bounded schema-repair retry. Used both for
// the primary review and (when --continue triggers it) the fresh
// independent verification pass. Each invocation produces a clean fresh
// sessionId — the locked invariants require it.
async function runOneReview({ promptFile, prompt, budgetUsd, model }) {
  // Auth-class detection per spawn: api-key path uses --bare (strongest
  // isolation); subscription path omits --bare so the inner claude can read
  // its own keychain/OAuth, and spawnAndCollect spawns from a controlled
  // temp cwd to suppress project CLAUDE.md auto-discovery.
  const { useBare } = detectReviewerAuthClass();
  const sessionId = randomUUID();
  const argv = buildReviewerArgs({
    promptFile: path.join(ROOT, "prompts", path.basename(promptFile)),
    budgetUsd,
    sessionId,
    model,
    useBare,
  });
  let result = await spawnAndCollect(argv, prompt);
  let retryAttempted = false;
  let firstAttemptRawOutput = null;

  if (!result.ok && isRecoverableModelOutputError(result.error)) {
    firstAttemptRawOutput = extractFinalAssistantText(result.events);
    const repairPrompt = buildRepairPrompt(prompt, firstAttemptRawOutput, result.error);
    const repairSessionId = randomUUID();
    const repairArgs = buildReviewerArgs({
      promptFile: path.join(ROOT, "prompts", path.basename(promptFile)),
      budgetUsd,
      sessionId: repairSessionId,
      model,
      useBare,
    });
    result = await spawnAndCollect(repairArgs, repairPrompt);
    retryAttempted = true;
  }

  return { sessionId, result, retryAttempted, firstAttemptRawOutput };
}

// Validate and coerce the inline-diff size knobs at the CLI boundary. Invalid
// values throw rather than silently falling back to defaults — a typo in a
// byte cap should not be absorbed and produce a paper approval downstream.
// Omitted flags pass `undefined` through so collectReviewContext applies its
// own defaults (256 KiB total / 64 KiB per-file).
export function parseInlineDiffOptions(options) {
  const out = {};
  if (options["max-inline-bytes"] !== undefined) {
    const n = Number(options["max-inline-bytes"]);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error("--max-inline-bytes must be a positive number (bytes).");
    }
    out.maxInlineDiffBytes = Math.floor(n);
  }
  if (options["max-inline-file-bytes"] !== undefined) {
    const n = Number(options["max-inline-file-bytes"]);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error("--max-inline-file-bytes must be a positive number (bytes).");
    }
    out.maxInlineFileDiffBytes = Math.floor(n);
  }
  return out;
}

// Both schema-violation and JSON parse-failure mean the model produced output
// that doesn't fit the expected shape — both are recoverable by re-prompting
// with a repair instruction. Spawn failures and "no final assistant message"
// (process died mid-stream) are NOT recoverable here; retry would just hit
// the same failure.
function isRecoverableModelOutputError(error) {
  if (typeof error !== "string") return false;
  return (
    error.startsWith("schema-violation:") ||
    error.startsWith("failed to parse final assistant text as JSON:")
  );
}

function extractFinalAssistantText(events) {
  const final = [...events].reverse().find((e) => e.type === "assistant" && e.message?.content);
  if (!final) return null;
  const text = (final.message.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
  return text.trim() || null;
}

export function buildRepairPrompt(originalPrompt, rawOutput, errorMessage) {
  return [
    originalPrompt,
    "",
    "<schema_repair>",
    "Your previous response could not be accepted: it either failed to parse",
    "as a single JSON object, or it parsed but did not match the required",
    "review-output schema.",
    `Reason: ${errorMessage}`,
    "",
    "Your previous response was:",
    "<previous_response>",
    rawOutput ?? "(no text captured)",
    "</previous_response>",
    "",
    "Re-emit the same review as a single JSON object that satisfies the schema:",
    "- top-level keys: verdict, summary, findings, next_steps",
    "- verdict: exactly `approve`, `approve-with-notes`, or `needs-attention`",
    "- every finding object MUST include severity, title, body, file, line_start, line_end, confidence, recommendation",
    "- severity MUST be one of: critical, high, medium, low",
    "- line_start and line_end are positive integers, line_end >= line_start",
    "- confidence is a number between 0 and 1",
    "",
    "Output JSON only. No prose, no fences, no preamble.",
    "</schema_repair>",
  ].join("\n");
}

// Format a prior review's findings as a block the next prompt can use to
// avoid re-litigating already-handled issues. The block lists each finding
// by fingerprint so the model has a stable identity to reference, and tells
// the model the iteration discipline: verify resolution against current
// content, suppress when fixed, re-raise (with an explanation) when not.
function buildPreviouslyAddressedBlock(continueFilePath, cwd) {
  const resolvedPath = path.resolve(cwd, continueFilePath);
  let raw;
  try {
    raw = readFileSync(resolvedPath, "utf8");
  } catch (err) {
    return `(--continue ${continueFilePath} could not be read: ${err.message}; treat this as a first-pass review)`;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return `(--continue ${continueFilePath} did not parse as JSON: ${err.message}; treat this as a first-pass review)`;
  }
  const findings =
    parsed.review_output?.findings ?? parsed.review?.findings ?? parsed.findings ?? [];
  if (!Array.isArray(findings) || findings.length === 0) {
    return "(prior iteration produced no findings; this iteration is fresh)";
  }
  const lines = [
    `<previously_addressed_protocol>`,
    `The previous review iteration produced ${findings.length} finding(s) listed below.`,
    "",
    "DISCIPLINE (read carefully — this is not the same as 'find new things'):",
    "",
    "1. **First, conduct a full, independent adversarial review of the CURRENT artifact",
    "   as if you had no prior context.** Find every defensible issue you can articulate",
    "   against the current content. Do not narrow your skepticism because items appear",
    "   in the previously-addressed list.",
    "",
    "2. **Then, cross-reference your independent findings against the prior list:**",
    "   - If your independent finding matches a prior finding's underlying concern AND",
    "     the prior finding is genuinely resolved by the current content — drop it from",
    "     your output. The prior list exists so you can verify resolution, not so you",
    "     can avoid drawing the same conclusion twice.",
    "   - If your independent finding matches a prior finding's underlying concern AND",
    "     you can still defend the concern against the current content — KEEP it in",
    "     your output and add a one-sentence note in `body` explaining why the prior",
    "     fix did not address it.",
    "   - If your independent finding is NEW (no overlap with the prior list) — KEEP",
    "     it. The runtime will compute a fresh fingerprint.",
    "",
    "3. **Do NOT suppress a finding just because the prior list does not mention it.**",
    "   You may find issues the prior reviewer missed. That is the desired behavior;",
    "   raise them.",
    "",
    "4. **Do NOT suppress a finding just because addressing it appears in the prior",
    "   list as 'resolved'.** Verify resolution against the CURRENT artifact yourself.",
    "   If the resolution is incomplete, the finding is still present.",
    "",
    "The runtime will independently re-verify your output with a clean adversarial",
    "pass that has no access to this previously-addressed list. If that clean pass",
    "finds critical or high-severity issues you suppressed, the verdict will be",
    "overridden. Suppression on the strength of this list alone is not a winning",
    "strategy — confirmed-clean independent verification is.",
    "</previously_addressed_protocol>",
    "",
    "Prior findings (verbatim from the previous iteration's JSON payload, for",
    "cross-referencing only — NOT a permission to narrow your skepticism):",
    "",
  ];
  for (const f of findings) {
    lines.push(
      `- fingerprint=${f.fingerprint ?? "(none)"} severity=${f.severity} confidence=${f.confidence}`,
      `  ${f.file}:${f.line_start}-${f.line_end}  ${f.title}`,
      `  body: ${(f.body ?? "").slice(0, 400)}`
    );
    if (f.recommendation) {
      lines.push(`  recommendation: ${String(f.recommendation).slice(0, 300)}`);
    }
  }
  return lines.join("\n");
}
