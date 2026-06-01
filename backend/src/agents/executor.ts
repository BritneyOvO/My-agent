import path from "node:path";
import { readdir } from "node:fs/promises";
import { audit } from "../core/audit.js";
import { ensureDir, readJsonFile, writeJsonFile } from "../lib/fs.js";
import { taskFilePath, tasksDir } from "../lib/task-path.js";
import { appendAiToolResults, appendAiUserMessage, createAiToolLoopState, getAiToolLoopTranscript, readAiConfig, runAiCompletion, type AiCompletionResult, type AiNativeToolResult, type AiStreamEvent, type AiToolCallRequest } from "../lib/ai-config.js";
import { ToolDispatcher } from "../tools/dispatcher.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolRunRequest } from "../types/tool.js";
import { publishTaskEvent } from "./task-events.js";

type TaskHistoryEntry = {
  ts: string;
  action: string;
  by: string;
  from?: string;
  to?: string;
  comment?: string;
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
  comments: unknown[];
  artifacts: unknown[];
  result: Record<string, unknown> | null;
};

type ToolCallRecord = {
  ts: string;
  by: string;
  tool: string;
  target: string | null;
  artifact_path?: string;
  call_id?: string;
  source?: string;
  args: string[];
  result: Record<string, unknown>;
};

type ToolRequest = {
  tool: string;
  target?: string;
  artifact_path?: string;
  query?: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
  args: string[];
  call_id?: string;
  source?: string;
};

type AgentStepRecord = {
  step: number;
  ts: string;
  thought: string;
  tool_requests: ToolRequest[];
  tool_calls: ToolCallRecord[];
  analysis: string;
  flags: string[];
};

const running = new Set<string>();
const stopRequested = new Set<string>();
const staleRunningMs = Number.parseInt(process.env.Z3GH0NE_TASK_STALE_MS ?? "600000", 10);
const maxHistoryChars = Number.parseInt(process.env.Z3GH0NE_AGENT_HISTORY_CHARS ?? "14000", 10);
const aiMaxRetries = Math.max(1, Number.parseInt(process.env.Z3GH0NE_AI_MAX_RETRIES ?? "5", 10));
const aiStreamEnabled = process.env.Z3GH0NE_AI_STREAM !== "0";
const flagPattern = /(?:flag|ctf|DASCTF|NSSCTF|BUU|GZCTF|XCTF)\{[^\r\n{}]{1,200}\}/gi;

function nowIso() {
  return new Date().toISOString();
}

async function loadTask(taskId: string) {
  return readJsonFile<StoredTask>(taskFilePath(taskId));
}

async function saveTask(task: StoredTask) {
  await writeJsonFile(taskFilePath(task.task_id), task);
}

export function stopTaskExecution(taskId: string) {
  stopRequested.add(taskId);
}

function isTerminalStatus(status: string) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

async function shouldStopExecution(taskId: string) {
  if (stopRequested.has(taskId)) return true;
  const latest = await loadTask(taskId);
  return isTerminalStatus(latest.status);
}

export async function appendTaskToolCall(taskId: string, input: {
  by: string;
  tool: string;
  target?: string | null;
  args: string[];
  result: Record<string, unknown>;
}) {
  const task = await loadTask(taskId);
  const now = nowIso();
  const result = task.result && typeof task.result === "object" ? task.result : {};
  const calls = Array.isArray(result.tool_calls) ? result.tool_calls as unknown[] : [];
  calls.push({
    ts: now,
    by: input.by,
    tool: input.tool,
    target: input.target ?? null,
    args: input.args,
    result: input.result
  });
  result.tool_calls = calls;
  task.result = result;
  task.updated_at = now;
  task.history.push({ ts: now, action: "tool_run", by: input.by, comment: `${input.tool} exit=${String(input.result.exit_code ?? input.result.error_code ?? "unknown")}` });
  await saveTask(task);
  publishTaskEvent(taskId, "tool.result", { task, tool_call: calls.at(-1) ?? null });
  return task;
}

function availableToolText() {
  return new ToolRegistry().list().filter((tool) => tool.available).map((tool) => (
    `- ${tool.name}: risk=${tool.risk ?? "low"}, requires_target=${String(tool.requires_target)}, timeout=${tool.timeout}s`
  )).join("\n");
}

function artifactText(task: StoredTask) {
  if (!Array.isArray(task.artifacts) || !task.artifacts.length) return "无";
  return task.artifacts.map((item) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return `- ${String(record.path ?? "")} ${record.label ? `(${String(record.label)})` : ""}`.trim();
  }).join("\n") || "无";
}

