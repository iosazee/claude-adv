import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
const MAX_UNTRACKED_COMBINED_BYTES = 64 * 1024;
// Inline-diff safety is enforced by byte caps only. A previous design also
// applied a file-count cap (DEFAULT_INLINE_DIFF_MAX_FILES = 2 with callers
// bumping to 25), but that fired independently of byte size — a 47-file
// 200KB diff would be dropped to "self-collect" mode even though the bytes
// fit fine. The reviewer cannot self-collect (locked `--tools ""`), which
// produced paper approvals. Byte caps are the authoritative measure; file
// count is irrelevant to model context size or correctness.
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;
const DEFAULT_INLINE_DIFF_MAX_FILE_BYTES = 64 * 1024;

function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options });
}

function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function normalizeMaxInlineFileDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_FILE_BYTES;
  }
  return Math.floor(parsed);
}

function collectGitOutputWithinBytes(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    return { bytes: maxBytes + 1, stdout: "" };
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return { bytes: Buffer.byteLength(result.stdout, "utf8"), stdout: result.stdout };
}

function collectCombinedGitOutputWithinBytes(cwd, argSets, maxBytes) {
  let totalBytes = 0;
  const outputs = [];
  for (const args of argSets) {
    const remainingBytes = maxBytes - totalBytes;
    if (remainingBytes < 0) {
      return { bytes: maxBytes + 1, stdout: outputs.join("\n") };
    }
    const result = collectGitOutputWithinBytes(cwd, args, remainingBytes);
    totalBytes += result.bytes;
    outputs.push(result.stdout);
    if (totalBytes > maxBytes) {
      return { bytes: totalBytes, stdout: outputs.join("\n") };
    }
  }
  return { bytes: totalBytes, stdout: outputs.join("\n") };
}

function maxDiffSectionBytes(diffText) {
  let maxBytes = 0;
  for (const section of diffText.split(/(?=^diff --git )/m)) {
    if (!section.trim()) {
      continue;
    }
    maxBytes = Math.max(maxBytes, Buffer.byteLength(section, "utf8"));
  }
  return maxBytes;
}

function buildBranchComparison(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  return {
    mergeBase,
    commitRange: `${mergeBase}..HEAD`,
    reviewRange: `${baseRef}...HEAD`,
  };
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${candidate}`,
    ]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error(
    "Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree."
  );
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"])
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"])
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"])
    .stdout.trim()
    .split("\n")
    .filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0,
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true,
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true,
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true,
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false,
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false,
  };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

function formatUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (stat.isDirectory()) {
    return `### ${relativePath}\n(skipped: directory)`;
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
  }

  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}\n(skipped: binary file)`;
  }

  return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
}

function formatUntrackedFilesList(cwd, untrackedFiles, maxCombinedBytes) {
  const parts = [];
  let totalBytes = 0;
  let skippedCount = 0;

  for (const file of untrackedFiles) {
    if (totalBytes > maxCombinedBytes) {
      skippedCount++;
      continue;
    }
    const formatted = formatUntrackedFile(cwd, file);
    const formattedBytes = Buffer.byteLength(formatted, "utf8");

    if (totalBytes + formattedBytes > maxCombinedBytes) {
      parts.push(`### ${file}\n(skipped: exceeds remaining untracked bytes limit)`);
      totalBytes += formattedBytes;
    } else {
      parts.push(formatted);
      totalBytes += formattedBytes;
    }
  }

  if (skippedCount > 0) {
    parts.push(
      `... and ${skippedCount} more untracked file(s) skipped due to cumulative size limit.`
    );
  }

  return parts.join("\n\n");
}

function collectWorkingTreeContext(cwd, state, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const status = gitChecked(cwd, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  const changedFiles = listUniqueFiles(state.staged, state.unstaged, state.untracked);
  const maxUntrackedCombinedBytes =
    options.maxUntrackedCombinedBytes ?? MAX_UNTRACKED_COMBINED_BYTES;

  let parts;
  if (includeDiff) {
    const stagedDiff = gitChecked(cwd, [
      "diff",
      "--cached",
      "--binary",
      "--no-ext-diff",
      "--submodule=diff",
    ]).stdout;
    const unstagedDiff = gitChecked(cwd, [
      "diff",
      "--binary",
      "--no-ext-diff",
      "--submodule=diff",
    ]).stdout;
    const untrackedBody = formatUntrackedFilesList(cwd, state.untracked, maxUntrackedCombinedBytes);
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff),
      formatSection("Untracked Files", untrackedBody),
    ];
  } else {
    const stagedStat = gitChecked(cwd, ["diff", "--shortstat", "--cached"]).stdout.trim();
    const unstagedStat = gitChecked(cwd, ["diff", "--shortstat"]).stdout.trim();
    const untrackedBody = formatUntrackedFilesList(cwd, state.untracked, maxUntrackedCombinedBytes);
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff Stat", stagedStat),
      formatSection("Unstaged Diff Stat", unstagedStat),
      formatSection("Changed Files", changedFiles.join("\n")),
      formatSection("Untracked Files", untrackedBody),
    ];
  }

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n"),
    changedFiles,
  };
}

