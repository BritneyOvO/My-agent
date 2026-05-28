import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { env } from "../lib/env.js";
import { HttpError, parseOrThrow } from "../lib/http.js";
import { ensureDir, readJsonFile, writeJsonFile } from "../lib/fs.js";
import { requireToken } from "../core/auth.js";
import { PolicyGate } from "../core/policy.js";
import { audit } from "../core/audit.js";
import { taskCommentSchema, taskRequestSchema, taskStatusUpdateSchema, type TaskRequest } from "../types/task.js";

type StoredTask = ReturnType<typeof buildTaskRecord>;

function tasksDir() {
  return path.join(env.dataDir, "tasks");
}

async function loadTask(taskId: string) {
  const filePath = path.join(tasksDir(), `${taskId}.json`);
  try {
    return await readJsonFile<StoredTask>(filePath);
  } catch {
    throw new HttpError(404, "task not found");
  }
}

async function saveTask(task: StoredTask) {
  await ensureDir(tasksDir());
  await writeJsonFile(path.join(tasksDir(), `${task.task_id}.json`), task);
}

function nowIso() {
  return new Date().toISOString();
}

function buildTaskRecord(req: TaskRequest, user: string) {
  const now = nowIso();
  const taskId = randomUUID();
  return {
    task_id: taskId,
    status: "pending",
    mode: req.mode,
    prompt: req.prompt,
    target: req.target ?? null,
    owner: req.owner ?? user,
    priority: req.priority,
    tags: req.tags,
    created_at: now,
    updated_at: now,
    created_by: user,
    history: [{ ts: now, action: "created", by: user }],
    comments: [] as Array<Record<string, string>>,
    artifacts: [] as Array<Record<string, string>>,
    result: null as Record<string, unknown> | null
  };
}

export function registerTaskRoutes(app: FastifyInstance) {
  app.post("/tasks", async (request) => {
    const user = requireToken(request);
    const req = parseOrThrow(taskRequestSchema, request.body);
    const policy = new PolicyGate();

    for (const decision of [policy.checkMode(req.mode), policy.checkText(req.prompt)]) {
      if (!decision.allowed) {
        await audit("task_refused", { user, mode: req.mode, reason: decision.reason });
        throw new HttpError(403, decision.reason);
      }
    }

    const task = buildTaskRecord(req, user);
    await saveTask(task);
    await audit("task_created", { user, task_id: task.task_id, mode: req.mode, target: req.target ?? null });
    return task;
  });

  app.get("/tasks", async (request) => {
    requireToken(request);
    await ensureDir(tasksDir());

    const query = request.query as Record<string, string | undefined>;
    const status = query.status;
    const mode = query.mode;
    const owner = query.owner;
    const limit = clampLimit(query.limit);

    const fs = await import("node:fs/promises");
    const entries = await fs.readdir(tasksDir(), { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));

    const detailed = await Promise.all(
      files.map(async (entry) => {
        const filePath = path.join(tasksDir(), entry.name);
        const stat = await fs.stat(filePath);
        return { filePath, mtime: stat.mtimeMs };
      })
    );

    const sorted = detailed.sort((a, b) => b.mtime - a.mtime);
    const results: Array<Record<string, unknown>> = [];

    for (const file of sorted) {
      if (results.length >= limit) {
        break;
      }
      try {
        const task = await readJsonFile<Record<string, unknown>>(file.filePath);
        if (status && task.status !== status) {
          continue;
        }
        if (mode && task.mode !== mode) {
          continue;
        }
        if (owner && task.owner !== owner) {
          continue;
        }
        results.push({
          task_id: task.task_id,
          status: task.status ?? "unknown",
          mode: task.mode,
          owner: task.owner,
          priority: task.priority ?? "medium",
          prompt: typeof task.prompt === "string" ? task.prompt.slice(0, 120) : "",
          created_at: task.created_at,
          updated_at: task.updated_at
        });
      } catch {
        continue;
      }
    }

    return { tasks: results, total: results.length };
  });

  app.get("/tasks/:taskId", async (request) => {
    requireToken(request);
    const { taskId } = request.params as { taskId: string };
    return loadTask(taskId);
  });

  app.patch("/tasks/:taskId/status", async (request) => {
    const user = requireToken(request);
    const { taskId } = request.params as { taskId: string };
    const req = parseOrThrow(taskStatusUpdateSchema, request.body);
    const task = await loadTask(taskId);
    const now = nowIso();
    const oldStatus = task.status;
    task.status = req.status;
    task.updated_at = now;
    const entry: Record<string, string> = {
      ts: now,
      action: "status_change",
      by: user,
      from: oldStatus,
      to: req.status
    };
    if (req.comment) {
      entry.comment = req.comment;
    }
    task.history.push(entry);
    await saveTask(task);
    await audit("task_status_changed", { user, task_id: taskId, from: oldStatus, to: req.status });
    return task;
  });

  app.post("/tasks/:taskId/comments", async (request) => {
    const user = requireToken(request);
    const { taskId } = request.params as { taskId: string };
    const req = parseOrThrow(taskCommentSchema, request.body);
    const task = await loadTask(taskId);
    const now = nowIso();
    const comment = { id: randomUUID(), ts: now, by: user, text: req.text };
    task.comments.push(comment);
    task.updated_at = now;
    task.history.push({ ts: now, action: "comment_added", by: user });
    await saveTask(task);
    await audit("task_comment", { user, task_id: taskId, comment_id: comment.id });
    return comment;
  });

  app.post("/tasks/:taskId/artifacts", async (request) => {
    const user = requireToken(request);
    const { taskId } = request.params as { taskId: string };
    const query = request.query as Record<string, string | undefined>;
    const rawPath = query.path;
    if (!rawPath) {
      throw new HttpError(422, "path is required");
    }
    const task = await loadTask(taskId);
    const now = nowIso();
    const safePath = path.basename(rawPath);
    const artifact = {
      id: randomUUID(),
      ts: now,
      by: user,
      path: safePath,
      label: query.label ?? ""
    };
    task.artifacts.push(artifact);
    task.updated_at = now;
    task.history.push({ ts: now, action: "artifact_added", by: user, path: safePath });
    await saveTask(task);
    return artifact;
  });

  app.post("/tasks/:taskId/cancel", async (request) => {
    const user = requireToken(request);
    const { taskId } = request.params as { taskId: string };
    const task = await loadTask(taskId);
    if (task.status === "completed" || task.status === "failed") {
      throw new HttpError(409, "cannot cancel a finished task");
    }
    const now = nowIso();
    task.status = "failed";
    task.updated_at = now;
    task.history.push({ ts: now, action: "cancelled", by: user });
    await saveTask(task);
    await audit("task_cancelled", { user, task_id: taskId });
    return { task_id: taskId, status: "failed" };
  });
}

function clampLimit(limit: string | undefined) {
  const parsed = Number.parseInt(limit ?? "50", 10);
  if (Number.isNaN(parsed)) {
    return 50;
  }
  return Math.min(200, Math.max(1, parsed));
}
