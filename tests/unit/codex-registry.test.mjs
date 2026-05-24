import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildAdapterEnv } from "../../codex/scripts/lib/codex-env.mjs";
import {
  registryPathForCodexHome,
  touchPluginInstallRegistry,
} from "../../codex/scripts/lib/codex-registry.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const ADAPTER = path.join(ROOT, "codex/scripts/claude-adv-codex.mjs");
const COMPANION = path.join(ROOT, "scripts/claude-companion.mjs");
const READY_SETUP = JSON.stringify({
  ready: true,
  readinessReason: null,
  claude: { available: true },
  auth: { available: true, loggedIn: true },
});

function makeCodexHome() {
  return mkdtempSync(path.join(tmpdir(), "claude-adv-registry-codex-home-"));
}

function makeHomeWithCodex() {
  const home = mkdtempSync(path.join(tmpdir(), "claude-adv-registry-home-"));
  mkdirSync(path.join(home, ".codex"));
  return home;
}

function makeInstall(name = "install") {
  const root = mkdtempSync(path.join(tmpdir(), `claude-adv-registry-${name}-`));
  mkdirSync(path.join(root, ".codex-plugin"));
  writeFileSync(path.join(root, ".codex-plugin/plugin.json"), "{}\n");
  return root;
}

function readRegistry(codexHome) {
  return JSON.parse(readFileSync(registryPathForCodexHome(codexHome), "utf8"));
}

function lockPath(codexHome) {
  return `${registryPathForCodexHome(codexHome)}.lock`;
}

function makeCaptureImport() {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-adv-registry-capture-"));
  const file = path.join(dir, "capture.mjs");
  writeFileSync(
    file,
    `import path from "node:path";
const isCompanion = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(process.env.CAPTURE_COMPANION);
if (isCompanion && process.argv[2] === "setup" && process.env.CI_SETUP_STDOUT !== undefined) {
  process.stdout.write(process.env.CI_SETUP_STDOUT + "\\n");
  process.exit(0);
}
if (isCompanion) {
  process.exit(Number(process.env.CAPTURE_EXIT_CODE ?? "0"));
}
`
  );
  return file;
}

function runAdapter(args, options = {}) {
  const capture = makeCaptureImport();
  const nodeOptions = `${process.env.NODE_OPTIONS ?? ""} --import=${capture}`.trim();
  return spawnSync(process.execPath, [ADAPTER, ...args], {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_CI: options.codexCi ? "1" : "",
      CODEX_HOME: options.codexHome ?? makeCodexHome(),
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "",
      CODEX_THREAD_ID: "registry-thread",
      HOME: options.home ?? makeHomeWithCodex(),
      CAPTURE_COMPANION: COMPANION,
      CAPTURE_EXIT_CODE: String(options.exitCode ?? 0),
      CI_SETUP_STDOUT: options.ciSetupStdout,
      MOCK_REGISTRY_WRITE_COUNTER: options.registryCounter,
      NODE_OPTIONS: nodeOptions,
      ...options.env,
    },
  });
}

function touch(codexHome, repoRoot, options = {}) {
  return touchPluginInstallRegistry({
    validatedCodexHome: codexHome,
    repoRoot,
    argv: options.argv ?? ["setup"],
    now: options.now ?? new Date("2026-05-14T12:00:00.000Z"),
    fsImpl: options.fsImpl ?? fs,
    osImpl: options.osImpl ?? os,
  });
}

function lockPayload(overrides = {}) {
  return JSON.stringify({
    pid: process.pid,
    writerPath: process.execPath,
    hostname: os.hostname(),
    ...overrides,
  });
}

