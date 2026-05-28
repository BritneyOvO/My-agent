const port = Number.parseInt(process.env.PORT ?? "18080", 10);
const token = process.env.Z3GH0NE_ADMIN_TOKEN ?? "test-token";
process.env.Z3GH0NE_ADMIN_TOKEN = token;

const { env } = await import("./lib/env.ts");
const { buildServer } = await import("./server.ts");

const server = buildServer();
await server.listen({ host: "127.0.0.1", port });

try {
  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: `Bearer ${token}` };
  const health = await getJson(`${base}/health`);
  const unauthTools = await fetch(`${base}/tools`);
  const hub = await getJson(`${base}/hub/info`, auth);
  const task = await postJson(`${base}/tasks`, auth, {
    mode: "ctf_challenge",
    prompt: "analyze this binary"
  });
  const status = await patchJson(`${base}/tasks/${task.task_id}/status`, auth, {
    status: "running",
    comment: "started"
  });

  console.log(JSON.stringify({
    healthOk: health.ok,
    unauthToolsStatus: unauthTools.status,
    hubUser: hub.user,
    taskId: task.task_id,
    status: status.status,
    dataDir: env.dataDir
  }));
} finally {
  await server.close();
}

async function getJson(url: string, headers?: Record<string, string>) {
  const response = await fetch(url, { headers });
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