const defaultSystemPrompt = [
  "You are a CTF Agent.You and the user share the same workspace and collaborate to achieve the user's goals.",
  "",
  "# Personality",
  "",
  "You are a deeply pragmatic, effective software engineer. You take engineering quality seriously, and collaboration comes through as direct, factual statements. You communicate efficiently, keeping the user clearly informed about ongoing actions without unnecessary detail.",
  "",
  "## Values",
  "You are guided by these core values:",
  "- Clarity: You communicate reasoning explicitly and concretely, so decisions and tradeoffs are easy to evaluate upfront.",
  "- Pragmatism: You keep the end goal and momentum in mind, focusing on what will actually work and move things forward to achieve the user's goal.",
  "- Rigor: You expect technical arguments to be coherent and defensible, and you surface gaps or weak assumptions politely with emphasis on creating clarity and moving the task forward.",
  "",
  "## Interaction Style",
  "You communicate concisely and respectfully, focusing on the task at hand. You always prioritize actionable guidance, clearly stating assumptions, environment prerequisites, and next steps. Unless explicitly asked, you avoid excessively verbose explanations about your work.",
  "",
  "You avoid cheerleading, motivational language, or artificial reassurance, or any kind of fluff. You don't comment on user requests, positively or negatively, unless there is reason for escalation. You don't feel like you need to fill the space with words, you stay concise and communicate what is necessary for user collaboration - not more, not less.",
  "",
  "## Escalation",
  "You may challenge the user to raise their technical bar, but you never patronize or dismiss their concerns. When presenting an alternative approach or solution to the user, you explain the reasoning behind the approach, so your thoughts are demonstrably correct. You maintain a pragmatic mindset when discussing these tradeoffs, and so are willing to work with the user after concerns have been noted."
].join("\n");

function systemPrompt() {
  return [
    defaultSystemPrompt,
    "",
    "默认中文输出。目标是解决 CTF 题目或推进到明确可执行的下一步，而不是泛泛建议。",
    "如果任务信息不足，要明确指出缺少什么；不要假装访问了没有提供的系统。",
    "可用工具如下：",
    availableToolText(),
    "",
    "工具调用规则：",
    "1. 优先使用 Responses API function tool `run_tool`。",
    "2. 如果当前模型不支持函数调用，才在回复最后输出 XML 或 JSON 工具计划。",
    "3. JSON 格式：{\"tool_calls\":[{\"tool\":\"工具名\",\"target\":\"可选URL或Host\",\"artifact_path\":\"可选上传文件名或本地绝对路径\",\"args\":[\"可选参数\"]}],\"reason\":\"原因\"}",
    "4. XML 格式：<tool_calls><tool_call name=\"工具名\"><arg key=\"target\">...</arg></tool_call></tool_calls>",
    "5. file/readelf/objdump/exiftool/binwalk/tshark_summary/r2 是附件/文件工具：必须提供 artifact_path（上传文件名或后端可访问的本地绝对路径），或 args 中是真实本地文件路径；绝不能把 URL/IP/Host 当文件名。",
    "6. unzip_list/unzip/7z_list/7z_extract/rar_list/rar_extract/tar_list/tar_extract/gzip_decompress/bzip2_decompress/xz_decompress 是压缩包工具；优先先 list 再 extract，必要时用 args 指定真实本地文件路径或解压参数。rar_list/rar_extract 使用 unrar 专用工具。",
    "7. r2 是 radare2 包装工具：artifact_path 指向二进制；args 是 r2 命令列表，例如 [\"aaa\",\"iI\",\"afl\",\"pdf @ main\",\"izz\"]；不传 args 时默认输出 iI/afl/izz。",
    "8. python 用于执行短 Python 代码或上传的 .py 脚本：短代码使用 args=[\"-c\", \"代码\"]；上传脚本使用 artifact_path。优先编写可复现的小脚本处理编码、解密、数据转换和附件分析。",
    "9. curl/whatweb/nmap/ffuf 是网络工具：必须提供 target，且不要把 target 重复放进 args。curl 用于 HTTP 探测、带 Header/API 请求和查看响应头体。",
    "10. web_search 用于搜索公网最新资料：优先传 query 字段，例如 {\"tool\":\"web_search\",\"query\":\"OpenAI Responses web search docs 2026\"}；需要限制域名时可传 allowed_domains 或 blocked_domains。",
    "11. 如果工具失败，基于错误反思并换路径；不要重复同样失败调用。",
    "12. 一次最多规划少量有依赖关系的工具调用。",
  ].join("\n");
}

function buildPrompt(task: StoredTask) {
  return [
    `任务 ID: ${task.task_id}`,
    `模式: ${task.mode}`,
    `优先级: ${task.priority}`,
    `目标: ${task.target || "未指定"}`,
    `标签: ${task.tags.join(", ") || "无"}`,
    "附件:",
    artifactText(task),
    "",
    "用户任务:",
    task.prompt
  ].join("\n");
}

function parseStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isNetworkTarget(value: string | undefined) {
  if (!value) return false;
  return /^https?:\/\//i.test(value) || /^(?:localhost|127\.0\.0\.1|\[[^\]]+\]|[\w.-]+)(?::\d+)?(?:\/.*)?$/i.test(value);
}

