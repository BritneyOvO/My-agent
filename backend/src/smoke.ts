import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";

const port = Number.parseInt(process.env.PORT ?? "18080", 10);
const token = process.env.Z3GH0NE_ADMIN_TOKEN ?? "test-token";
const smokeDataDir = await mkdtemp(path.join(tmpdir(), "z3gh0ne-smoke-"));
process.env.Z3GH0NE_ADMIN_TOKEN = token;
process.env.Z3GH0NE_DISABLE_AUTO_EXECUTE = "1";
process.env.Z3GH0NE_DATA_DIR = smokeDataDir;
process.env.Z3GH0NE_LOG_DIR = path.join(smokeDataDir, "logs");
process.env.Z3GH0NE_UPLOADS_DIR = path.join(smokeDataDir, "uploads");
process.env.Z3GH0NE_WORKSPACES_DIR = path.join(smokeDataDir, "workspaces");

const { env } = await import("./lib/env.js");
const { buildServer } = await import("./server.js");

const server = buildServer();
await server.listen({ host: "127.0.0.1", port });

try {
  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: `Bearer ${token}` };
  const health = await getJson(`${base}/health`);
  const unauthTools = await fetch(`${base}/tools`);
  const toolList = await getJson(`${base}/tools`, auth);
  const hub = await getJson(`${base}/hub/info`, auth);
  const task = await postJson(`${base}/tasks`, auth, {
    mode: "ctf_challenge",
    prompt: "analyze this binary"
  });
  const status = await patchJson(`${base}/tasks/${task.task_id}/status`, auth, {
    status: "running",
    comment: "started"
  });
  await patchJson(`${base}/tasks/${task.task_id}/status`, auth, {
    status: "completed",
    comment: "smoke cleanup"
  });

  console.log(JSON.stringify({
    healthOk: health.ok,
    unauthToolsStatus: unauthTools.status,
    toolCount: Array.isArray(toolList.tools) ? toolList.tools.length : 0,
    hubUser: hub.user,
    taskId: task.task_id,
    status: status.status,
    dataDir: env.dataDir
  }));
} finally {
  await server.close();
  await rm(smokeDataDir, { recursive: true, force: true });
}

async function getJson(url: string, headers?: Record<string, string>) {
  const response = await fetch(url, headers ? { headers } : undefined);
  return readJsonResponse(response);
}

async function postJson(url: string, headers: Record<string, string>, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return readJsonResponse(response);
}

async function patchJson(url: string, headers: Record<string, string>, body: unknown) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return readJsonResponse(response);
}

async function readJsonResponse(response: Response) {
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}
