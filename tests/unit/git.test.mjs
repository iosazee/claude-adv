import { test, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectReviewContext,
  ensureGitRepository,
  resolveReviewTarget,
} from "../../scripts/lib/git.mjs";

let repo;

before(() => {
  repo = mkdtempSync(join(tmpdir(), "claude-adv-git-test-"));
  execSync("git init -q", { cwd: repo });
  execSync("git config user.email test@example.com && git config user.name test", {
    cwd: repo,
    shell: "/bin/bash",
  });
  writeFileSync(join(repo, "README.md"), "initial\n");
  execSync("git add . && git commit -q -m initial", { cwd: repo, shell: "/bin/bash" });
});

after(() => {
  rmSync(repo, { recursive: true, force: true });
});

test("git.ensureGitRepository throws on non-repo", () => {
  assert.throws(() => ensureGitRepository(tmpdir()));
});

test("git.ensureGitRepository succeeds on a real repo", () => {
  assert.doesNotThrow(() => ensureGitRepository(repo));
});

test("git.resolveReviewTarget auto-mode returns a target with a label", () => {
  writeFileSync(join(repo, "drift.txt"), "drift\n");
  const target = resolveReviewTarget(repo, { scope: "working-tree" });
  assert.ok(target.label, "target.label is set");
  assert.equal(target.mode, "working-tree");
});

// File-count cap was removed 2026-05-16. Inline-diff is now bounded only by
// byte caps. A many-file diff that fits in bytes must inline regardless of
// file count — the previous behavior produced paper approvals for diffs
// like 47 files / 200KB which fit easily but exceeded the old 25-file cap.
test("git.collectReviewContext inlines many-file diffs when total bytes fit (no file-count cap)", () => {
  const tempRepo = mkdtempSync(join(tmpdir(), "claude-adv-git-inline-many-"));
  try {
    execSync("git init -q", { cwd: tempRepo });
    execSync("git config user.email test@example.com && git config user.name test", {
      cwd: tempRepo,
      shell: "/bin/bash",
    });
    // 30 small files — well above the old 25-file cap, well below byte caps.
    for (let i = 0; i < 30; i++) {
      writeFileSync(join(tempRepo, `f${i}.txt`), "old\n");
    }
    execSync("git add . && git commit -q -m initial", { cwd: tempRepo, shell: "/bin/bash" });
    for (let i = 0; i < 30; i++) {
      writeFileSync(join(tempRepo, `f${i}.txt`), "new\n");
    }

    const target = resolveReviewTarget(tempRepo, { scope: "working-tree" });
    const context = collectReviewContext(tempRepo, target);

    assert.equal(context.inputMode, "inline-diff");
    assert.match(context.content, /diff --git a\/f0\.txt b\/f0\.txt/);
    assert.match(context.content, /diff --git a\/f29\.txt b\/f29\.txt/);
  } finally {
    rmSync(tempRepo, { recursive: true, force: true });
  }
});

test("git.collectReviewContext ignores legacy maxInlineFiles option (cap removed)", () => {
  // Callers in the wild may still pass maxInlineFiles for a while. The option
  // is silently ignored — only byte caps decide. Verify a caller passing
  // maxInlineFiles:2 still inlines a 3-file diff if bytes fit.
  const tempRepo = mkdtempSync(join(tmpdir(), "claude-adv-git-inline-legacy-opt-"));
  try {
    execSync("git init -q", { cwd: tempRepo });
    execSync("git config user.email test@example.com && git config user.name test", {
      cwd: tempRepo,
      shell: "/bin/bash",
    });
    for (const file of ["a.txt", "b.txt", "c.txt"]) {
      writeFileSync(join(tempRepo, file), "old\n");
    }
    execSync("git add . && git commit -q -m initial", { cwd: tempRepo, shell: "/bin/bash" });
    for (const file of ["a.txt", "b.txt", "c.txt"]) {
      writeFileSync(join(tempRepo, file), "new\n");
    }

    const target = resolveReviewTarget(tempRepo, { scope: "working-tree" });
    const context = collectReviewContext(tempRepo, target, { maxInlineFiles: 2 });

    assert.equal(context.inputMode, "inline-diff", "legacy maxInlineFiles option must be ignored");
  } finally {
    rmSync(tempRepo, { recursive: true, force: true });
  }
});

