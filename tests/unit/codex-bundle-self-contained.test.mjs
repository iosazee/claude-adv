import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BUNDLE = path.join(ROOT, "plugins/claude-adv");
const MOCK_CLAUDE = path.join(ROOT, "tests/fixtures/mock-claude.sh");

function copyBundle() {
  const tmp = mkdtempSync(path.join(tmpdir(), "codex-bundle-"));
  cpSync(BUNDLE, path.join(tmp, "plugins/claude-adv"), { recursive: true });
  return tmp;
}

function makeRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "codex-bundle-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(path.join(repo, "sample.txt"), "before\n");
  return repo;
}

function makeToolPath() {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-bundle-tools-"));
  symlinkSync(process.execPath, path.join(dir, "node"));
  symlinkSync(MOCK_CLAUDE, path.join(dir, "claude"));
  return `${dir}:${process.env.PATH}`;
}

function mockReviewScript(summary = "bundle ok") {
  return JSON.stringify({
    events: [
      { type: "system", subtype: "init", session_id: "bundle-review" },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                verdict: "approve",
                summary,
                findings: [],
                next_steps: [],
              }),
            },
          ],
        },
      },
      { type: "result", subtype: "success", total_cost_usd: 0.01 },
    ],
    exitCode: 0,
  });
}

function mockTaskScript() {
  return JSON.stringify({
    events: [
      { type: "system", subtype: "init", session_id: "bundle-task" },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "bundle task ok" }] },
      },
      { type: "result", subtype: "success", total_cost_usd: 0.02 },
    ],
    exitCode: 0,
  });
}

function runAdapter(tmpRoot, args, options = {}) {
  const adapter = path.join(tmpRoot, "plugins/claude-adv/scripts/claude-adv-codex.mjs");
  return spawnSync(process.execPath, [adapter, ...args], {
    cwd: options.cwd ?? tmpRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "test-key",
      CODEX_HOME: options.codexHome ?? mkdtempSync(path.join(tmpdir(), "codex-bundle-home-")),
      MOCK_CLAUDE_ARGV_CAPTURE: options.argvCapture,
      MOCK_CLAUDE_SCRIPT: options.mockScript,
      PATH: options.pathValue ?? makeToolPath(),
      ...options.env,
    },
  });
}

function assertNoEnoentOutsideTmp(stderr, tmpRoot) {
  for (const line of stderr.split("\n")) {
    const match = line.match(/ENOENT[^']*'([^']+)'/);
    if (!match) continue;
    const file = match[1];
    assert.ok(
      file.startsWith(tmpRoot) || file.startsWith(tmpdir()),
      `ENOENT references a path outside the copied bundle: ${file}\nstderr: ${stderr}`
    );
  }
}

function capturedArgs(file) {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assertCapturedPathUnderTmp(captureFile, tmpRoot, leaf) {
  const values = capturedArgs(captureFile).flat();
  const realTmpRoot = realpathSync(tmpRoot);
  assert.ok(
    values.some(
      (value) =>
        typeof value === "string" &&
        (value.startsWith(tmpRoot) || value.startsWith(realTmpRoot)) &&
        value.endsWith(leaf)
    ),
    `expected captured argv path under ${tmpRoot} ending with ${leaf}; got ${JSON.stringify(values)}`
  );
}

test("setup --json works against a copied bundle", () => {
  const tmp = copyBundle();
  try {
    const result = runAdapter(tmp, ["setup", "--json"]);
    assert.equal(
      result.status,
      0,
      `setup failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
    assert.doesNotThrow(() => JSON.parse(result.stdout));
    assertNoEnoentOutsideTmp(result.stderr, tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

for (const [subcommand, promptLeaf] of [
  ["review", "prompts/review.md"],
  ["adversarial-review", "prompts/adversarial-review.md"],
]) {
  test(`${subcommand} --wait resolves prompt/schema assets from the copied bundle`, () => {
    const tmp = copyBundle();
    const repo = makeRepo();
    const captureFile = path.join(tmp, `${subcommand}-argv.jsonl`);
    try {
      writeFileSync(path.join(repo, "sample.txt"), `changed by ${subcommand}\n`);
      const result = runAdapter(tmp, [subcommand, "--wait", "--scope", "working-tree"], {
        argvCapture: captureFile,
        cwd: repo,
        mockScript: mockReviewScript(`${subcommand} ok`),
      });
      assert.equal(
        result.status,
        0,
        `${subcommand} failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
      );
      assert.match(result.stdout, /Verdict: \*\*approve\*\*/);
      assertNoEnoentOutsideTmp(result.stderr, tmp);
      assertCapturedPathUnderTmp(captureFile, tmp, promptLeaf);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
}

test("task resolves the rescue prompt from the copied bundle", () => {
  const tmp = copyBundle();
  const repo = makeRepo();
  const captureFile = path.join(tmp, "task-argv.jsonl");
  try {
    const result = runAdapter(tmp, ["task", "--cwd", repo, "repair the sample"], {
      argvCapture: captureFile,
      cwd: repo,
      mockScript: mockTaskScript(),
    });
    assert.equal(
      result.status,
      0,
      `task failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
    assert.match(result.stdout, /bundle task ok/);
    assertNoEnoentOutsideTmp(result.stderr, tmp);
    assertCapturedPathUnderTmp(captureFile, tmp, "prompts/rescue.md");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
