// scripts/lib/digest.mjs — review-state digest for the stop-gate baseline.
// Digest = sha256 over HEAD + index-tree + sorted porcelain-v2 records.

import { spawnSync } from "node:child_process";
import { readFileSync, readlinkSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function git(cwd, args, opts = {}) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: opts.encoding ?? "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function hashFileBytes(absPath) {
  const stat = lstatSync(absPath);
  if (stat.isSymbolicLink()) {
    // sha256("symlink:" || readlink_target)
    return sha256Hex(Buffer.from("symlink:" + readlinkSync(absPath)));
  }
  if (stat.isDirectory()) {
    // sha256("dir")
    return sha256Hex(Buffer.from("dir"));
  }
  return sha256Hex(readFileSync(absPath));
}

function submoduleHead(repoRoot, submodulePath) {
  const r = spawnSync("git", ["-C", join(repoRoot, submodulePath), "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  return r.status === 0 ? r.stdout.trim() : "submodule-inaccessible";
}

// Parse `git status --porcelain=v2 -z` output. The format is described in
// `git status --help`. We split on NUL and emit normalized records.
function parsePorcelainV2(stdout, repoRoot) {
  const records = [];
  // Split by NUL but be aware: rename records (type "2") span two NUL-terminated
  // pieces (old path then new). We use --no-renames so this won't occur, but
  // accept it defensively.
  const raw = stdout.split("\0");
  let i = 0;
  while (i < raw.length) {
    const line = raw[i];
    if (!line) {
      i++;
      continue;
    }
    const type = line[0];
    if (type === "1") {
      // Format: "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>"
      const parts = line.split(" ");
      const xy = parts[1];
      const mH = parts[3],
        mI = parts[4],
        mW = parts[5];
      const hH = parts[6],
        hI = parts[7];
      const path = parts.slice(8).join(" ");
      let worktreeHash = "NULL";
      // Submodule detection: porcelain-v2 mode-worktree of "160000" means gitlink.
      if (mW === "160000") {
        worktreeHash = submoduleHead(repoRoot, path);
      } else {
        try {
          worktreeHash = hashFileBytes(join(repoRoot, path));
        } catch {
          worktreeHash = "NULL";
        }
      }
      records.push(`1\t${xy}\t${mH}\t${mI}\t${mW}\t${hH}\t${hI}\t${path}\t${worktreeHash}`);
      i++;
    } else if (type === "2") {
      // Spec: normalize type-2 (rename/copy) identically to type-1.
      // Format: "2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>"
      // Even with --no-renames, accept defensively and emit a `1`-shaped record.
      const parts = line.split(" ");
      const xy = parts[1];
      const mH = parts[3],
        mI = parts[4],
        mW = parts[5];
      const hH = parts[6],
        hI = parts[7];
      const path = parts.slice(9).join(" ");
      let worktreeHash = "NULL";
      try {
        worktreeHash = hashFileBytes(join(repoRoot, path));
      } catch {
        /* */
      }
      records.push(`1\t${xy}\t${mH}\t${mI}\t${mW}\t${hH}\t${hI}\t${path}\t${worktreeHash}`);
      i++;
      // Skip the original-path NUL piece if present.
      if (i < raw.length && raw[i] && !"12u?!".includes(raw[i][0])) i++;
    } else if (type === "u") {
      // Spec: unmerged records carry full metadata.
      // Format: "u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>"
      const parts = line.split(" ");
      const xy = parts[1];
      const m1 = parts[3],
        m2 = parts[4],
        m3 = parts[5],
        mW = parts[6];
      const h1 = parts[7],
        h2 = parts[8],
        h3 = parts[9];
      const path = parts.slice(10).join(" ");
      records.push(`u\t${xy}\t${m1}\t${m2}\t${m3}\t${mW}\t${h1}\t${h2}\t${h3}\t${path}`);
      i++;
    } else if (type === "?") {
      const path = line.slice(2);
      let hash = "NULL";
      try {
        hash = hashFileBytes(join(repoRoot, path));
      } catch {
        /* unreadable */
      }
      records.push(`?\t${path}\t${hash}`);
      i++;
    } else if (type === "!") {
      // Ignored — skip.
      i++;
    } else {
      i++;
    }
  }
  return records;
}

export function computeDigest(repoRoot) {
  // Step 1: HEAD.
  let head;
  const rp = git(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  if (rp.status === 0) {
    head = rp.stdout.trim();
  } else if (/ambiguous argument|unknown revision|Needed a single revision/.test(rp.stderr)) {
    head = "unborn";
  } else {
    throw new Error(`git rev-parse HEAD failed: ${rp.stderr.trim()}`);
  }

  // Step 2: index-tree (sentinel "unmerged" if write-tree fails on unmerged).
  let indexTree;
  const wt = git(repoRoot, ["write-tree"]);
  if (wt.status === 0) {
    indexTree = wt.stdout.trim();
  } else if (/unmerged/i.test(wt.stderr)) {
    indexTree = "unmerged";
  } else {
    throw new Error(`git write-tree failed: ${wt.stderr.trim()}`);
  }

  // Step 3: porcelain-v2 records (pinned flags for determinism).
  const statusResult = git(repoRoot, [
    "-c",
    "core.quotePath=false",
    "-c",
    "core.autocrlf=false",
    "status",
    "--porcelain=v2",
    "--untracked-files=all",
    "--no-renames",
    "-z",
    "--ignore-submodules=none",
  ]);
  if (statusResult.status !== 0) {
    throw new Error(`git status failed: ${statusResult.stderr.trim()}`);
  }
  const records = parsePorcelainV2(statusResult.stdout, repoRoot);

  // Step 4: if index was unmerged, append unmerged-stage records from ls-files.
  if (indexTree === "unmerged") {
    const lsu = git(repoRoot, ["ls-files", "-u", "-z"]);
    if (lsu.status === 0) {
      const lines = lsu.stdout.split("\0").filter(Boolean);
      for (const ln of lines) records.push(`u-stage\t${ln}`);
    }
  }

  // Step 5: sort and hash.
  records.sort();
  const composed = `${head}\n${indexTree}\n${records.join("\n")}`;
  return {
    digest: "sha256:" + sha256Hex(Buffer.from(composed, "utf8")),
    head,
    indexTree,
    records,
  };
}

export function isAncestor(repoRoot, maybeAncestor, descendant) {
  if (!maybeAncestor || maybeAncestor === "unborn") return false;
  const r = git(repoRoot, ["merge-base", "--is-ancestor", maybeAncestor, descendant]);
  return r.status === 0;
}

export function lastReviewedIsUsable(repoRoot, lastReviewed) {
  if (!lastReviewed) return { usable: false, reason: "missing" };
  if (typeof lastReviewed !== "object") return { usable: false, reason: "malformed" };
  if (!lastReviewed.head) return { usable: false, reason: "no-head" };
  if (!/^[a-f0-9]{40}([a-f0-9]{24})?$|^unborn$/.test(lastReviewed.head)) {
    return { usable: false, reason: "bad-head-shape" };
  }
  if (lastReviewed.head !== "unborn") {
    const exists = git(repoRoot, ["cat-file", "-e", lastReviewed.head]);
    if (exists.status !== 0) return { usable: false, reason: "head-gone" };
  }
  // Baseline validity: an indexTree captured during a
  // prior unmerged-index state is NOT reusable — route to ancestry break.
  if (lastReviewed.indexTree === "unmerged") {
    return { usable: false, reason: "unmerged-baseline" };
  }
  if (lastReviewed.indexTree) {
    const exists = git(repoRoot, ["cat-file", "-e", lastReviewed.indexTree]);
    if (exists.status !== 0) return { usable: false, reason: "tree-gone" };
  }
  return { usable: true };
}

export function getHeadTreeSha(repoRoot) {
  const r = git(repoRoot, ["rev-parse", "HEAD^{tree}"]);
  if (r.status !== 0) return null;
  return r.stdout.trim();
}

export function worktreeAndIndexClean(repoRoot) {
  const a = git(repoRoot, ["diff-index", "--quiet", "HEAD"]);
  const b = git(repoRoot, ["diff", "--quiet", "--cached"]);
  const c = git(repoRoot, ["ls-files", "--others", "--exclude-standard"]);
  return a.status === 0 && b.status === 0 && c.stdout.trim() === "";
}

export { EMPTY_TREE_SHA };