function toolMeta(toolName: string) {
  return new ToolRegistry().get(toolName);
}

function normalizeToolRequest(value: unknown, source = "json"): ToolRequest | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const toolName = typeof record.tool === "string" ? record.tool : typeof record.tool_name === "string" ? record.tool_name : typeof record.name === "string" ? record.name : "";
  if (!toolName.trim()) return null;
  const rawArgs = record.args ?? record.arguments;
  const request: ToolRequest = { tool: toolName.trim(), args: Array.isArray(rawArgs) ? parseStringArray(rawArgs) : [], source };
  if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    const argsRecord = rawArgs as Record<string, unknown>;
    if (typeof argsRecord.target === "string") record.target = argsRecord.target;
    if (typeof argsRecord.artifact_path === "string") record.artifact_path = argsRecord.artifact_path;
    if (typeof argsRecord.query === "string") record.query = argsRecord.query;
    if (Array.isArray(argsRecord.allowed_domains)) record.allowed_domains = argsRecord.allowed_domains;
    if (Array.isArray(argsRecord.blocked_domains)) record.blocked_domains = argsRecord.blocked_domains;
    if (typeof argsRecord.content === "string") request.args.push(argsRecord.content);
  }
  if (typeof record.target === "string" && record.target.trim()) request.target = record.target.trim();
  if (typeof record.artifact_path === "string" && record.artifact_path.trim()) request.artifact_path = record.artifact_path.trim();
  if (typeof record.query === "string" && record.query.trim()) request.query = record.query.trim();
  if (Array.isArray(record.allowed_domains)) request.allowed_domains = parseStringArray(record.allowed_domains);
  if (Array.isArray(record.blocked_domains)) request.blocked_domains = parseStringArray(record.blocked_domains);
  if (typeof record.call_id === "string" && record.call_id.trim()) request.call_id = record.call_id.trim();
  return sanitizeToolRequest(request);
}

function sanitizeToolRequest(request: ToolRequest): ToolRequest | null {
  const meta = toolMeta(request.tool);
  if (!meta) {
    return {
      tool: "__invalid_tool_request__",
      args: request.args,
      ...(request.target ? { target: request.target } : {}),
      ...(request.query ? { query: request.query } : {}),
      ...(request.allowed_domains?.length ? { allowed_domains: request.allowed_domains } : {}),
      ...(request.blocked_domains?.length ? { blocked_domains: request.blocked_domains } : {}),
      ...(request.source ? { source: request.source } : {}),
      ...(request.call_id ? { call_id: request.call_id } : {}),
      ...(request.artifact_path ? { artifact_path: request.artifact_path } : {})
    };
  }
  const cleaned: ToolRequest = { ...request, args: [...request.args] };
  if (meta.requires_target && cleaned.target) {
    cleaned.args = cleaned.args.filter((arg) => arg !== cleaned.target);
  }
  if (request.tool !== "web_search" && !meta.requires_target && cleaned.target && isNetworkTarget(cleaned.target) && !cleaned.artifact_path) {
    return {
      tool: "__invalid_tool_request__",
      args: [],
      target: cleaned.target,
      ...(cleaned.query ? { query: cleaned.query } : {}),
      ...(cleaned.source ? { source: cleaned.source } : {}),
      ...(cleaned.call_id ? { call_id: cleaned.call_id } : {}),
      ...(cleaned.artifact_path ? { artifact_path: cleaned.artifact_path } : {})
    };
  }
  return cleaned;
}

function aiToolRequests(calls: AiToolCallRequest[] | undefined) {
  return (calls ?? []).map((call) => normalizeToolRequest(call, "function_call")).filter((item): item is ToolRequest => Boolean(item));
}

