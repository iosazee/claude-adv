import { strict as assert } from "node:assert";
import { execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { JOB_REFERENCE_ARG_CONFIG } from "../../scripts/lib/args.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const PLUGIN_ROOT = path.join(ROOT, "plugins/claude-adv");
const ADAPTER = path.join(ROOT, "plugins/claude-adv/scripts/claude-adv-codex.mjs");
const COMPANION = path.join(ROOT, "plugins/claude-adv/scripts/claude-companion.mjs");
const RESULT_HANDLER = path.join(ROOT, "scripts/companion-handlers/result.mjs");
const CANCEL_HANDLER = path.join(ROOT, "scripts/companion-handlers/cancel.mjs");

function makeRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-codex-adapter-repo-"));
  execSync("git init -q", { cwd: repo });
  return repo;
}

function makeCodexHome() {
  return mkdtempSync(path.join(tmpdir(), "claude-adv-codex-home-"));
}

function makeHomeWithCodex() {
  const home = mkdtempSync(path.join(tmpdir(), "claude-adv-codex-fallback-home-"));
  mkdirSync(path.join(home, ".codex"));
  return home;
}

function makeToolPath() {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-adv-codex-tools-"));
  symlinkSync(process.execPath, path.join(dir, "node"));
  writeFileSync(
    path.join(dir, "claude"),
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' "fake claude 1.0"
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ] && [ "$3" = "--json" ]; then
  printf '%s\\n' '{"logged_in":true,"auth_method":"test"}'
  exit 0
fi
printf '%s\\n' "unexpected claude args: $*" >&2
exit 2
`,
    { mode: 0o755 }
  );
  return `${dir}:${process.env.PATH}`;
}

function makeCaptureImport() {
  const file = path.join(
    mkdtempSync(path.join(tmpdir(), "claude-adv-codex-capture-")),
    "capture.mjs"
  );
  const log = path.join(
    mkdtempSync(path.join(tmpdir(), "claude-adv-codex-capture-log-")),
    "env.jsonl"
  );
  writeFileSync(
    file,
    `import { appendFileSync } from "node:fs";
const keys = [
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_PLUGIN_DATA",
  "CODEX_PLUGIN_DATA",
  "CLAUDE_ADV_SESSION_ID",
  "CLAUDE_ADV_WARN_CROSS_SESSION",
  "CLAUDE_SESSION_ID"
];
const env = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
appendFileSync(process.env.CAPTURE_FILE, JSON.stringify({
  argv: process.argv,
  cwd: process.cwd(),
  env
}) + "\\n");
`
  );
  return { file, log };
}

function runAdapter(args, options = {}) {
  const env = {
    ...process.env,
    PATH: options.pathValue ?? makeToolPath(),
    CODEX_HOME: options.codexHome ?? makeCodexHome(),
    HOME: options.home ?? makeHomeWithCodex(),
    ...options.env,
  };
  return spawnSync(process.execPath, [ADAPTER, ...args], {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    env,
  });
}

function runAdapterWithCapture(args, options = {}) {
  const capture = makeCaptureImport();
  const nodeOptions = `${process.env.NODE_OPTIONS ?? ""} --import=${capture.file}`.trim();
  const result = runAdapter(args, {
    ...options,
    env: {
      ...options.env,
      CAPTURE_FILE: capture.log,
      NODE_OPTIONS: nodeOptions,
    },
  });
  const records = existsSync(capture.log)
    ? readFileSync(capture.log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  return { result, records };
}

function companionRecord(records) {
  return records.find((record) => record.argv[1] && path.resolve(record.argv[1]) === COMPANION);
}

function readOnlyStateFile(codexHome) {
  const stateRoot = path.join(realpathSync(codexHome), "state", "claude-adv", "state");
  const [workspaceDir] = readdirSync(stateRoot);
  return path.join(stateRoot, workspaceDir, "state.json");
}

test("codex adapter delegates setup, preserves cwd, and writes state under CODEX_HOME", () => {
  const repo = makeRepo();
  const codexHome = makeCodexHome();
  const { result, records } = runAdapterWithCapture(["setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    codexHome,
    env: {
      CLAUDE_PLUGIN_DATA: "/tmp/divergent",
      CODEX_PLUGIN_DATA: "/tmp/ignored",
      CODEX_THREAD_ID: "",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).config.stopReviewGate, true);
  const companion = companionRecord(records);
  assert.ok(companion, "expected delegated companion process to be captured");
  assert.equal(realpathSync(companion.cwd), realpathSync(repo));
  assert.equal(companion.env.CLAUDE_PLUGIN_ROOT, PLUGIN_ROOT);
  assert.equal(
    companion.env.CLAUDE_PLUGIN_DATA,
    path.join(realpathSync(codexHome), "state", "claude-adv")
  );
  assert.equal(companion.env.CODEX_PLUGIN_DATA, undefined);
  assert.equal(companion.env.CLAUDE_ADV_SESSION_ID, undefined);
  assert.equal(companion.env.CLAUDE_ADV_WARN_CROSS_SESSION, undefined);
  assert.equal(companion.env.CLAUDE_SESSION_ID, undefined);

  const state = JSON.parse(readFileSync(readOnlyStateFile(codexHome), "utf8"));
  assert.equal(state.config.stopReviewGate, true);
});

test("codex adapter preserves delegated stdout, stderr, and exit code", () => {
  const result = runAdapter(["not-a-command"]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Unknown subcommand: not-a-command/);
});

test("codex adapter fails closed when CODEX_HOME and fallback are unusable", () => {
  const home = mkdtempSync(path.join(tmpdir(), "claude-adv-no-codex-home-"));
  const result = runAdapter(["setup", "--json"], {
    codexHome: "/bad-codex-home",
    home,
  });

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    new RegExp(
      `claude-adv-codex: no usable state directory ` +
        `\\(CODEX_HOME=/bad-codex-home HOME=${home}\\)`
    )
  );
});

test("codex adapter removes inherited session env when thread id is absent or invalid", () => {
  for (const CODEX_THREAD_ID of [undefined, "", ".bad"]) {
    const { records } = runAdapterWithCapture(["setup", "--json"], {
      cwd: makeRepo(),
      env: {
        CODEX_THREAD_ID,
        CLAUDE_ADV_SESSION_ID: "stale-session",
        CLAUDE_ADV_WARN_CROSS_SESSION: "stale-warning",
      },
    });
    const companion = companionRecord(records);
    assert.ok(companion, `missing companion record for ${String(CODEX_THREAD_ID)}`);
    assert.equal(companion.env.CLAUDE_ADV_SESSION_ID, undefined, String(CODEX_THREAD_ID));
    assert.equal(companion.env.CLAUDE_ADV_WARN_CROSS_SESSION, undefined, String(CODEX_THREAD_ID));
  }
});

test("codex adapter sets cross-session warning env only for explicit result and cancel refs", () => {
  for (const subcommand of ["result", "cancel"]) {
    const explicit = runAdapterWithCapture([subcommand, "job-123", "--json"], {
      cwd: makeRepo(),
      env: {
        CODEX_THREAD_ID: "thread-123",
        CLAUDE_ADV_WARN_CROSS_SESSION: "stale-warning",
      },
    });
    const explicitCompanion = companionRecord(explicit.records);
    assert.ok(explicitCompanion, `${subcommand} explicit companion record`);
    assert.match(explicitCompanion.env.CLAUDE_ADV_SESSION_ID, /^codex:thread-123@[0-9a-f]{8}$/);
    assert.equal(
      explicitCompanion.env.CLAUDE_ADV_WARN_CROSS_SESSION,
      explicitCompanion.env.CLAUDE_ADV_SESSION_ID
    );

    const defaultScoped = runAdapterWithCapture([subcommand, "--json"], {
      cwd: makeRepo(),
      env: {
        CODEX_THREAD_ID: "thread-123",
        CLAUDE_ADV_WARN_CROSS_SESSION: "stale-warning",
      },
    });
    const defaultCompanion = companionRecord(defaultScoped.records);
    assert.ok(defaultCompanion, `${subcommand} default companion record`);
    assert.equal(defaultCompanion.env.CLAUDE_ADV_WARN_CROSS_SESSION, undefined);
  }
});

test("codex adapter and result/cancel handlers share job-reference parser", () => {
  assert.deepEqual(JOB_REFERENCE_ARG_CONFIG, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"],
  });

  for (const file of [ADAPTER, RESULT_HANDLER, CANCEL_HANDLER]) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /parseJobReferenceArgs/);
    assert.doesNotMatch(source, /parseArgs\(argv,\s*\{\s*valueOptions:\s*\["cwd"\]/s);
  }
});
