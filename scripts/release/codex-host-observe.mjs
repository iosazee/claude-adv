#!/usr/bin/env node
import crypto from "node:crypto";
import os from "node:os";
import process from "node:process";

function bootEpochSeconds(nowMs = Date.now(), uptimeSeconds = os.uptime()) {
  return Math.round(Math.floor(nowMs / 1000 - uptimeSeconds) / 60) * 60;
}

function bootHash(epochSeconds) {
  return crypto.createHash("sha256").update(String(epochSeconds)).digest("hex").slice(0, 8);
}

const bootEpoch = bootEpochSeconds();
const payload = {
  observedAt: new Date().toISOString(),
  platform: process.platform,
  node: process.version,
  cwd: process.cwd(),
  env: {
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID ?? null,
    CODEX_CI: process.env.CODEX_CI ?? null,
    CODEX_HOME: process.env.CODEX_HOME ?? null,
    CODEX_SHELL: process.env.CODEX_SHELL ?? null,
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? null,
  },
  boot: {
    osUptime: os.uptime(),
    bootEpoch,
    bootHash: bootHash(bootEpoch),
  },
};

process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
