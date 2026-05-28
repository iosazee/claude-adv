// Generated from scripts/lib/render.mjs by scripts/release/sync-codex-bundle.mjs. Do not edit.
/**
 * Extracts thinking-block text from a stream of stream-json events.
 * Returns an array of strings, one per thinking block.
 */
export function extractThinkingBlocks(events) {
  const blocks = [];
  for (const ev of events ?? []) {
    if (ev.type !== "assistant" || !ev.message?.content) continue;
    for (const c of ev.message.content) {
      if (c.type === "thinking" && c.thinking) blocks.push(c.thinking);
    }
  }
  return blocks;
}

function severityRank(severity) {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    default:
      return 3;
  }
}

function formatLineRange(finding) {
  if (!finding.line_start) {
    return "";
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}

function validateReviewResultShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  if (typeof data.verdict !== "string" || !data.verdict.trim()) {
    return "Missing string `verdict`.";
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    return "Missing string `summary`.";
  }
  if (!Array.isArray(data.findings)) {
    return "Missing array `findings`.";
  }
  if (!Array.isArray(data.next_steps)) {
    return "Missing array `next_steps`.";
  }
  return null;
}

function normalizeReviewFinding(finding, index) {
  const source = finding && typeof finding === "object" && !Array.isArray(finding) ? finding : {};
  const lineStart =
    Number.isInteger(source.line_start) && source.line_start > 0 ? source.line_start : null;
  const lineEnd =
    Number.isInteger(source.line_end) &&
    source.line_end > 0 &&
    (!lineStart || source.line_end >= lineStart)
      ? source.line_end
      : lineStart;

  return {
    severity:
      typeof source.severity === "string" && source.severity.trim()
        ? source.severity.trim()
        : "low",
    title:
      typeof source.title === "string" && source.title.trim()
        ? source.title.trim()
        : `Finding ${index + 1}`,
    body:
      typeof source.body === "string" && source.body.trim()
        ? source.body.trim()
        : "No details provided.",
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
    line_start: lineStart,
    line_end: lineEnd,
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : "",
  };
}

function normalizeReviewResultData(data) {
  return {
    verdict: data.verdict.trim(),
    summary: data.summary.trim(),
    findings: data.findings.map((finding, index) => normalizeReviewFinding(finding, index)),
    next_steps: data.next_steps
      .filter((step) => typeof step === "string" && step.trim())
      .map((step) => step.trim()),
  };
}

function isStructuredReviewStoredResult(storedJob) {
  const result = storedJob?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  return Object.hasOwn(result, "result") || Object.hasOwn(result, "parseError");
}

