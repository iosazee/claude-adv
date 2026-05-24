#!/usr/bin/env node
// scripts/cross-vendor-review.mjs
//
// N=2 cross-vendor adversarial-review experiment. Spawns claude-adv and
// codex-plugin-cc in parallel against the same diff, fingerprint-merges
// their outputs, and reports where the vendors agree, where they describe
// the same site differently, and where each is alone.
//
// This is a deliberate experiment, not a production feature. The thesis
// the experiment tests: cross-architecture blind-spot coverage is the
// real prize of a multi-model review. If the unique buckets are
// consistently non-trivial across 5–10 real diffs, scaling to a real
// N-model committee is justified. If both vendors agree on basically
// everything, the committee architecture is over-engineered.
//
// Usage:
//   node scripts/cross-vendor-review.mjs --base <ref> [--scope auto|working-tree|branch] [--cwd <path>] [focus text]
//
// Auth:
//   - claude-adv reuses your Claude credentials (ANTHROPIC_API_KEY or OAuth)
//   - codex-plugin-cc reuses your Codex credentials (whatever it needs)
//   The script calls each plugin's setup probe first and fails fast if
//   either is not ready.
//
// Output:
//   JSON to stdout (machine-readable) when --json is passed, otherwise a
//   text report. Cost summary always shown on stderr.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { mergeCrossVendor } from "./lib/cross-vendor-merge.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const CLAUDE_COMPANION = path.join(ROOT, "scripts/claude-companion.mjs");

function resolveCodexCompanion() {
  // Honor an explicit override; otherwise probe the standard install path.
  if (process.env.CODEX_PLUGIN_ROOT) {
    return path.join(process.env.CODEX_PLUGIN_ROOT, "scripts/codex-companion.mjs");
  }
  const standard = path.join(
    process.env.HOME ?? "",
    ".claude/plugins/cache/openai-codex/codex/1.0.4/scripts/codex-companion.mjs"
  );
  return standard;
}

function spawnCollectingJson(scriptPath, argv, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...argv], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      resolve({ ok: false, error: `spawn failed: ${err.message}`, stdout, stderr, exitCode: -1 });
    });
    child.on("close", (exitCode) => {
      let parsed = null;
      let parseError = null;
      try {
        parsed = JSON.parse(stdout);
      } catch (err) {
        parseError = err.message;
      }
      resolve({
        ok: exitCode === 0 && parsed != null,
        exitCode,
        stdout,
        stderr,
        parsed,
        parseError,
      });
    });
  });
}

async function ensureVendorReady(scriptPath, label, cwd) {
  const result = await spawnCollectingJson(scriptPath, ["setup", "--json"], cwd);
  if (!result.ok || !result.parsed?.ready) {
    const reason =
      result.parsed?.readinessReason ?? result.parseError ?? result.stderr ?? "unknown";
    throw new Error(`${label} not ready: ${reason}`);
  }
  return result.parsed;
}

function buildReviewArgs(options, positionals) {
  const args = ["adversarial-review", "--wait", "--json"];
  if (options.base) args.push("--base", options.base);
  if (options.scope) args.push("--scope", options.scope);
  if (options.cwd) args.push("--cwd", options.cwd);
  for (const p of positionals) args.push(p);
  return args;
}