function explicitToolRequests(task: StoredTask) {
  const text = `${task.prompt}\n${task.target ?? ""}`;
  const tools = new ToolRegistry().list().filter((tool) => text.includes(tool.name));
  const urls = Array.from(text.matchAll(/https?:\/\/[^\s"'`<>]+/g)).map((m) => m[0]);
  const host = task.target || urls[0] || "";
  return tools.map((tool) => {
    const request: ToolRequest = { tool: tool.name, args: [], source: "explicit_prompt" };
    if (tool.requires_target && host) request.target = host;
    const artifact = Array.isArray(task.artifacts) ? task.artifacts.find((item) => item && typeof item === "object" && typeof (item as Record<string, unknown>).path === "string") : null;
    if (!tool.requires_target && artifact) request.artifact_path = String((artifact as Record<string, unknown>).path);
    return sanitizeToolRequest(request);
  }).filter((item): item is ToolRequest => Boolean(item));
}

function parseToolRequestXml(text: string) {
  const requests: ToolRequest[] = [];
  const blocks = Array.from(text.matchAll(/<tool_call\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/tool_call>/gi));
  for (const block of blocks) {
    const record: Record<string, unknown> = { tool: block[1], args: [] };
    const body = block[2] ?? "";
    for (const arg of body.matchAll(/<arg\s+key=["']([^"']+)["']\s*>([\s\S]*?)<\/arg>/gi)) {
      const key = arg[1] ?? "";
      const value = (arg[2] ?? "").trim();
      if (key === "args") record.args = value ? value.split(/\s+/) : [];
      else record[key] = value;
    }
    const normalized = normalizeToolRequest(record, "xml_text");
    if (normalized) requests.push(normalized);
  }
  return requests;
}

function parseToolRequestJson(text: string) {
  const candidates = [
    text.trim(),
    ...Array.from(text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)).map((match) => match[1]?.trim() ?? ""),
    text.includes("{") ? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1) : ""
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const calls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : Array.isArray(parsed.tools) ? parsed.tools : [];
      const requests = calls.map((call) => normalizeToolRequest(call, "json_text")).filter((item): item is ToolRequest => Boolean(item));
      if (requests.length) return requests;
      if (typeof parsed.tool === "string" || typeof parsed.tool_name === "string" || typeof parsed.name === "string") {
        const request = normalizeToolRequest(parsed, "json_text");
        if (request) return [request];
      }
    } catch {
      const requests = parseAdjacentToolRequestJson(candidate);
      if (requests.length) return requests;
    }
  }
  return parseToolRequestXml(text);
}

function parseAdjacentToolRequestJson(text: string) {
  const requests: ToolRequest[] = [];
  for (const objectText of splitAdjacentJsonObjects(text)) {
    try {
      const parsed = JSON.parse(objectText) as Record<string, unknown>;
      const request = normalizeToolRequest(parsed, "json_text");
      if (request) requests.push(request);
    } catch {
      continue;
    }
  }
  return requests;
}

function splitAdjacentJsonObjects(text: string) {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return objects.length > 1 ? objects : [];
}

