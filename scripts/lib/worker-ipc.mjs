// scripts/lib/worker-ipc.mjs — Unix domain socket helpers for the
// claude-adv worker. JSONL wire protocol with shared error shape.

import net from "node:net";
import { unlinkSync } from "node:fs";

export async function createServer(sockPath, handler) {
  // Pre-clean stale socket file.
  try {
    unlinkSync(sockPath);
  } catch {
    /* not present */
  }

  const server = net.createServer((conn) => {
    let buf = "";
    conn.setEncoding("utf8");
    conn.on("data", async (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          conn.write(JSON.stringify({ ok: false, code: "parse-error" }) + "\n");
          continue;
        }
        try {
          const response = await handler(msg);
          conn.write(JSON.stringify({ id: msg.id, ...response }) + "\n");
        } catch (err) {
          conn.write(
            JSON.stringify({
              id: msg.id,
              ok: false,
              code: "internal",
              detail: err instanceof Error ? err.message : String(err),
            }) + "\n"
          );
        }
      }
    });
    conn.on("error", () => {
      /* ignore client errors */
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, resolve);
  });

  return {
    sockPath,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      try {
        unlinkSync(sockPath);
      } catch {
        /* already gone */
      }
    },
  };
}

// Default IPC timeout for the fast control calls (ping/status/interrupt/
// shutdown). The `review` request uses a much larger bound passed explicitly
// by the caller — see REVIEW_IPC_TIMEOUT_MS in the stop-gate hook.
export async function connectAndRequest(sockPath, message, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60000;
  return new Promise((resolve, reject) => {
    const socket = net.connect(sockPath);
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`worker-ipc: timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.setEncoding("utf8");
    socket.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    socket.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl).trim();
      if (!line) return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      try {
        resolve(JSON.parse(line));
      } catch (err) {
        reject(err);
      }
    });
    socket.on("connect", () => {
      socket.write(JSON.stringify(message) + "\n");
    });
  });
}
