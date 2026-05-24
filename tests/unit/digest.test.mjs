// tests/unit/digest.test.mjs
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeDigest, isAncestor, lastReviewedIsUsable } from "../../scripts/lib/digest.mjs";

function git(args, cwd) {
  return execSync(`git ${args}`, { cwd, encoding: "utf8" }).trim();
}
function setupRepo() {
  const dir = mkdtempSync(join(tmpdir(), "claude-adv-digest-"));
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "t@t" && git config user.name t', {
    cwd: dir,
    shell: "/bin/bash",
  });
  return dir;
}
function commit(dir, msg) {
  execSync(`git add -A && git commit -q -m "${msg}"`, { cwd: dir, shell: "/bin/bash" });
}

test("digest is stable for an identical worktree state", () => {
  const dir = setupRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "hello\n");
    commit(dir, "initial");
    const d1 = computeDigest(dir);
    const d2 = computeDigest(dir);
    assert.equal(d1.digest, d2.digest);
    assert.match(d1.digest, /^sha256:[a-f0-9]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("digest changes when an untracked file is added", () => {
  const dir = setupRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "hello\n");
    commit(dir, "initial");
    const before = computeDigest(dir).digest;
    writeFileSync(join(dir, "new.txt"), "untracked\n");
    const after = computeDigest(dir).digest;
    assert.notEqual(before, after);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("digest changes when a tracked file is deleted (unstaged)", () => {
  const dir = setupRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "hello\n");
    commit(dir, "initial");
    const before = computeDigest(dir).digest;
    unlinkSync(join(dir, "a.txt"));
    const after = computeDigest(dir).digest;
    assert.notEqual(before, after);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("digest changes when a file mode flips (chmod-only)", () => {
  const dir = setupRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "hello\n");
    commit(dir, "initial");
    const before = computeDigest(dir).digest;
    chmodSync(join(dir, "a.txt"), 0o755);
    const after = computeDigest(dir).digest;
    assert.notEqual(before, after);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("digest changes when a symlink retargets", () => {
  const dir = setupRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "hello\n");
    symlinkSync("a.txt", join(dir, "link"));
    commit(dir, "initial");
    const before = computeDigest(dir).digest;
    unlinkSync(join(dir, "link"));
    writeFileSync(join(dir, "b.txt"), "world\n");
    symlinkSync("b.txt", join(dir, "link"));
    const after = computeDigest(dir).digest;
    assert.notEqual(before, after);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("digest handles unborn HEAD (no commits yet) without throwing", () => {
  const dir = setupRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "hello\n");
    const result = computeDigest(dir);
    assert.equal(result.head, "unborn");
    assert.match(result.digest, /^sha256:[a-f0-9]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("digest handles unmerged index after merge conflict", () => {
  const dir = setupRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "v1\n");
    commit(dir, "v1");
    execSync("git checkout -q -b feature", { cwd: dir });
    writeFileSync(join(dir, "a.txt"), "feature\n");
    commit(dir, "feature");
    execSync("git checkout -q main || git checkout -q master", { cwd: dir, shell: "/bin/bash" });
    writeFileSync(join(dir, "a.txt"), "main\n");
    commit(dir, "main");
    let merged = true;
    try {
      execSync("git merge --no-commit -q feature", { cwd: dir });
    } catch {
      merged = false;
    }
    assert.equal(merged, false, "merge should fail with conflict");
    const result = computeDigest(dir);
    assert.equal(result.indexTree, "unmerged");
    assert.match(result.digest, /^sha256:[a-f0-9]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isAncestor returns false for unrelated commits", () => {
  const dir = setupRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "1\n");
    commit(dir, "first");
    const head1 = git("rev-parse HEAD", dir);
    execSync("git checkout -q --orphan branch2", { cwd: dir });
    execSync("git rm -rf --quiet .", { cwd: dir });
    writeFileSync(join(dir, "b.txt"), "2\n");
    commit(dir, "orphan");
    const head2 = git("rev-parse HEAD", dir);
    assert.equal(isAncestor(dir, head1, head2), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lastReviewedIsUsable rejects missing-file baseline", () => {
  const dir = setupRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "x\n");
    commit(dir, "init");
    const result = lastReviewedIsUsable(dir, null);
    assert.equal(result.usable, false);
    assert.equal(result.reason, "missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
