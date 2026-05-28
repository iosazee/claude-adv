import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SYNC = path.join(ROOT, "scripts/release/sync-codex-bundle.mjs");
const GATE = process.env.RUN_INTEGRATION_TESTS === "true";

test("Codex bundle is in sync with root sources", { skip: !GATE }, () => {
  const result = spawnSync(process.execPath, [SYNC, "--check"], { encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `sync --check failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
});
