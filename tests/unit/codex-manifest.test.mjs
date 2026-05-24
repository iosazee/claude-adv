import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const MANIFEST_PATH = path.join(ROOT, ".codex-plugin/plugin.json");
const PACKAGE_PATH = path.join(ROOT, "package.json");

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function collectAssetPathFields(value, out = []) {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) collectAssetPathFields(item, out);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    if (/^(icon|iconPath|logo|logoPath|asset|assets|assetPath)$/i.test(key)) {
      const paths = Array.isArray(child) ? child : [child];
      for (const assetPath of paths) {
        if (typeof assetPath === "string") out.push(assetPath);
      }
    }
    collectAssetPathFields(child, out);
  }
  return out;
}

test("codex manifest parses and mirrors package identity", () => {
  const manifest = readJson(MANIFEST_PATH);
  const packageJson = readJson(PACKAGE_PATH);

  assert.equal(manifest.name, packageJson.name);
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.skills, "./codex/skills/");
});

test("codex manifest declares the approved Codex interface", () => {
  const manifest = readJson(MANIFEST_PATH);

  assert.equal(manifest.interface.displayName, "Claude Adv");
  assert.ok(manifest.interface.capabilities.includes("Read"));
  assert.ok(manifest.interface.capabilities.includes("Write"));
  assert.equal(manifest.interface.capabilities.includes("Interactive"), false);
  assert.ok(manifest.interface.defaultPrompt.length <= 3);
  assert.equal("commands" in manifest, false);
});

test("codex manifest does not reference missing asset paths", () => {
  const manifest = readJson(MANIFEST_PATH);
  const assetPaths = collectAssetPathFields(manifest);

  for (const assetPath of assetPaths) {
    const absolute = path.resolve(ROOT, assetPath);
    assert.ok(existsSync(absolute), `missing manifest asset: ${assetPath}`);
  }
});