function renderText(merged, claudeRaw, codexRaw) {
  const out = [];
  out.push("# Cross-vendor adversarial review");
  out.push("");
  out.push(`Vendors: claude-adv + codex-plugin-cc`);
  out.push(`Claude verdict: **${merged.claude_verdict ?? "?"}**`);
  out.push(`Codex verdict:  **${merged.codex_verdict ?? "?"}**`);
  out.push(`Consensus:      **${merged.consensus_verdict}**`);
  out.push("");
  out.push(
    `Findings: ${merged.agreement_count} agree, ${merged.site_overlap_count} same-site, ` +
      `${merged.claude_unique_count} claude-only, ${merged.codex_unique_count} codex-only`
  );
  if (merged.agreements.length > 0) {
    out.push("");
    out.push("## Both vendors raised");
    for (const a of merged.agreements) {
      out.push(
        `- **${a.merged_severity}** ${a.title}  (${a.file}:${a.line_start}, confidence ${a.merged_confidence})`
      );
    }
  }
  if (merged.site_overlaps.length > 0) {
    out.push("");
    out.push("## Same site, different framing");
    for (const o of merged.site_overlaps) {
      out.push(`- ${o.file}:${o.claude_view.line_start} (Δ${o.line_delta} lines)  `);
      out.push(`    claude (${o.claude_view.severity}): ${o.claude_view.title}`);
      out.push(`    codex  (${o.codex_view.severity}): ${o.codex_view.title}`);
    }
  }
  if (merged.claude_unique.length > 0) {
    out.push("");
    out.push("## Claude-only findings (codex missed)");
    for (const f of merged.claude_unique) {
      out.push(`- **${f.severity}** ${f.title}  (${f.file}:${f.line_start})`);
    }
  }
  if (merged.codex_unique.length > 0) {
    out.push("");
    out.push("## Codex-only findings (claude missed)");
    for (const f of merged.codex_unique) {
      out.push(`- **${f.severity}** ${f.title}  (${f.file}:${f.line_start})`);
    }
  }
  out.push("");
  const cost = (claudeRaw?.claude?.costUsd ?? 0) + (codexRaw?.claude?.costUsd ?? 0);
  if (cost > 0) {
    out.push(`Total cost: $${cost.toFixed(4)}`);
  }
  return out.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["base", "scope", "cwd"],
    booleanOptions: ["json", "skip-setup-check"],
  });

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const codexCompanion = resolveCodexCompanion();

  if (!options["skip-setup-check"]) {
    process.stderr.write("Checking vendor readiness...\n");
    await Promise.all([
      ensureVendorReady(CLAUDE_COMPANION, "claude-adv", cwd),
      ensureVendorReady(codexCompanion, "codex-plugin-cc", cwd),
    ]);
  }

  const reviewArgs = buildReviewArgs(options, positionals);
  process.stderr.write(
    `Spawning parallel reviews: claude-adv + codex-plugin-cc (base=${options.base ?? "auto"} scope=${options.scope ?? "auto"})\n`
  );
  const t0 = Date.now();
  const [claudeResult, codexResult] = await Promise.all([
    spawnCollectingJson(CLAUDE_COMPANION, reviewArgs, cwd),
    spawnCollectingJson(codexCompanion, reviewArgs, cwd),
  ]);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  process.stderr.write(`Both reviews finished in ${elapsed}s\n`);

  if (!claudeResult.ok) {
    process.stderr.write(`claude-adv review failed (exit ${claudeResult.exitCode})\n`);
    if (claudeResult.parseError)
      process.stderr.write(`  parse error: ${claudeResult.parseError}\n`);
    if (claudeResult.stderr) process.stderr.write(`  stderr: ${claudeResult.stderr}\n`);
    process.exit(2);
  }
  if (!codexResult.ok) {
    process.stderr.write(`codex review failed (exit ${codexResult.exitCode})\n`);
    if (codexResult.parseError) process.stderr.write(`  parse error: ${codexResult.parseError}\n`);
    if (codexResult.stderr) process.stderr.write(`  stderr: ${codexResult.stderr}\n`);
    process.exit(2);
  }

  const claudeOutput = claudeResult.parsed.review_output;
  const codexOutput = codexResult.parsed.review_output;
  const merged = mergeCrossVendor(claudeOutput, codexOutput);

  // Include raw vendor payloads alongside merged for forensic analysis.
  const fullPayload = {
    ...merged,
    elapsed_seconds: Number(elapsed),
    raw: {
      claude: claudeResult.parsed,
      codex: codexResult.parsed,
    },
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(fullPayload, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderText(merged, claudeResult.parsed, codexResult.parsed)}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`cross-vendor-review: ${err.message}\n`);
  process.exit(1);
});
