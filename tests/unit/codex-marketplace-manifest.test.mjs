import { strict as assert } from "node:assert";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST_PATH = path.join(ROOT, ".agents/plugins/marketplace.json");

test("Codex marketplace manifest exists and is well-formed", () => {
  assert.ok(existsSync(MANIFEST_PATH), `missing: ${MANIFEST_PATH}`);
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

  assert.equal(manifest.name, "claude-adv");
  assert.equal(typeof manifest.interface?.displayName, "string");
  assert.ok(Array.isArray(manifest.plugins));
  assert.equal(manifest.plugins.length, 1);

  const [plugin] = manifest.plugins;
  assert.equal(plugin.name, "claude-adv");
  assert.equal(plugin.source?.source, "local");
  assert.equal(plugin.source?.path, "./plugins/claude-adv");
  assert.equal(plugin.policy?.installation, "AVAILABLE");
  assert.equal(plugin.policy?.authentication, "ON_INSTALL");
  assert.equal(typeof plugin.category, "string");
});

test("source.path resolves to a self-contained Codex plugin bundle", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const target = path.resolve(ROOT, manifest.plugins[0].source.path);
  assert.ok(statSync(target, { throwIfNoEntry: false })?.isDirectory(), target);
  assert.ok(existsSync(path.join(target, ".codex-plugin/plugin.json")));
  assert.ok(existsSync(path.join(target, "scripts/claude-adv-codex.mjs")));
  assert.ok(statSync(path.join(target, "prompts"), { throwIfNoEntry: false })?.isDirectory());
  assert.ok(statSync(path.join(target, "schemas"), { throwIfNoEntry: false })?.isDirectory());
});
