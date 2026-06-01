import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppInstance } from "../server.js";
import { HttpError, parseOrThrow } from "../lib/http.js";
import { ensureDir, readJsonFile, writeJsonFile } from "../lib/fs.js";
import { taskFilePath, tasksDir } from "../lib/task-path.js";
import { requireToken } from "../core/auth.js";
import { PolicyGate } from "../core/policy.js";
import { audit } from "../core/audit.js";
import { recoverActiveTasks, scheduleTaskExecution, stopTaskExecution } from "../agents/executor.js";
import { compactTaskForEvent, publishTaskEvent, subscribeTaskEvents, type TaskEvent } from "../agents/task-events.js";
import { taskCommentSchema, taskRequestSchema, taskRetrySchema, taskStatusUpdateSchema, type TaskRequest } from "../types/task.js";

type TaskHistoryEntry = {
  ts: string;
  action: string;
  by: string;
  from?: string;
  to?: string;
  comment?: string;
  path?: string;
};

type TaskCommentEntry = {
  id: string;
  ts: string;
  by: string;
  text: string;
};

type TaskArtifactEntry = {
  id: string;
  ts: string;
  by: string;
  path: string;
  label: string;
};

type StoredTask = {
  task_id: string;
  status: string;
  mode: string;
  prompt: string;
  target: string | null;
  owner: string;
  priority: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  created_by: string;
  history: TaskHistoryEntry[];
  comments: TaskCommentEntry[];
  artifacts: TaskArtifactEntry[];
  result: Record<string, unknown> | null;
};

async function loadTask(taskId: string) {
  const filePath = taskFilePath(taskId);
  try {
    return await readJsonFile<StoredTask>(filePath);
  } catch {
    throw new HttpError(404, "task not found");
  }
}

async function saveTask(task: StoredTask) {
  await ensureDir(tasksDir());
  await writeJsonFile(taskFilePath(task.task_id), task);
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
    comments: [],
    artifacts: [],
    result: null
  } satisfies StoredTask;
}