test("git.collectReviewContext keeps byte cap authoritative when many files are under file cap", () => {
  const tempRepo = mkdtempSync(join(tmpdir(), "claude-adv-git-inline-bytecap-"));
  try {
    execSync("git init -q", { cwd: tempRepo });
    execSync("git config user.email test@example.com && git config user.name test", {
      cwd: tempRepo,
      shell: "/bin/bash",
    });
    for (const file of ["a.txt", "b.txt", "c.txt"]) {
      writeFileSync(join(tempRepo, file), "old\n");
    }
    execSync("git add . && git commit -q -m initial", { cwd: tempRepo, shell: "/bin/bash" });
    for (const file of ["a.txt", "b.txt", "c.txt"]) {
      writeFileSync(join(tempRepo, file), "new\n");
    }

    const target = resolveReviewTarget(tempRepo, { scope: "working-tree" });
    const context = collectReviewContext(tempRepo, target, {
      maxInlineDiffBytes: 16,
    });

    assert.equal(context.inputMode, "self-collect");
    assert.doesNotMatch(context.content, /diff --git/);
    assert.match(context.content, /Changed Files/);
  } finally {
    rmSync(tempRepo, { recursive: true, force: true });
  }
});

test("git.collectReviewContext keeps total byte cap authoritative near default file cap", () => {
  const tempRepo = mkdtempSync(join(tmpdir(), "claude-adv-git-inline-many-bytecap-"));
  try {
    execSync("git init -q", { cwd: tempRepo });
    execSync("git config user.email test@example.com && git config user.name test", {
      cwd: tempRepo,
      shell: "/bin/bash",
    });
    for (let index = 0; index < 24; index += 1) {
      writeFileSync(join(tempRepo, `file-${index}.txt`), "old\n");
    }
    execSync("git add . && git commit -q -m initial", { cwd: tempRepo, shell: "/bin/bash" });
    for (let index = 0; index < 24; index += 1) {
      writeFileSync(join(tempRepo, `file-${index}.txt`), "new\n");
    }

    const target = resolveReviewTarget(tempRepo, { scope: "working-tree" });
    const context = collectReviewContext(tempRepo, target, {
      maxInlineDiffBytes: 512,
    });

    assert.equal(context.inputMode, "self-collect");
    assert.doesNotMatch(context.content, /diff --git/);
    assert.match(context.content, /Changed Files/);
  } finally {
    rmSync(tempRepo, { recursive: true, force: true });
  }
});

test("git.collectReviewContext keeps per-file byte cap authoritative", () => {
  const tempRepo = mkdtempSync(join(tmpdir(), "claude-adv-git-inline-filebytecap-"));
  try {
    execSync("git init -q", { cwd: tempRepo });
    execSync("git config user.email test@example.com && git config user.name test", {
      cwd: tempRepo,
      shell: "/bin/bash",
    });
    writeFileSync(join(tempRepo, "large.txt"), `${"old\n".repeat(40)}`);
    execSync("git add . && git commit -q -m initial", { cwd: tempRepo, shell: "/bin/bash" });
    writeFileSync(join(tempRepo, "large.txt"), `${"new\n".repeat(40)}`);

    const target = resolveReviewTarget(tempRepo, { scope: "working-tree" });
    const context = collectReviewContext(tempRepo, target, {
      maxInlineDiffBytes: 64 * 1024,
      maxInlineFileDiffBytes: 64,
    });

    assert.equal(context.inputMode, "self-collect");
    assert.doesNotMatch(context.content, /diff --git/);
    assert.match(context.content, /Changed Files/);
  } finally {
    rmSync(tempRepo, { recursive: true, force: true });
  }
});

test("git.collectReviewContext applies cumulative untracked files cap", () => {
  const tempRepo = mkdtempSync(join(tmpdir(), "claude-adv-git-untracked-cap-"));
  try {
    execSync("git init -q", { cwd: tempRepo });
    execSync("git config user.email test@example.com && git config user.name test", {
      cwd: tempRepo,
      shell: "/bin/bash",
    });
    // Create three untracked files of small size
    writeFileSync(join(tempRepo, "u1.txt"), "hello world 1\n");
    writeFileSync(join(tempRepo, "u2.txt"), "hello world 2\n");
    writeFileSync(join(tempRepo, "u3.txt"), "hello world 3\n");

    const target = resolveReviewTarget(tempRepo, { scope: "working-tree" });

    // With a low cap (e.g. 60 bytes), at least one file should be skipped.
    const context = collectReviewContext(tempRepo, target, {
      maxUntrackedCombinedBytes: 60,
    });

    assert.match(
      context.content,
      /exceeds remaining untracked bytes limit|skipped due to cumulative size limit/
    );
  } finally {
    rmSync(tempRepo, { recursive: true, force: true });
  }
});