function collectBranchContext(cwd, baseRef, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const comparison = options.comparison ?? buildBranchComparison(cwd, baseRef);
  const currentBranch = getCurrentBranch(cwd);
  const changedFiles = gitChecked(cwd, ["diff", "--name-only", comparison.commitRange])
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
  const logOutput = gitChecked(cwd, [
    "log",
    "--oneline",
    "--decorate",
    comparison.commitRange,
  ]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", comparison.commitRange]).stdout.trim();

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content: includeDiff
      ? [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection(
            "Branch Diff",
            gitChecked(cwd, [
              "diff",
              "--binary",
              "--no-ext-diff",
              "--submodule=diff",
              comparison.commitRange,
            ]).stdout
          ),
        ].join("\n")
      : [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection("Changed Files", changedFiles.join("\n")),
        ].join("\n"),
    changedFiles,
    comparison,
  };
}

function buildAdversarialCollectionGuidance(options = {}) {
  if (options.includeDiff !== false) {
    return "Use the repository context below as primary evidence.";
  }

  // self-collect mode: the diff exceeded byte caps and could not be inlined.
  // The reviewer subprocess runs with `--tools ""` and CANNOT fetch the diff
  // itself — so any verdict it produces is based on file list/stats alone,
  // which is not a real review. Instruct it to refuse rather than render a
  // paper approval. The runtime also enforces this server-side as a
  // safeguard (see _shared-review.mjs paper-approve detection).
  return [
    "The repository context below contains ONLY a file list and stats; the actual diff content was not inlined because it exceeded inline byte caps.",
    'You have `--tools ""` and CANNOT fetch the diff yourself.',
    "Therefore: do NOT render a paper review based on file names alone.",
    'Return `verdict: "needs-attention"` with a single finding describing the diff-too-large condition:',
    '  severity: "high"',
    '  title: "Diff exceeded inline byte caps — adversarial review could not see the implementation"',
    '  recommendation: "Re-run claude-adv on a smaller, scoped subset of the changes (narrow --base, or per-commit), OR raise the inline byte caps via --max-inline-bytes / --max-inline-file-bytes (defaults 262144 / 65536), OR review by hand."',
    "Do not invent findings about code you didn't see. Do not approve.",
  ].join("\n");
}

/**
 * Collect review context for reviewer subprocesses. Reviewers run without
 * repository tools, so diffs are inlined whenever they fit the byte caps:
 * 256 KiB total diff text and 64 KiB per-file diff text. File count is
 * NOT a cap — a 50-file 200KB diff inlines fine, but a 2-file 400KB diff
 * doesn't. When either byte cap is exceeded, `inputMode` becomes
 * "self-collect" and the reviewer is instructed to refuse the verdict with
 * a needs-attention finding (since it cannot fetch the diff itself with
 * locked `--tools ""`); the runtime also refuses paper approvals from the
 * self-collect path as belt-and-suspenders.
 */
export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const currentBranch = getCurrentBranch(repoRoot);
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  const maxInlineFileDiffBytes = normalizeMaxInlineFileDiffBytes(options.maxInlineFileDiffBytes);
  let details;
  let includeDiff;
  let diffBytes;

  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot);
    const diffMeasurement = collectCombinedGitOutputWithinBytes(
      repoRoot,
      [
        ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"],
        ["diff", "--binary", "--no-ext-diff", "--submodule=diff"],
      ],
      maxInlineDiffBytes
    );
    diffBytes = diffMeasurement.bytes;
    const maxFileDiffBytes =
      diffBytes > maxInlineDiffBytes
        ? maxInlineFileDiffBytes + 1
        : maxDiffSectionBytes(diffMeasurement.stdout);
    includeDiff =
      options.includeDiff ??
      (diffBytes <= maxInlineDiffBytes && maxFileDiffBytes <= maxInlineFileDiffBytes);
    details = collectWorkingTreeContext(repoRoot, state, {
      includeDiff,
      maxUntrackedCombinedBytes: options.maxUntrackedCombinedBytes,
    });
  } else {
    const comparison = buildBranchComparison(repoRoot, target.baseRef);
    const diffMeasurement = collectGitOutputWithinBytes(
      repoRoot,
      ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange],
      maxInlineDiffBytes
    );
    diffBytes = diffMeasurement.bytes;
    const maxFileDiffBytes =
      diffBytes > maxInlineDiffBytes
        ? maxInlineFileDiffBytes + 1
        : maxDiffSectionBytes(diffMeasurement.stdout);
    includeDiff =
      options.includeDiff ??
      (diffBytes <= maxInlineDiffBytes && maxFileDiffBytes <= maxInlineFileDiffBytes);
    details = collectBranchContext(repoRoot, target.baseRef, { includeDiff, comparison });
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: includeDiff ? "inline-diff" : "self-collect",
    collectionGuidance: buildAdversarialCollectionGuidance({ includeDiff }),
    ...details,
  };
}