function compactText(value: unknown, max = 6000) {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}\n...<truncated>` : value;
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > max ? `${text.slice(0, max)}\n...<truncated>` : text;
  } catch {
    return String(value).slice(0, max);
  }
}

function summarizePreviousResult(task: StoredTask) {
  const result = task.result && typeof task.result === "object" ? task.result : {};
  const steps = Array.isArray(result.agent_steps) ? result.agent_steps as Array<Record<string, unknown>> : [];
  const tailSteps = steps.slice(-8).map((step) => {
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls as Array<Record<string, unknown>> : [];
    return [
      `Step ${String(step.step ?? "-")} ${String(step.ts ?? "")}`,
      `AI/思路: ${compactText(step.thought, 1200)}`,
      calls.length ? `工具: ${calls.map((call) => {
        const res = call.result && typeof call.result === "object" ? call.result as Record<string, unknown> : {};
        return `${String(call.tool ?? "tool")}(${String(call.target ?? call.artifact_path ?? "")}) => ${String(res.exit_code ?? res.error_code ?? "done")} ${compactText(res.error ?? res.output ?? "", 700)}`;
      }).join("\n")}` : "工具: 无",
      step.analysis ? `分析: ${compactText(step.analysis, 1000)}` : ""
    ].filter(Boolean).join("\n");
  }).join("\n---\n");

  return [
    `上次状态: ${task.status}`,
    result.text ? `上次最终输出:\n${compactText(result.text, 4000)}` : "",
    result.error ? `上次错误:\n${compactText(result.error, 4000)}` : "",
    tailSteps ? `上次最后 ${Math.min(8, steps.length)} 个步骤摘要:\n${tailSteps}` : ""
  ].filter(Boolean).join("\n\n") || "无上次执行结果。";
}

function getOriginalPrompt(task: StoredTask, previousResult: Record<string, unknown>) {
  const retryContext = previousResult.retry_context && typeof previousResult.retry_context === "object"
    ? previousResult.retry_context as Record<string, unknown>
    : {};
  const originalPrompt = retryContext.original_prompt ?? previousResult.original_prompt;
  return typeof originalPrompt === "string" && originalPrompt.trim() ? originalPrompt : task.prompt;
}

function buildRetryPrompt(task: StoredTask, originalPrompt: string, retryPrompt: string) {
  const previousResult = task.result && typeof task.result === "object" ? task.result : {};
  const contextForModel = {
    task_id: task.task_id,
    mode: task.mode,
    target: task.target,
    owner: task.owner,
    priority: task.priority,
    tags: task.tags,
    artifacts: task.artifacts,
    comments: task.comments,
    history: task.history,
    previous_result: {
      text: previousResult.text,
      error: previousResult.error,
      flags: previousResult.flags,
      provider: previousResult.provider,
      model: previousResult.model,
      usage: previousResult.usage,
      agent_steps: previousResult.agent_steps,
      tool_calls: previousResult.tool_calls,
      retry_context: previousResult.retry_context
    }
  };
  return [
    "这是一次对已结束任务的重试/继续执行。必须保留并利用原始上下文，不要从零开始。",
    "",
    "## 原始任务 Prompt（保持不变）",
    originalPrompt,
    "",
    "## 上次执行摘要",
    summarizePreviousResult(task),
    "",
    "## 原始上下文与历史（用于继续执行）",
    compactText(contextForModel, 30000),
    "",
    "## 本次用户补充提示词",
    retryPrompt,
    "",
    "继续执行要求：",
    "- 基于原始任务、上次步骤、工具输出、附件路径和补充提示继续推进。",
    "- 不要重复已经失败且没有新信息的工具调用。",
    "- 如果上次已经下载/解压/定位了文件路径，继续使用这些路径。",
    "- 需要工具就直接调用；已经能给出最终答案就直接输出。"
  ].join("\n");
}

export function registerTaskRoutes(app: AppInstance) {
  const autoExecute = process.env.Z3GH0NE_DISABLE_AUTO_EXECUTE !== "1";
  if (autoExecute) {
    void recoverActiveTasks().catch((error) => {
      console.error("task recovery failed", error);
    });
  }

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
    publishTaskEvent(task.task_id, "task.created", { task });
    if (autoExecute) scheduleTaskExecution(task.task_id, user);
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
        const result = task.result && typeof task.result === "object" ? task.result as Record<string, unknown> : {};
        const resultText = typeof result.text === "string" ? result.text : typeof result.error === "string" ? result.error : "";
        results.push({
          task_id: task.task_id,
          status: task.status ?? "unknown",
          mode: task.mode,
          owner: task.owner,
          priority: task.priority ?? "medium",
          prompt: typeof task.prompt === "string" ? task.prompt.slice(0, 120) : "",
          result_summary: resultText ? resultText.slice(0, 260) : undefined,
          executor: result.executor,
          provider: result.provider,
          model: result.model,
          created_at: task.created_at,
          updated_at: task.updated_at
        });
      } catch {
        continue;
      }
    }

    return { tasks: results, total: results.length };
  });

  app.get("/tasks/:taskId/events", async (request, reply) => {
    requireToken(request, { allowQueryToken: true });
    const { taskId } = request.params as { taskId: string };
    const task = await loadTask(taskId);
    const response = reply.stream(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const send = (event: TaskEvent) => {
      response.write(`id: ${event.id}\n`);
      response.write(`event: ${event.type}\n`);
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    send({
      id: `snapshot-${Date.now()}-${taskId}`,
      task_id: taskId,
      type: "snapshot",
      ts: nowIso(),
      payload: { task: compactTaskForEvent(task) as Record<string, unknown> }
    });

    const unsubscribe = subscribeTaskEvents(taskId, send);
    const heartbeat = setInterval(() => {
      response.write(`: heartbeat ${new Date().toISOString()}\n\n`);
    }, 15000);

    response.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
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
    if (req.status === "completed" || req.status === "failed") {
      stopTaskExecution(taskId);
    }
    task.status = req.status;
    task.updated_at = now;
    const entry: TaskHistoryEntry = {
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
    publishTaskEvent(taskId, "task.status", { task, from: oldStatus, to: req.status, comment: req.comment ?? null });
    return task;
  });

  app.post("/tasks/:taskId/retry", async (request) => {
    const user = requireToken(request);
    const { taskId } = request.params as { taskId: string };
    const req = parseOrThrow(taskRetrySchema, request.body);
    const task = await loadTask(taskId);
    const oldStatus = task.status;
    if (oldStatus !== "completed" && oldStatus !== "failed") {
      throw new HttpError(409, "only completed or failed tasks can be retried");
    }

	    const now = nowIso();
	    const previousResult = task.result && typeof task.result === "object" ? task.result : {};
	    const originalPrompt = getOriginalPrompt(task, previousResult);
	    const previousPrompt = task.prompt;
	    const previousHistory = [...task.history];
	    const previousComments = [...task.comments];
	    const previousArtifacts = [...task.artifacts];
	    const retryContext = previousResult.retry_context && typeof previousResult.retry_context === "object"
	      ? previousResult.retry_context as Record<string, unknown>
	      : {};
	    const retryRuns = Array.isArray(retryContext.runs) ? retryContext.runs : [];
	    const previousRun = {
	      retried_at: now,
	      from_status: oldStatus,
	      user_prompt: req.prompt,
	      prompt_before_retry: previousPrompt,
	      previous_completed_at: previousResult.completed_at ?? null,
	      previous_failed_at: previousResult.failed_at ?? null,
	      previous_text: typeof previousResult.text === "string" ? previousResult.text.slice(0, 4000) : "",
	      previous_error: typeof previousResult.error === "string" ? previousResult.error.slice(0, 4000) : ""
	    };

	    task.prompt = buildRetryPrompt(task, originalPrompt, req.prompt);
	    task.status = "pending";
	    task.updated_at = now;
	    task.result = {
	      executor: "agent-hub-ai",
	      retrying: true,
	      original_prompt: originalPrompt,
	      retry_prompt: req.prompt,
	      retry_context: {
	        original_prompt: originalPrompt,
	        latest_retry_prompt: req.prompt,
	        runs: [...retryRuns, previousRun],
	        previous_prompt: previousPrompt,
	        previous_status: oldStatus,
	        previous_result: previousResult,
	        previous_history: previousHistory,
	        previous_comments: previousComments,
	        previous_artifacts: previousArtifacts
	      },
	      retry_from: previousRun
	    };
    task.history.push({ ts: now, action: "retry_requested", by: user, comment: req.prompt });
    task.history.push({ ts: now, action: "status_change", by: user, from: oldStatus, to: "pending" });
    await saveTask(task);
    await audit("task_retry_requested", { user, task_id: taskId, from: oldStatus });
    publishTaskEvent(taskId, "task.retry", { task, from: oldStatus, prompt: req.prompt });
    if (autoExecute) scheduleTaskExecution(taskId, user);
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
    publishTaskEvent(taskId, "task.comment", { task, comment });
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
    publishTaskEvent(taskId, "task.artifact", { task, artifact });
    return artifact;
  });

  app.post("/tasks/:taskId/cancel", async (request) => {
    const user = requireToken(request);
    const { taskId } = request.params as { taskId: string };
    const task = await loadTask(taskId);
    if (task.status === "completed" || task.status === "failed") {
      throw new HttpError(409, "cannot cancel a finished task");
    }
    stopTaskExecution(taskId);
    const now = nowIso();
    task.status = "failed";
    task.updated_at = now;
    task.history.push({ ts: now, action: "cancelled", by: user });
    await saveTask(task);
    await audit("task_cancelled", { user, task_id: taskId });
    publishTaskEvent(taskId, "task.cancelled", { task });
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