function formatJobLine(job) {
  const parts = [job.id, `${job.status || "unknown"}`];
  if (job.kindLabel) {
    parts.push(job.kindLabel);
  }
  if (job.title) {
    parts.push(job.title);
  }
  return parts.join(" | ");
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function formatClaudeResumeCommand(job) {
  if (!job?.threadId) {
    return null;
  }
  return `claude --resume ${job.threadId}`;
}

function appendActiveJobsTable(lines, jobs) {
  lines.push("Active jobs:");
  lines.push("| Job | Kind | Status | Phase | Elapsed | Claude Session ID | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const actions = [`/claude-adv:status ${job.id}`];
    if (job.status === "queued" || job.status === "running") {
      actions.push(`/claude-adv:cancel ${job.id}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.threadId ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`
    );
  }
}

function pushJobDetails(lines, job, options = {}) {
  lines.push(`- ${formatJobLine(job)}`);
  if (job.summary) {
    lines.push(`  Summary: ${job.summary}`);
  }
  if (job.phase) {
    lines.push(`  Phase: ${job.phase}`);
  }
  if (options.showElapsed && job.elapsed) {
    lines.push(`  Elapsed: ${job.elapsed}`);
  }
  if (options.showDuration && job.duration) {
    lines.push(`  Duration: ${job.duration}`);
  }
  if (job.threadId) {
    lines.push(`  Claude session ID: ${job.threadId}`);
  }
  const resumeCommand = formatClaudeResumeCommand(job);
  if (resumeCommand) {
    lines.push(`  Resume in Claude: ${resumeCommand}`);
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`);
  }
  if ((job.status === "queued" || job.status === "running") && options.showCancelHint) {
    lines.push(`  Cancel: /claude-adv:cancel ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`  Result: /claude-adv:result ${job.id}`);
  }
  if (
    job.status !== "queued" &&
    job.status !== "running" &&
    job.jobClass === "task" &&
    job.write &&
    options.showReviewHint
  ) {
    lines.push("  Review changes: /claude-adv:review --wait");
    lines.push("  Stricter review: /claude-adv:adversarial-review --wait");
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`);
    }
  }
}

function appendReasoningSection(lines, reasoningSummary) {
  if (!Array.isArray(reasoningSummary) || reasoningSummary.length === 0) {
    return;
  }

  lines.push("", "Reasoning:");
  for (const section of reasoningSummary) {
    lines.push(`- ${section}`);
  }
}

export function renderSetupReport(report) {
  const lines = [
    "# Claude Adv Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- npm: ${report.npm.detail}`,
    `- claude: ${report.claude.detail}`,
    `- auth: ${report.auth.detail}`,
    `- session runtime: ${report.sessionRuntime.label}`,
    `- review gate: ${report.reviewGateEnabled ? "enabled" : "disabled"}`,
    "",
  ];

  if (report.actionsTaken.length > 0) {
    lines.push("Actions taken:");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
    lines.push("");
  }

  if (report.nextSteps.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderReviewResult(parsedResult, meta) {
  if (!parsedResult.parsed) {
    const lines = [
      `# Claude ${meta.reviewLabel}`,
      "",
      "Claude did not return valid structured JSON.",
      "",
      `- Parse error: ${parsedResult.parseError}`,
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const validationError = validateReviewResultShape(parsedResult.parsed);
  if (validationError) {
    const lines = [
      `# Claude ${meta.reviewLabel}`,
      "",
      `Target: ${meta.targetLabel}`,
      "Claude returned JSON with an unexpected review shape.",
      "",
      `- Validation error: ${validationError}`,
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const data = normalizeReviewResultData(parsedResult.parsed);
  const findings = [...data.findings].sort(
    (left, right) => severityRank(left.severity) - severityRank(right.severity)
  );
  const lines = [
    `# Claude ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    `Verdict: ${data.verdict}`,
    "",
    data.summary,
    "",
  ];

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      const lineSuffix = formatLineRange(finding);
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}${lineSuffix})`);
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
    }
  }

  if (data.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  if (meta?.costUsd != null || parsedResult?.costUsd != null) {
    const cost = meta?.costUsd ?? parsedResult?.costUsd;
    lines.push(`\nCost: $${cost.toFixed(4)}`);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderNativeReviewResult(result, meta) {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const lines = [`# Claude ${meta.reviewLabel}`, "", `Target: ${meta.targetLabel}`, ""];

  if (stdout) {
    lines.push(stdout);
  } else if (result.status === 0) {
    lines.push("Claude review completed without any stdout output.");
  } else {
    lines.push("Claude review failed.");
  }

  if (stderr) {
    lines.push("", "stderr:", "", "```text", stderr, "```");
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  if (meta?.costUsd != null || result?.costUsd != null) {
    const cost = meta?.costUsd ?? result?.costUsd;
    lines.push(`\nCost: $${cost.toFixed(4)}`);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderTaskResult(parsedResult, meta) {
  const rawOutput = typeof parsedResult?.rawOutput === "string" ? parsedResult.rawOutput : "";
  let output;
  if (rawOutput) {
    output = rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
  } else {
    const message =
      String(parsedResult?.failureMessage ?? "").trim() || "Claude did not return a final message.";
    output = `${message}\n`;
  }

  if (meta?.costUsd != null || parsedResult?.costUsd != null) {
    const cost = meta?.costUsd ?? parsedResult?.costUsd;
    output += `\nCost: $${cost.toFixed(4)}\n`;
  }

  return output;
}

export function renderStatusReport(report) {
  const lines = [
    "# Claude Adv Status",
    "",
    `Session runtime: ${report.sessionRuntime.label}`,
    `Review gate: ${report.config.stopReviewGate ? "enabled" : "disabled"}`,
    "",
  ];

  if (report.running.length > 0) {
    appendActiveJobsTable(lines, report.running);
    lines.push("");
    lines.push("Live details:");
    for (const job of report.running) {
      pushJobDetails(lines, job, {
        showElapsed: true,
        showLog: true,
      });
    }
    lines.push("");
  }

  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, {
      showDuration: true,
      showLog: report.latestFinished.status === "failed",
    });
    lines.push("");
  }

  if (report.recent.length > 0) {
    lines.push("Recent jobs:");
    for (const job of report.recent) {
      pushJobDetails(lines, job, {
        showDuration: true,
        showLog: job.status === "failed",
      });
    }
    lines.push("");
  } else if (report.running.length === 0 && !report.latestFinished) {
    lines.push("No jobs recorded yet.", "");
  }

  if (report.needsReview) {
    lines.push("The stop-time review gate is enabled.");
    lines.push(
      "Ending the session will trigger a fresh Claude adversarial review and block if it finds issues."
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobStatusReport(job) {
  const lines = ["# Claude Adv Job Status", ""];
  pushJobDetails(lines, job, {
    showElapsed: job.status === "queued" || job.status === "running",
    showDuration: job.status !== "queued" && job.status !== "running",
    showLog: true,
    showCancelHint: true,
    showResultHint: true,
    showReviewHint: true,
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  const threadId = storedJob?.threadId ?? job.threadId ?? null;
  const resumeCommand = threadId ? `claude --resume ${threadId}` : null;
  if (isStructuredReviewStoredResult(storedJob) && storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n")
      ? storedJob.rendered
      : `${storedJob.rendered}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nClaude session ID: ${threadId}\nResume in Claude: ${resumeCommand}\n`;
  }

  // Background review jobs persist review_output (the structured verdict)
  // alongside rawPayload (target, claude.costUsd, etc). Format the same way
  // the foreground renderer does so /claude-adv:result <job-id> shows the
  // verdict + findings, not "No captured result payload was stored."
  if (storedJob?.review_output && typeof storedJob.review_output === "object") {
    const payload = storedJob.rawPayload ?? {};
    const reviewLabel = (job.title ?? "Review").replace(/^Claude\s+/i, "");
    const targetLabel = payload.target?.label ?? "(target unknown)";
    const costUsd = payload.claude?.costUsd ?? storedJob.costUsd;
    const rendered = renderReviewResult(
      { parsed: storedJob.review_output, costUsd, rawOutput: "" },
      { reviewLabel, targetLabel, costUsd }
    );
    if (!threadId) {
      return rendered;
    }
    return `${rendered.endsWith("\n") ? rendered.slice(0, -1) : rendered}\n\nClaude session ID: ${threadId}\nResume in Claude: ${resumeCommand}\n`;
  }

  // Failed review jobs (schema-violation, parse failure, etc.) carry the
  // model's raw final response under rawPayload.claude.rawOutput. Surface
  // it so /result <job-id> shows what came back instead of just "No captured
  // result payload was stored."
  const claudeError = storedJob?.rawPayload?.claude?.error;
  const claudeRawOutput = storedJob?.rawPayload?.claude?.rawOutput;
  if (claudeError && typeof claudeRawOutput === "string" && claudeRawOutput.length > 0) {
    const reviewLabel = (job.title ?? "Result").replace(/^Claude\s+/i, "");
    const targetLabel = storedJob?.rawPayload?.target?.label ?? "(target unknown)";
    const lines = [
      `# Claude ${reviewLabel}`,
      "",
      `Target: ${targetLabel}`,
      "",
      `Review failed: ${claudeError}`,
    ];
    if (storedJob?.rawPayload?.claude?.retryAttempted) {
      lines.push("A single schema-repair retry was attempted and also failed.");
    }
    lines.push(
      "",
      "The model's raw final response is below. You can re-run the review (the inner Claude is non-deterministic), or copy the content here and use it directly.",
      "",
      "```text",
      claudeRawOutput,
      "```"
    );
    const costUsd = storedJob?.rawPayload?.claude?.costUsd;
    if (typeof costUsd === "number") {
      lines.push("", `Cost: $${costUsd.toFixed(4)}`);
    }
    if (threadId) {
      lines.push("", `Claude session ID: ${threadId}`, `Resume in Claude: ${resumeCommand}`);
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }

  const rawOutput =
    (typeof storedJob?.rawPayload?.rawOutput === "string" && storedJob.rawPayload.rawOutput) ||
    (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) ||
    "";
  if (rawOutput) {
    const lines = [rawOutput.endsWith("\n") ? rawOutput.slice(0, -1) : rawOutput];
    const costUsd = storedJob?.costUsd ?? storedJob?.rawPayload?.costUsd;
    if (typeof costUsd === "number") {
      lines.push("", `Cost: $${costUsd.toFixed(4)}`);
    }
    if (threadId) {
      lines.push("", `Claude session ID: ${threadId}`, `Resume in Claude: ${resumeCommand}`);
    }
    return `${lines.join("\n")}\n`;
  }

  if (storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n")
      ? storedJob.rendered
      : `${storedJob.rendered}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nClaude session ID: ${threadId}\nResume in Claude: ${resumeCommand}\n`;
  }

  const lines = [
    `# ${job.title ?? "Claude Result"}`,
    "",
    `Job: ${job.id}`,
    `Status: ${job.status}`,
  ];

  if (threadId) {
    lines.push(`Claude session ID: ${threadId}`);
    lines.push(`Resume in Claude: ${resumeCommand}`);
  }

  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }

  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }

  if (storedJob?.costUsd != null) {
    lines.push(`\nCost: $${storedJob.costUsd.toFixed(4)}`);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job) {
  const lines = ["# Claude Adv Cancel", "", `Cancelled ${job.id}.`, ""];

  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`);
  }
  lines.push("- Check `/claude-adv:status` for the updated queue.");

  return `${lines.join("\n").trimEnd()}\n`;
}
