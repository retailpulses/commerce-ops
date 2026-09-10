import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

async function reservePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

const port = await reservePort();
const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    TICKET_SHARE_BRIDGE_HMAC_SECRET: "entrypoint-smoke-secret-at-least-32-characters",
    TICKET_SHARE_WORKER_BASE_URL: "https://worker.example.com",
    TICKET_SHARE_STORAGE_HOSTS: "storage.example.com",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });

try {
  let healthy = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok && (await response.json()).status === "ok") {
        healthy = true;
        break;
      }
    } catch {
      // The process may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(healthy, true, `production entrypoint did not become healthy: ${stderr}`);
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}