function dedupeToolRequests(requests: ToolRequest[]) {
  const seen = new Set<string>();
  return requests.filter((request) => {
    const key = JSON.stringify({ tool: request.tool, target: request.target ?? null, artifact_path: request.artifact_path ?? null, args: request.args });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractFlags(...texts: unknown[]) {
  const found = new Set<string>();
  for (const text of texts) {
    if (typeof text !== "string") continue;
    for (const match of text.matchAll(flagPattern)) found.add(match[0]);
  }
  return [...found];
}

async function runRequestedTool(task: StoredTask, request: ToolRequest): Promise<ToolCallRecord> {
  if (request.tool === "__invalid_tool_request__") {
    return {
      ts: nowIso(),
      by: "agent-hub-ai",
      tool: request.tool,
      target: request.target ?? null,
      args: request.args,
      ...(request.source ? { source: request.source } : {}),
      result: {
        allowed: false,
        error_code: "invalid_tool_request",
        error: "文件/附件工具不能把 URL、IP 或 Host 当成文件名；请提供 artifact_path，或改用 whatweb/nmap/ffuf 等网络工具"
      },
      ...(request.call_id ? { call_id: request.call_id } : {})
    };
  }

  const runRequest: ToolRunRequest = {
    tool: request.tool,
    mode: task.mode || "local_lab",
    args: request.args
  };
  if (request.target) runRequest.target = request.target;
  if (request.artifact_path) runRequest.artifact_path = request.artifact_path;
  if (request.query) runRequest.query = request.query;
  if (request.allowed_domains) runRequest.allowed_domains = request.allowed_domains;
  if (request.blocked_domains) runRequest.blocked_domains = request.blocked_domains;
  const result = await new ToolDispatcher().run(runRequest) as Record<string, unknown>;
  return {
    ts: nowIso(),
    by: "agent-hub-ai",
    tool: request.tool,
    target: request.target ?? null,
    args: request.args,
    ...(request.source ? { source: request.source } : {}),
    result,
    ...(request.call_id ? { call_id: request.call_id } : {}),
    ...(request.artifact_path ? { artifact_path: request.artifact_path } : {})
  };
}

function compactToolCall(call: ToolCallRecord) {
  return {
    tool: call.tool,
    target: call.target,
    artifact_path: call.artifact_path,
    call_id: call.call_id,
    source: call.source,
    args: call.args,
    result: {
      allowed: call.result.allowed,
      exit_code: call.result.exit_code,
      error_code: call.result.error_code,
      error: call.result.error,
      output: typeof call.result.output === "string" ? call.result.output.slice(0, 8000) : undefined,
      truncated: call.result.truncated
    }
  };
}

function summarizeSteps(steps: AgentStepRecord[]) {
  const text = steps.map((step) => [
    `步骤 ${step.step}:`,
    `思考/回复: ${step.thought.slice(0, 1200)}`,
    step.tool_calls.length ? `工具结果: ${step.tool_calls.map((call) => `${call.tool}(${call.target ?? call.artifact_path ?? call.args.join(" ")}) => ${String(call.result.exit_code ?? call.result.error_code ?? "done")} ${String(call.result.error ?? call.result.output ?? "").slice(0, 1200)}`).join("\n")}` : "工具结果: 无",
    step.flags.length ? `疑似 Flag: ${step.flags.join(", ")}` : ""
  ].filter(Boolean).join("\n")).join("\n---\n");
  return text.length > maxHistoryChars ? text.slice(-maxHistoryChars) : text;
}

function buildAgentStepPrompt(task: StoredTask, steps: AgentStepRecord[]) {
  if (!steps.length) return buildPrompt(task);
  return [
    buildPrompt(task),
    "",
    "执行历史摘要：",
    summarizeSteps(steps),
    "",
    "请分析上一轮结果并决定下一步。",
    "- 如果需要继续验证，调用最合适的工具。",
    "- 如果已经能得出结论或发现 flag，直接输出最终答案。",
    "- 不要重复执行完全相同且已经失败的工具调用。"
  ].join("\n");
}

function mergeUsage(usages: Record<string, unknown>[]) {
  return usages.reduce<Record<string, unknown>>((acc, usage) => {
    for (const [key, value] of Object.entries(usage)) {
      if (typeof value === "number") acc[key] = Number(acc[key] ?? 0) + value;
      else if (!(key in acc)) acc[key] = value;
    }
    return acc;
  }, {});
}

function finalReviewPrompt(candidate: string) {
  return [
    "FINAL_REVIEW：你刚才准备结束任务。请先严格审查是否已经真的得到任务要求的结果。",
    "",
    "通过标准：",
    "- 已找到明确 flag / 答案 / 可验证结论；或",
    "- 已给出可复现的利用步骤、关键证据和最终判断；且",
    "- 不存在明显还没读取/没验证/没执行但应该继续做的步骤。",
    "",
    "如果通过：必须以 `REVIEW_PASS` 开头，然后输出最终答案。",
    "如果不通过：不要输出最终答案，直接继续分析；需要工具就立刻调用 run_tool。",
    "如果当前模型不能继续工具调用，则输出 JSON/XML 工具计划。",
    "",
    "待审查的候选最终回复：",
    candidate.slice(0, 6000)
  ].join("\n");
}

function continueAfterFailedReviewPrompt(reviewText: string) {
  return [
    "FINAL_REVIEW 未通过：你还没有得到足够明确的结果。",
    "请继续执行下一步，不要结束任务。",
    "优先根据缺口调用最合适的工具；不要重复完全相同且已经失败的工具调用。",
    "",
    "刚才的审查/回复：",
    reviewText.slice(0, 6000)
  ].join("\n");
}

function isFinalReviewPass(text: string) {
  return /^\s*REVIEW_PASS\b/i.test(text) || /最终审查\s*[:：]?\s*(通过|pass)/i.test(text);
}

function stripFinalReviewPass(text: string) {
  return text.replace(/^\s*REVIEW_PASS\b\s*[:：-]?\s*/i, "").trim();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableAiError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:\b429\b|\b5\d\d\b|timeout|超时|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|network|socket|aborted)/i.test(message);
}

function aiErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function collectToolRequests(task: StoredTask, completion: AiCompletionResult, allowExplicit: boolean) {
  const byFunctionCall = aiToolRequests(completion.tool_calls);
  const byJsonText = parseToolRequestJson(completion.text);
  const byExplicitPrompt = allowExplicit && !byFunctionCall.length && !byJsonText.length ? explicitToolRequests(task) : [];
  return dedupeToolRequests([...byFunctionCall, ...byJsonText, ...byExplicitPrompt]);
}

async function persistProgress(taskId: string, by: string, partial: {
  provider: string;
  model: string;
  startedAt: string;
  steps: AgentStepRecord[];
  toolCalls: ToolCallRecord[];
  rawResponses: unknown[];
  aiFunctionToolCalls: AiToolCallRequest[];
  aiToolRequest: string;
  usage: Record<string, unknown>[];
  nativeTranscript?: unknown;
}) {
  const latest = await loadTask(taskId);
  const previousResult = latest.result && typeof latest.result === "object" ? latest.result : {};
  latest.result = {
    ...previousResult,
    executor: "agent-hub-ai",
    provider: partial.provider,
    model: partial.model,
    ai_tool_request: partial.aiToolRequest,
    ai_function_tool_calls: partial.aiFunctionToolCalls,
    raw_tool_request_response: partial.rawResponses.at(-1) ?? null,
    raw_responses: partial.rawResponses,
    native_tool_loop: partial.nativeTranscript ?? null,
    agent_steps: partial.steps,
    tool_calls: partial.toolCalls,
    usage: mergeUsage(partial.usage),
    started_at: partial.startedAt
  };
  latest.updated_at = nowIso();
  const lastStep = partial.steps.at(-1);
  if (lastStep) {
    latest.history.push({ ts: latest.updated_at, action: "agent_step", by, comment: `step=${lastStep.step} tools=${lastStep.tool_calls.length}` });
  }
  await saveTask(latest);
  publishTaskEvent(taskId, "agent.progress", {
    task: latest,
    step: lastStep ?? null,
    steps: partial.steps.length,
    tool_calls: partial.toolCalls.length
  });
}

async function persistActivity(taskId: string, activity: Record<string, unknown>) {
  const latest = await loadTask(taskId);
  if (isTerminalStatus(latest.status)) return latest;
  const previousResult = latest.result && typeof latest.result === "object" ? latest.result : {};
  latest.result = {
    ...previousResult,
    executor: previousResult.executor ?? "agent-hub-ai",
    current_activity: {
      ts: nowIso(),
      ...activity
    }
  };
  latest.updated_at = nowIso();
  await saveTask(latest);
  publishTaskEvent(taskId, "activity", { task: latest, activity: latest.result.current_activity });
  return latest;
}

async function setStatus(task: StoredTask, status: string, by: string, comment?: string) {
  const oldStatus = task.status;
  task.status = status;
  task.updated_at = nowIso();
  const entry: TaskHistoryEntry = { ts: task.updated_at, action: "status_change", by, from: oldStatus, to: status };
  if (comment) entry.comment = comment;
  task.history.push(entry);
  await saveTask(task);
  await audit("task_status_changed", { user: by, task_id: task.task_id, from: oldStatus, to: status });
  publishTaskEvent(task.task_id, "task.status", { task, from: oldStatus, to: status, comment: comment ?? null });
}

export function scheduleTaskExecution(taskId: string, by = "agent-hub") {
  if (running.has(taskId)) return;
  stopRequested.delete(taskId);
  running.add(taskId);
  setTimeout(() => {
    executeTask(taskId, by).finally(() => running.delete(taskId));
  }, 0);
}

export async function recoverActiveTasks(by = "agent-hub") {
  await ensureDir(tasksDir());
  const entries = await readdir(tasksDir(), { withFileTypes: true });
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const task = await readJsonFile<StoredTask>(path.join(tasksDir(), entry.name));
      if (!["pending", "running"].includes(task.status)) continue;
      const touched = Date.parse(task.updated_at || task.created_at || "");
      if (Number.isFinite(touched) && now - touched > staleRunningMs) {
        const failedAt = nowIso();
        const previous = task.status;
        task.status = "failed";
        task.updated_at = failedAt;
        task.result = {
          executor: "agent-hub-ai",
          error: `任务执行状态过期：服务启动恢复时发现该任务已 ${previous} 超过 ${Math.round(staleRunningMs / 1000)}s`,
          failed_at: failedAt
        };
        task.history.push({ ts: failedAt, action: "stale_recovered", by, comment: task.result.error as string });
        task.history.push({ ts: failedAt, action: "status_change", by, from: previous, to: "failed" });
        await saveTask(task);
        await audit("task_execution_failed", { user: by, task_id: task.task_id, error: task.result.error });
        continue;
      }
      scheduleTaskExecution(task.task_id, by);
    } catch {
      continue;
    }
  }
}

