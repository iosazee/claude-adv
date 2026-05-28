import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const ADAPTER = path.join(ROOT, "plugins/claude-adv/scripts/claude-adv-codex.mjs");
const COMPANION = path.join(ROOT, "plugins/claude-adv/scripts/claude-companion.mjs");
const SUBCOMMANDS = ["review", "adversarial-review", "task", "setup", "status", "result", "cancel"];
const WAIT_HINT_SUBCOMMANDS = new Set(["review", "adversarial-review", "task"]);
const NO_BACKGROUND_SUBCOMMANDS = new Set(["setup", "status", "result", "cancel"]);
const REJECTED_VARIANTS = [
  ["--background"],
  ["--background=true"],
  ["--background=1"],
  ["--background=yes"],
  ["--background=FALSE"],
  ["--background", "true"],
  ["--background", "main"],
  ["--background --base main"],
];
const NOT_REJECTED_VARIANTS = [
  ["--background=false"],
  ["--background", "false"],
  ["--", "--background"],
];

function makeCodexHome() {
  return mkdtempSync(path.join(tmpdir(), "claude-adv-background-codex-home-"));
}

function makeHomeWithCodex() {
  const home = mkdtempSync(path.join(tmpdir(), "claude-adv-background-home-"));
  mkdirSync(path.join(home, ".codex"));
  return home;
}

function makeCaptureImport() {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-adv-background-capture-"));
  const file = path.join(dir, "capture.mjs");
  const log = path.join(dir, "capture.jsonl");
  writeFileSync(
    file,
    `import { appendFileSync } from "node:fs";
import path from "node:path";
appendFileSync(process.env.CAPTURE_FILE, JSON.stringify({
  argv: process.argv,
  cwd: process.cwd()
}) + "\\n");
if (
  process.env.CAPTURE_EXIT_COMPANION &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(process.env.CAPTURE_COMPANION)
) {
  process.exit(Number(process.env.CAPTURE_EXIT_COMPANION));
}
`
  );
  return { file, log };
}

function runAdapter(args, options = {}) {
  const capture = makeCaptureImport();
  const nodeOptions = `${process.env.NODE_OPTIONS ?? ""} --import=${capture.file}`.trim();
  const result = spawnSync(process.execPath, [ADAPTER, ...args], {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_HOME: options.codexHome ?? makeCodexHome(),
      HOME: options.home ?? makeHomeWithCodex(),
      CAPTURE_COMPANION: COMPANION,
      CAPTURE_EXIT_COMPANION: "42",
      CAPTURE_FILE: capture.log,
      NODE_OPTIONS: nodeOptions,
      ...options.env,
    },
  });
  const records = readFileSync(capture.log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { result, records };
}

function companionRecord(records) {
  return records.find((record) => record.argv[1] && path.resolve(record.argv[1]) === COMPANION);
}

function expectedBackgroundMessage(subcommand) {
  if (WAIT_HINT_SUBCOMMANDS.has(subcommand)) {
    return `Codex: --background is not supported for ${subcommand}; rerun with --wait`;
  }
  if (NO_BACKGROUND_SUBCOMMANDS.has(subcommand)) {
    return `Codex: --background is not a supported flag for ${subcommand}; rerun without it`;
  }
  return `Codex: --background is not supported for ${subcommand}`;
}

test("codex adapter rejects every parser-enabled background request before delegation", () => {
  for (const subcommand of SUBCOMMANDS) {
    for (const variant of REJECTED_VARIANTS) {
      const { result, records } = runAdapter([subcommand, ...variant]);
      const label = `${subcommand} ${variant.join(" ")}`;

      assert.notEqual(result.status, 0, label);
      assert.match(result.stderr, new RegExp(expectedBackgroundMessage(subcommand)), label);
      assert.equal(companionRecord(records), undefined, label);
    }
  }
});

test("codex adapter delegates parser-disabled background-looking requests", () => {
  for (const subcommand of SUBCOMMANDS) {
    for (const variant of NOT_REJECTED_VARIANTS) {
      const { result, records } = runAdapter([subcommand, ...variant]);
      const label = `${subcommand} ${variant.join(" ")}`;

      assert.equal(result.status, 42, label);
      assert.doesNotMatch(result.stderr, /--background is/, label);
      assert.ok(companionRecord(records), label);
    }
  }
});

test("codex adapter requires the subcommand as argv[0] before background checks", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "claude-adv-background-cwd-"));
  const { result, records } = runAdapter(["--cwd", cwd, "review", "--background"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected a subcommand as the first argument/);
  assert.doesNotMatch(result.stderr, /--background is/);
  assert.equal(companionRecord(records), undefined);
});

test("codex adapter rejects unknown future subcommands with background before delegation", () => {
  const { result, records } = runAdapter(["foo", "--background"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(expectedBackgroundMessage("foo")));
  assert.doesNotMatch(result.stderr, /Unknown subcommand/);
  assert.equal(companionRecord(records), undefined);
});