async function waitForClose(child) {
  return await new Promise((resolve, reject) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
}

test("adapter setup and setup --json write plugin-installs registry", () => {
  const codexHome = makeCodexHome();

  for (const args of [["setup"], ["setup", "--json"]]) {
    const result = runAdapter(args, { codexHome });
    assert.equal(result.status, 0, result.stderr);

    const registry = readRegistry(codexHome);
    assert.deepEqual(
      registry.installs.map((entry) => entry.root),
      [fs.realpathSync(ROOT)]
    );
    assert.match(registry.installs[0].lastSeenAt, /^\d{4}-\d{2}-\d{2}T/);
  }
});

test("adapter successful non-setup subcommand updates registry once", () => {
  const codexHome = makeCodexHome();
  const counter = path.join(mkdtempSync(path.join(tmpdir(), "claude-adv-registry-counter-")), "n");
  const result = runAdapter(["status", "job-123", "--json"], {
    codexHome,
    registryCounter: counter,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(counter, "utf8"), "1\n");
  assert.deepEqual(
    readRegistry(codexHome).installs.map((entry) => entry.root),
    [fs.realpathSync(ROOT)]
  );
});

test("registry keeps two distinct installs and dedupes symlinked roots by realpath", () => {
  const codexHome = makeCodexHome();
  const installA = makeInstall("a");
  const installB = makeInstall("b");
  const linkToA = path.join(
    mkdtempSync(path.join(tmpdir(), "claude-adv-registry-link-")),
    "a-link"
  );
  symlinkSync(installA, linkToA);

  assert.equal(touch(codexHome, installA).updated, true);
  assert.equal(touch(codexHome, installB).updated, true);
  assert.equal(touch(codexHome, linkToA).updated, true);

  assert.deepEqual(
    readRegistry(codexHome)
      .installs.map((entry) => entry.root)
      .sort(),
    [fs.realpathSync(installA), fs.realpathSync(installB)].sort()
  );
});

test("registry prunes missing roots and roots without plugin manifests", () => {
  const codexHome = makeCodexHome();
  const valid = makeInstall("valid");
  const invalid = mkdtempSync(path.join(tmpdir(), "claude-adv-registry-invalid-"));
  const caller = makeInstall("caller");
  mkdirSync(path.dirname(registryPathForCodexHome(codexHome)), { recursive: true });
  writeFileSync(
    registryPathForCodexHome(codexHome),
    JSON.stringify({
      installs: [
        { root: valid, lastSeenAt: "old" },
        { root: invalid, lastSeenAt: "old" },
        { root: path.join(tmpdir(), "missing-claude-adv-install"), lastSeenAt: "old" },
      ],
    })
  );

  assert.equal(touch(codexHome, caller).updated, true);

  assert.deepEqual(
    readRegistry(codexHome)
      .installs.map((entry) => entry.root)
      .sort(),
    [fs.realpathSync(valid), fs.realpathSync(caller)].sort()
  );
});

test("corrupt registry is quarantined before writing a clean registry", () => {
  const codexHome = makeCodexHome();
  const install = makeInstall("corrupt");
  const registryPath = registryPathForCodexHome(codexHome);
  mkdirSync(path.dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, "{ not-json");

  assert.equal(touch(codexHome, install).updated, true);

  assert.deepEqual(
    readRegistry(codexHome).installs.map((entry) => entry.root),
    [fs.realpathSync(install)]
  );
  assert.ok(
    fs
      .readdirSync(path.dirname(registryPath))
      .some((name) => name.startsWith("plugin-installs.json.bad-"))
  );
});

test("dead-pid stale locks are reclaimed", () => {
  const codexHome = makeCodexHome();
  const install = makeInstall("dead-lock");
  mkdirSync(path.dirname(lockPath(codexHome)), { recursive: true });
  writeFileSync(lockPath(codexHome), lockPayload({ pid: 99999999 }));

  const result = touch(codexHome, install);

  assert.equal(result.updated, true);
  assert.equal(fs.existsSync(lockPath(codexHome)), false);
  assert.deepEqual(
    readRegistry(codexHome).installs.map((entry) => entry.root),
    [fs.realpathSync(install)]
  );
});

test("live plausible writer causes bounded backoff and warning", () => {
  const codexHome = makeCodexHome();
  const install = makeInstall("live-lock");
  mkdirSync(path.dirname(lockPath(codexHome)), { recursive: true });
  writeFileSync(
    lockPath(codexHome),
    lockPayload({ pid: process.pid, writerPath: process.execPath })
  );

  const result = touch(codexHome, install);

  assert.equal(result.updated, false);
  assert.match(result.warning, /plugin-installs lock contention \(writer-pid=/);
  assert.equal(fs.existsSync(registryPathForCodexHome(codexHome)), false);
});

test("foreign-host lock warns and skips update", () => {
  const codexHome = makeCodexHome();
  const install = makeInstall("foreign-lock");
  mkdirSync(path.dirname(lockPath(codexHome)), { recursive: true });
  writeFileSync(lockPath(codexHome), lockPayload({ hostname: "other-host" }));

  const result = touch(codexHome, install);

  assert.equal(result.updated, false);
  assert.match(result.warning, /lock held by foreign host=other-host pid=/);
  assert.match(
    result.warning,
    new RegExp(lockPath(codexHome).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );
  assert.match(result.warning, /remove .* if stale/);
  assert.equal(fs.existsSync(registryPathForCodexHome(codexHome)), false);
});

test("stale foreign-host lock is quarantined and registry update proceeds", () => {
  const codexHome = makeCodexHome();
  const install = makeInstall("foreign-stale-lock");
  const now = new Date("2026-05-14T12:00:00.000Z");
  const stale = new Date("2026-05-13T11:00:00.000Z");
  mkdirSync(path.dirname(lockPath(codexHome)), { recursive: true });
  writeFileSync(lockPath(codexHome), lockPayload({ hostname: "other-host" }));
  fs.utimesSync(lockPath(codexHome), stale, stale);

  const result = touch(codexHome, install, { now });

  assert.equal(result.updated, true);
  assert.match(result.warning, /reclaimed stale plugin-installs lock from foreign host=other-host/);
  assert.match(result.warning, /quarantined=/);
  assert.equal(fs.existsSync(lockPath(codexHome)), false);
  assert.ok(
    fs
      .readdirSync(path.dirname(lockPath(codexHome)))
      .some((name) => name.startsWith("plugin-installs.json.lock.foreign-stale-"))
  );
  assert.deepEqual(
    readRegistry(codexHome).installs.map((entry) => entry.root),
    [fs.realpathSync(install)]
  );
});

test("foreign-host lock refreshed during stale check is not quarantined", () => {
  const codexHome = makeCodexHome();
  const install = makeInstall("foreign-refreshed-lock");
  const now = new Date("2026-05-14T12:00:00.000Z");
  const stale = new Date("2026-05-13T11:00:00.000Z");
  mkdirSync(path.dirname(lockPath(codexHome)), { recursive: true });
  writeFileSync(lockPath(codexHome), lockPayload({ hostname: "other-host" }));

  let lockStatReads = 0;
  const fsImpl = {
    ...fs,
    statSync(file, options) {
      const stat = fs.statSync(file, options);
      if (file !== lockPath(codexHome)) return stat;
      lockStatReads += 1;
      const mtime = lockStatReads === 1 ? stale : now;
      return {
        ...stat,
        mtime,
        mtimeMs: mtime.getTime(),
      };
    },
  };

  const result = touch(codexHome, install, { now, fsImpl });

  assert.equal(result.updated, false);
  assert.match(result.warning, /lock held by foreign host=other-host pid=/);
  assert.equal(fs.existsSync(registryPathForCodexHome(codexHome)), false);
  assert.equal(
    fs
      .readdirSync(path.dirname(lockPath(codexHome)))
      .some((name) => name.startsWith("plugin-installs.json.lock.foreign-stale-")),
    false
  );
});

test("EEXIST followed by ENOENT retries cleanly", () => {
  const codexHome = makeCodexHome();
  const install = makeInstall("enoent");
  let firstOpen = true;
  const fsImpl = {
    ...fs,
    openSync(file, flags, mode) {
      if (file === lockPath(codexHome) && flags === "wx" && firstOpen) {
        firstOpen = false;
        const error = new Error("exists");
        error.code = "EEXIST";
        throw error;
      }
      return fs.openSync(file, flags, mode);
    },
  };

  assert.equal(touch(codexHome, install, { fsImpl }).updated, true);
  assert.deepEqual(
    readRegistry(codexHome).installs.map((entry) => entry.root),
    [fs.realpathSync(install)]
  );
});

test("empty lockfile read backs off before unlinking", () => {
  const codexHome = makeCodexHome();
  const install = makeInstall("empty-lock");
  mkdirSync(path.dirname(lockPath(codexHome)), { recursive: true });
  writeFileSync(lockPath(codexHome), "");
  let lockReads = 0;
  const fsImpl = {
    ...fs,
    readFileSync(file, options) {
      if (file === lockPath(codexHome)) lockReads += 1;
      return fs.readFileSync(file, options);
    },
  };

  assert.equal(touch(codexHome, install, { fsImpl }).updated, true);
  assert.ok(lockReads >= 3);
});

test("delayed lock payload write does not let two writers both hold the lock", async () => {
  const codexHome = makeCodexHome();
  const installA = makeInstall("race-a");
  const installB = makeInstall("race-b");
  const worker = path.join(
    mkdtempSync(path.join(tmpdir(), "claude-adv-registry-worker-")),
    "worker.mjs"
  );
  writeFileSync(
    worker,
    `import fs from "node:fs";
import os from "node:os";
import { touchPluginInstallRegistry } from ${JSON.stringify(
      pathToFileURL(path.join(ROOT, "codex/scripts/lib/codex-registry.mjs")).href
    )};
const delayMs = Number(process.env.DELAY_LOCK_WRITE_MS || 0);
let delayed = false;
const fsImpl = {
  ...fs,
  writeSync(fd, data, ...rest) {
    if (delayMs > 0 && !delayed) {
      delayed = true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
    return fs.writeSync(fd, data, ...rest);
  }
};
const result = touchPluginInstallRegistry({
  validatedCodexHome: process.env.CODEX_HOME,
  repoRoot: process.env.REPO_ROOT,
  argv: ["setup"],
  fsImpl,
  osImpl: os
});
process.stdout.write(JSON.stringify(result) + "\\n");
`
  );

  const childA = spawn(process.execPath, [worker], {
    env: { ...process.env, CODEX_HOME: codexHome, REPO_ROOT: installA, DELAY_LOCK_WRITE_MS: "50" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const childB = spawn(process.execPath, [worker], {
    env: { ...process.env, CODEX_HOME: codexHome, REPO_ROOT: installB },
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.deepEqual(await waitForClose(childA), { code: 0, signal: null });
  assert.deepEqual(await waitForClose(childB), { code: 0, signal: null });
  assert.deepEqual(
    readRegistry(codexHome)
      .installs.map((entry) => entry.root)
      .sort(),
    [fs.realpathSync(installA), fs.realpathSync(installB)].sort()
  );
});

test("CI review touches registry exactly once despite setup preflight", () => {
  const codexHome = makeCodexHome();
  const counter = path.join(mkdtempSync(path.join(tmpdir(), "claude-adv-registry-counter-")), "n");
  const result = runAdapter(["adversarial-review", "--wait"], {
    codexCi: true,
    codexHome,
    ciSetupStdout: READY_SETUP,
    registryCounter: counter,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(counter, "utf8"), "1\n");
  assert.deepEqual(
    readRegistry(codexHome).installs.map((entry) => entry.root),
    [fs.realpathSync(ROOT)]
  );
});

test("registry paths use only validated Codex home from buildAdapterEnv", () => {
  const repoRoot = makeInstall("validated-home");
  const currentUid = typeof process.getuid === "function" ? process.getuid() : 0;
  const fsImpl = {
    realpathSync: (value) => value,
    statSync: (value) => ({
      uid: value === "/raw-codex-home" ? currentUid + 1 : currentUid,
      isDirectory: () => true,
    }),
  };

  const adapter = buildAdapterEnv({
    repoRoot,
    env: { CODEX_HOME: "/raw-codex-home", HOME: "/fallback-home" },
    fsImpl,
  });

  assert.equal(adapter.codexHome, "/fallback-home/.codex");
  assert.equal(
    registryPathForCodexHome(adapter.codexHome),
    "/fallback-home/.codex/state/claude-adv/plugin-installs.json"
  );
});