export async function executeTask(taskId: string, by = "agent-hub") {
  const task = await loadTask(taskId);
  if (!["pending", "running"].includes(task.status)) return task;

  if (task.status === "pending") {
    await setStatus(task, "running", by, "自动执行器已接管任务");
  }

  try {
    const config = await readAiConfig();
    const startedAt = nowIso();
    const steps: AgentStepRecord[] = [];
    const allToolCalls: ToolCallRecord[] = [];
    const rawResponses: unknown[] = [];
    const aiFunctionToolCalls: AiToolCallRequest[] = [];
    const usages: Record<string, unknown>[] = [];
    let finalCompletion: AiCompletionResult | null = null;
    let lastAiToolRequest = "";
    let provider = config.provider;
    let model = config.model;
    let finalText = "";
    let finalFlags: string[] = [];
    const toolLoop = createAiToolLoopState(buildPrompt(task), systemPrompt());
    let awaitingFinalReview = false;

    let step = 1;
    while (true) {
      if (await shouldStopExecution(taskId)) {
        return await loadTask(taskId);
      }

      let completion: AiCompletionResult | null = null;
      let lastAiError: unknown = null;
      const aiErrors: string[] = [];
      for (let attempt = 1; attempt <= aiMaxRetries; attempt += 1) {
        await persistActivity(taskId, {
          phase: attempt === 1 ? "ai_request" : "ai_retry",
          step,
          provider,
          model,
          attempt,
          max_attempts: aiMaxRetries,
          message: attempt === 1 ? `正在请求 AI 规划下一步（最多 ${aiMaxRetries} 次）` : `AI 请求失败，正在第 ${attempt}/${aiMaxRetries} 次重试`,
          ...(lastAiError ? { last_error: aiErrorMessage(lastAiError), errors: aiErrors } : {})
        });
        try {
          completion = await runAiCompletion(config, toolLoop, "", 2400, {
            stream: aiStreamEnabled,
            onStreamEvent: async (event: AiStreamEvent) => {
              if (event.type === "delta") {
                publishTaskEvent(taskId, "assistant.delta", {
                  step,
                  provider,
                  model,
                  text: event.text ?? ""
                });
                return;
              }
              if (event.type === "message") {
                publishTaskEvent(taskId, "assistant.message", {
                  step,
                  provider,
                  model,
                  text: event.text ?? ""
                });
                return;
              }
              if (event.type === "error") {
                publishTaskEvent(taskId, "assistant.error", {
                  step,
                  provider,
                  model,
                  error: event.text ?? "AI stream error"
                });
              }
            }
          });
          break;
        } catch (error) {
          lastAiError = error;
          aiErrors.push(aiErrorMessage(error));
          if (!isRetryableAiError(error)) {
            throw new Error(`AI 请求失败（不可重试）：${aiErrorMessage(error)}`);
          }
          if (attempt >= aiMaxRetries) {
            throw new Error(`AI 请求连续 ${aiMaxRetries} 次失败，任务最终失败。最后错误：${aiErrorMessage(error)}`);
          }
          await sleep(Math.min(800 * attempt, 5000));
        }
      }
      if (!completion) {
        throw new Error(`AI 请求连续 ${aiMaxRetries} 次失败，任务最终失败。最后错误：${aiErrorMessage(lastAiError ?? "AI 请求失败")}`);
      }
      if (await shouldStopExecution(taskId)) {
        return await loadTask(taskId);
      }

      finalCompletion = completion;
      provider = completion.provider;
      model = completion.model;
      usages.push(completion.usage);
      rawResponses.push(completion.raw ?? null);
      aiFunctionToolCalls.push(...(completion.tool_calls ?? []));
      lastAiToolRequest = completion.text;

      const toolRequests = collectToolRequests(task, completion, step === 1);
      const textFlags = extractFlags(completion.text);

      if (!toolRequests.length) {
        if (awaitingFinalReview && isFinalReviewPass(completion.text)) {
          finalText = stripFinalReviewPass(completion.text);
          finalFlags = textFlags;
          steps.push({ step, ts: nowIso(), thought: completion.text, tool_requests: [], tool_calls: [], analysis: textFlags.length ? `最终审查通过，发现疑似 flag：${textFlags.join(", ")}` : "最终审查通过，作为最终答案。", flags: textFlags });
          break;
        }

        const analysis = awaitingFinalReview
          ? "最终审查未通过且 AI 未调用工具，已追加继续提示。"
          : "AI 准备无工具结束，已追加最终审查提示。";
        steps.push({ step, ts: nowIso(), thought: completion.text, tool_requests: [], tool_calls: [], analysis, flags: textFlags });

        appendAiUserMessage(
          toolLoop,
          awaitingFinalReview ? continueAfterFailedReviewPrompt(completion.text) : finalReviewPrompt(completion.text)
        );
        awaitingFinalReview = true;

        await persistProgress(taskId, by, {
          provider,
          model,
          startedAt,
          steps,
          toolCalls: allToolCalls,
          rawResponses,
          aiFunctionToolCalls,
          aiToolRequest: lastAiToolRequest,
          usage: usages,
          nativeTranscript: getAiToolLoopTranscript(toolLoop)
        });
        step += 1;
        continue;
      }

      awaitingFinalReview = false;

      const stepCalls: ToolCallRecord[] = [];
      const currentStep: AgentStepRecord = {
        step,
        ts: nowIso(),
        thought: completion.text,
        tool_requests: toolRequests,
        tool_calls: stepCalls,
        analysis: `AI 请求 ${toolRequests.length} 个工具，准备执行。`,
        flags: textFlags
      };
      steps.push(currentStep);
      await persistProgress(taskId, by, {
        provider,
        model,
        startedAt,
        steps,
        toolCalls: allToolCalls,
        rawResponses,
        aiFunctionToolCalls,
        aiToolRequest: lastAiToolRequest,
        usage: usages,
        nativeTranscript: getAiToolLoopTranscript(toolLoop)
      });

      for (const request of toolRequests) {
        if (await shouldStopExecution(taskId)) {
          return await loadTask(taskId);
        }
        await persistActivity(taskId, {
          phase: "tool_running",
          step,
          provider,
          model,
          tool: request.tool,
          target: request.target ?? null,
          artifact_path: request.artifact_path ?? null,
          args: request.args,
          done: stepCalls.length,
          total: toolRequests.length,
          message: `正在执行工具 ${stepCalls.length + 1}/${toolRequests.length}: ${request.tool}`
        });
        const call = await runRequestedTool(task, request);
        if (await shouldStopExecution(taskId)) {
          return await loadTask(taskId);
        }
        stepCalls.push(call);
        allToolCalls.push(call);
        currentStep.analysis = `已完成 ${stepCalls.length}/${toolRequests.length} 个工具，等待本轮剩余工具执行。`;
        await audit("tool_run", {
          user: by,
          task_id: taskId,
          tool: call.tool,
          target: call.target,
          result: Object.fromEntries(Object.entries(call.result).filter(([key]) => key !== "output"))
        });
        await persistProgress(taskId, by, {
          provider,
          model,
          startedAt,
          steps,
          toolCalls: allToolCalls,
          rawResponses,
          aiFunctionToolCalls,
          aiToolRequest: lastAiToolRequest,
          usage: usages,
          nativeTranscript: getAiToolLoopTranscript(toolLoop)
        });
      }

      appendAiToolResults(toolLoop, completion, stepCalls.map((call): AiNativeToolResult => {
        const result: AiNativeToolResult = {
          tool: call.tool,
          target: call.target,
          args: call.args,
          result: call.result
        };
        if (call.artifact_path) result.artifact_path = call.artifact_path;
        if (call.call_id) result.call_id = call.call_id;
        return result;
      }));

      const outputFlags = extractFlags(...stepCalls.map((call) => call.result.output), ...stepCalls.map((call) => call.result.error));
      const flags = Array.from(new Set([...textFlags, ...outputFlags]));
      const analysis = flags.length
        ? `工具输出中发现疑似 flag：${flags.join(", ")}；不自动结束，继续交给 AI 复核。`
        : `执行 ${stepCalls.length} 个工具，进入下一轮分析。`;
      currentStep.analysis = analysis;
      currentStep.flags = flags;

      await persistProgress(taskId, by, {
        provider,
        model,
        startedAt,
        steps,
        toolCalls: allToolCalls,
        rawResponses,
        aiFunctionToolCalls,
        aiToolRequest: lastAiToolRequest,
        usage: usages,
        nativeTranscript: getAiToolLoopTranscript(toolLoop)
      });

      step += 1;
    }

    const finishedAt = nowIso();
    const latest = await loadTask(taskId);
    if (isTerminalStatus(latest.status)) {
      return latest;
    }
    const previousResult = latest.result && typeof latest.result === "object" ? latest.result : {};
    latest.result = {
      ...previousResult,
      executor: "agent-hub-ai",
      provider,
      model,
      current_activity: null,
      text: finalText,
      flags: finalFlags,
      usage: mergeUsage(usages),
      ai_tool_request: lastAiToolRequest,
      ai_function_tool_calls: aiFunctionToolCalls,
      raw_tool_request_response: rawResponses.at(-1) ?? null,
      raw_response: rawResponses.length <= 2 ? (rawResponses.length === 1 ? rawResponses[0] : { initial: rawResponses[0], final: rawResponses.at(-1) }) : { responses: rawResponses },
      raw_responses: rawResponses,
      native_tool_loop: getAiToolLoopTranscript(toolLoop),
      agent_steps: steps,
      tool_calls: allToolCalls,
      started_at: startedAt,
      completed_at: finishedAt
    };
    latest.status = "completed";
    latest.updated_at = finishedAt;
    latest.history.push({ ts: finishedAt, action: "executed", by, comment: `provider=${provider} model=${model} steps=${steps.length}` });
    latest.history.push({ ts: finishedAt, action: "status_change", by, from: "running", to: "completed" });
    await saveTask(latest);
    await audit("task_executed", { user: by, task_id: taskId, provider: finalCompletion?.provider ?? provider, model: finalCompletion?.model ?? model, steps: steps.length, flags: finalFlags });
    publishTaskEvent(taskId, "final", { task: latest, text: finalText, flags: finalFlags });
    return latest;
  } catch (error) {
    const failedAt = nowIso();
    const latest = await loadTask(taskId);
    if (isTerminalStatus(latest.status)) {
      return latest;
    }
    const previousResult = latest.result && typeof latest.result === "object" ? latest.result : {};
    latest.result = {
      ...previousResult,
      executor: "agent-hub-ai",
      current_activity: null,
      error: error instanceof Error ? error.message : String(error),
      failed_at: failedAt
    };
    latest.status = "failed";
    latest.updated_at = failedAt;
    latest.history.push({ ts: failedAt, action: "execution_failed", by, comment: latest.result.error as string });
    latest.history.push({ ts: failedAt, action: "status_change", by, from: "running", to: "failed" });
    await saveTask(latest);
    await audit("task_execution_failed", { user: by, task_id: taskId, error: latest.result.error });
    publishTaskEvent(taskId, "error", { task: latest, error: latest.result.error });
    return latest;
  }
}
