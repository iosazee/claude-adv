import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SHIM = path.join(ROOT, "codex/scripts/claude-adv-codex.mjs");
const MOCK_CLAUDE = path.join(ROOT, "tests/fixtures/mock-claude.sh");

function makeToolPath() {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-shim-tools-"));
  symlinkSync(process.execPath, path.join(dir, "node"));
  symlinkSync(MOCK_CLAUDE, path.join(dir, "claude"));
  return `${dir}:${process.env.PATH}`;
}

test("real setup --json: shim imports relocated adapter, returns JSON, and warns", () => {
  const result = spawnSync(process.execPath, [SHIM, "setup", "--json"], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_HOME: mkdtempSync(path.join(tmpdir(), "codex-shim-home-")),
      PATH: makeToolPath(),
    },
  });
  assert.equal(
    result.status,
    0,
    `setup --json failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
  assert.match(result.stderr, /codex\/scripts\/claude-adv-codex\.mjs is deprecated/);
  assert.doesNotThrow(() => JSON.parse(result.stdout));
});

function buildFixture(prefix, includeTarget) {
  const tmp = mkdtempSync(path.join(tmpdir(), prefix));
  const shimPath = path.join(tmp, "codex/scripts/claude-adv-codex.mjs");
  mkdirSync(path.dirname(shimPath), { recursive: true });
  cpSync(SHIM, shimPath);
  chmodSync(shimPath, 0o755);
  if (includeTarget) {
    const stubPath = path.join(tmp, "plugins/claude-adv/scripts/claude-adv-codex.mjs");
    mkdirSync(path.dirname(stubPath), { recursive: true });
    writeFileSync(
      stubPath,
      '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ fixture: true }) + "\\n");\n'
    );
  }
  return { tmp, shimPath };
}

test("encoded-path fixture: shim imports target through a path with '#'", () => {
  const { tmp, shimPath } = buildFixture("codex-shim-test-#abc-", true);
  try {
    const result = spawnSync(process.execPath, [shimPath, "setup", "--json"], {
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      0,
      `shim failed in encoded fixture:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
    assert.match(result.stdout, /"fixture":true/);
    assert.match(result.stderr, /deprecated/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("broken-target fixture: shim surfaces import errors", () => {
  const { tmp, shimPath } = buildFixture("codex-shim-broken-", false);
  try {
    const result = spawnSync(process.execPath, [shimPath, "setup", "--json"], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /(Cannot find module|ERR_MODULE_NOT_FOUND)/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
