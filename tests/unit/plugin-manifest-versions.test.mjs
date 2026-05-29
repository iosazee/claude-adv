import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// package.json is the single source of truth for the release version, and
// scripts/release/sync-codex-bundle.mjs pins every plugin manifest to it. These
// always-on assertions guard against the drift that shipped a broken 0.2.0:
// package.json was bumped but the manifests were not, so the marketplace and
// Codex bundle advertised the wrong version. The Codex manifest is also checked
// in codex-manifest.test.mjs; this file additionally guards the Claude manifest.
const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(ROOT, relativePath), "utf8"));
}

const PACKAGE_VERSION = readJson("package.json").version;

const VERSION_MANIFESTS = [
  ".claude-plugin/plugin.json",
  "plugins/claude-adv/.codex-plugin/plugin.json",
];

for (const manifestRel of VERSION_MANIFESTS) {
  test(`${manifestRel} version mirrors package.json`, () => {
    const manifest = readJson(manifestRel);
    assert.equal(
      manifest.version,
      PACKAGE_VERSION,
      `${manifestRel} is ${manifest.version} but package.json is ${PACKAGE_VERSION}; run "npm run sync:codex"`
    );
  });
}
