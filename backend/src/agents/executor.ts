import path from "node:path";
import { readdir } from "node:fs/promises";
import { audit } from "../core/audit.js";
import { env } from "../lib/env.js";
import { ensureDir, readJsonFile, writeJsonFile } from "../lib/fs.js";
import { taskFilePath, tasksDir } from "../lib/task-path.js";
import { appendAiToolResults, appendAiUserMessage, createAiToolLoopState, getAiToolLoopTranscript, readAiConfig, runAiCompletion, type AiCompletionResult, type AiNativeToolResult, type AiStreamEvent, type AiToolCallRequest } from "../lib/ai-config.js";
import { ToolDispatcher } from "../tools/dispatcher.js";
import { ToolRegistry } from "../tools/registry.js";
import type { CtfContext } from "../types/task.js";
import type { ToolRunRequest } from "../types/tool.js";
import { isContextLengthAiError, maybeCompactAiContext } from "./context-manager.js";
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
  ctf_context?: CtfContext;
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
  input?: Record<string, unknown>;
  result: Record<string, unknown>;
};

type ToolRequest = {
  tool: string;
  target?: string;
  artifact_path?: string;
  query?: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
  input?: Record<string, unknown>;
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
const autoSubmitTimeoutMs = Number.parseInt(process.env.Z3GH0NE_AUTO_SUBMIT_TIMEOUT_MS ?? "20000", 10);
const flagPattern = /(?<![A-Za-z0-9_])(?:PCTF|DASCTF|NSSCTF|GZCTF|XCTF|BUU|flag|ctf)\{[^\r\n{}]{1,200}\}/gi;

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
  input?: Record<string, unknown>;
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
    ...(input.input ? { input: input.input } : {}),
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
    [
      `- ${tool.name}: kind=${tool.kind ?? "generic"}, risk=${tool.risk ?? "low"}, requires_target=${String(tool.requires_target)}, timeout=${tool.timeout}s`,
      indentToolPrompt(String(tool.prompt ?? tool.description ?? ""))
    ].filter(Boolean).join("\n")
  )).join("\n");
}

function indentToolPrompt(prompt: string) {
  const trimmed = prompt.trim();
  if (!trimmed) return "";
  return trimmed.split(/\r?\n/).map((line) => `  ${line}`).join("\n");
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
    "",
    "CTF Reverse/APK 工作流约束：",
    "- 如果附件是 APK/AAR/DEX 或 Reverse 题，先做定向 triage：file/unzip_list -> aapt_dump 或 jadx_decompile/apktool_decode -> 在反编译目录 Grep 入口类、check/flag/native/JNI/encrypt/decrypt。",
    "- APK 内有 native .so 时，优先 file/readelf_symbols/nm/r2_native_scan 定位 JNI_OnLoad、Java_*、RegisterNatives、check/flag/encrypt/decrypt 相关符号，再用 r2 只看具体函数或地址。",
    "- 禁止先跑全量 strings 分析 APK、classes.dex、.so、ELF、JAR 或大文件；必须使用 strings_grep 加聚焦 regex 和 limit，或先用 jadx/apktool/aapt/r2_native_scan 缩小范围。",
    "- 禁止 readelf -a、全量 objdump -d、全量 r2 反汇编作为探索第一步；使用 readelf_symbols、r2_native_scan、r2 的具体 symbol/address 命令。",
    "- r2 命令中不要使用裸 `|`；把 izz~a|b 这类查询拆成多个 `-c izz~a`、`-c izz~b`。`pd N` 的 N 保持在 100 行以内。",
    "- 如果 jadx/apktool/aapt 不可用，走 unzip -> classes.dex 精确 strings_grep/小脚本解析 -> native .so readelf_symbols/r2_native_scan，不要反复尝试缺失工具。",
    "- 对 classes.dex 搜索时避免只搜 flag/check 这种泛词；优先搜包名、入口类、native 方法名、UI 提示字符串附近引用。",
    "- 一旦定位到 checkFlag/equals/目标 hash/加密链，立即进入求解：写最小 Python solver、逆变换或小规模验证；不要继续枚举无关字符串、资源或库函数。",
    "- 类似 Claude Code 的工具编排方式：搜索和读取都要默认分页/限量；任何 strings/readelf/objdump/r2/python 输出在回灌前先 grep/head/filter，只把能推进判断的片段交给模型。",
    "- APK zip 清单只用于确认 classes.dex、AndroidManifest.xml、lib/*.so、assets 等关键入口；不要把 res/META-INF 全量清单当作分析材料。",
    "可用工具如下：",
    availableToolText(),
    "",
    "工具调用规则：",
    "1. 优先使用 Responses API function tool `run_tool`。",
    "2. 如果当前模型不支持函数调用，才在回复最后输出 XML 或 JSON 工具计划。",
    "3. JSON 格式：{\"tool_calls\":[{\"tool\":\"工具名\",\"target\":\"可选URL或Host\",\"artifact_path\":\"可选上传文件名或本地绝对路径\",\"args\":[\"可选参数\"]}],\"reason\":\"原因\"}",
    "4. XML 格式：<tool_calls><tool_call name=\"工具名\"><arg key=\"target\">...</arg></tool_call></tool_calls>",
    "5. 每个工具的详细用法已列在可用工具说明里；优先按说明中的 input/target/artifact_path/args 传参。",
    "6. Read/Write/Edit/Glob/Grep/LS 是内建文件系统工具，可访问后端可访问的任意路径，不做工作区沙盒限制。结构化参数放入 input。",
    "7. 如果工具失败，基于错误反思并换路径；不要重复同样失败调用。",
    "8. 一次最多规划少量有依赖关系的工具调用。",
    "9. 大输出工具默认最多回灌 8K-20K 字符；如果被截断，下一步必须改用更窄的 grep/head/filter、Read offset/limit、Grep head_limit 或具体 r2 地址/函数，而不是重复全量命令。",
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
    request.input = { ...argsRecord };
  }
  if (typeof record.target === "string" && record.target.trim()) request.target = record.target.trim();
  if (typeof record.artifact_path === "string" && record.artifact_path.trim()) request.artifact_path = record.artifact_path.trim();
  if (typeof record.query === "string" && record.query.trim()) request.query = record.query.trim();
  if (Array.isArray(record.allowed_domains)) request.allowed_domains = parseStringArray(record.allowed_domains);
  if (Array.isArray(record.blocked_domains)) request.blocked_domains = parseStringArray(record.blocked_domains);
  if (record.input && typeof record.input === "object" && !Array.isArray(record.input)) request.input = { ...(record.input as Record<string, unknown>) };
  const structuredInput = Object.fromEntries(Object.entries(record).filter(([key]) => [
    "file_path", "content", "old_string", "new_string", "replace_all", "pattern", "path", "glob", "output_mode",
    "head_limit", "offset", "limit", "multiline", "type", "context", "-A", "-B", "-C", "-i", "-n"
  ].includes(key)));
  if (Object.keys(structuredInput).length) request.input = { ...(request.input ?? {}), ...structuredInput };
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
      ...(request.input ? { input: request.input } : {}),
      ...(request.source ? { source: request.source } : {}),
      ...(request.call_id ? { call_id: request.call_id } : {}),
      ...(request.artifact_path ? { artifact_path: request.artifact_path } : {})
    };
  }
  const cleaned: ToolRequest = { ...request, args: [...request.args] };
  if (meta.requires_target && cleaned.target) {
    cleaned.args = cleaned.args.filter((arg) => arg !== cleaned.target);
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
    const key = JSON.stringify({ tool: request.tool, target: request.target ?? null, artifact_path: request.artifact_path ?? null, input: request.input ?? null, args: request.args });
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

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function allDiscoveredFlags(finalText: string, finalFlags: string[], steps: AgentStepRecord[]) {
  return uniqueStrings([
    ...extractFlags(finalText),
    ...finalFlags,
    ...steps.flatMap((step) => step.flags)
  ]);
}

function selectAutoSubmitFlag(finalText: string, finalFlags: string[], steps: AgentStepRecord[]) {
  const finalTextFlags = extractFlags(finalText);
  if (finalTextFlags.length === 1) {
    return { flag: finalTextFlags[0], candidates: allDiscoveredFlags(finalText, finalFlags, steps), reason: "final_text_unique" };
  }
  if (finalFlags.length === 1) {
    return { flag: finalFlags[0], candidates: allDiscoveredFlags(finalText, finalFlags, steps), reason: "final_flags_unique" };
  }
  const candidates = allDiscoveredFlags(finalText, finalFlags, steps);
  if (candidates.length === 1) {
    return { flag: candidates[0], candidates, reason: "single_discovered_flag" };
  }
  return { flag: "", candidates, reason: candidates.length ? "ambiguous_flags" : "no_flags" };
}

function parseJsonMaybe(text: string) {
  try {
    return text ? JSON.parse(text) as unknown : null;
  } catch {
    return text;
  }
}

function submitStatusFromString(text: string): boolean | null {
  const normalized = text.toLowerCase();
  if (/(wrong|incorrect|invalid|failed|rejected|denied|error|not\s+accepted)/i.test(text)) {
    return false;
  }
  if (/(^|[^a-z])(correct|accepted|success|successful|solved|passed)([^a-z]|$)/i.test(text) || normalized.includes("flagaccepted")) {
    return true;
  }
  return null;
}

function acceptedFromSubmitResponse(value: unknown, seen = new Set<unknown>()): boolean | null {
  if (typeof value === "string") {
    return submitStatusFromString(value);
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  if (seen.has(value)) {
    return null;
  }
  seen.add(value);
  const record = value as Record<string, unknown>;
  for (const key of ["accepted", "ok", "success", "correct", "solved"]) {
    if (typeof record[key] === "boolean") {
      return record[key];
    }
  }
  for (const key of ["status", "state", "result", "message", "msg"]) {
    const nested = record[key];
    if (typeof nested === "string") {
      const accepted = submitStatusFromString(nested);
      if (accepted !== null) {
        return accepted;
      }
    }
  }
  for (const key of ["data", "result", "submit_result", "raw", "response"]) {
    const accepted = acceptedFromSubmitResponse(record[key], seen);
    if (accepted !== null) {
      return accepted;
    }
  }
  for (const nested of Object.values(record)) {
    if (!nested || typeof nested !== "object") {
      continue;
    }
    const accepted = acceptedFromSubmitResponse(nested, seen);
    if (accepted !== null) {
      return accepted;
    }
  }
  return null;
}

async function postJsonWithTimeout(url: string, body: unknown) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), autoSubmitTimeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    const payload = parseJsonMaybe(text);
    return { response, payload, text };
  } finally {
    clearTimeout(timer);
  }
}

async function maybeAutoSubmitFlag(task: StoredTask, finalText: string, finalFlags: string[], steps: AgentStepRecord[]) {
  const context = task.ctf_context;
  if (!context?.auto_submit) {
    return null;
  }
  if (!context.session_id || !context.challenge_id) {
    return {
      enabled: true,
      attempted: false,
      status: "skipped",
      reason: "missing_ctf_context"
    };
  }

  const selection = selectAutoSubmitFlag(finalText, finalFlags, steps);
  if (!selection.flag) {
    return {
      enabled: true,
      attempted: false,
      status: "skipped",
      reason: selection.reason,
      candidates: selection.candidates
    };
  }

  const submittedAt = nowIso();
  const base = env.matchApiBase.replace(/\/+$/, "");
  const suffix = context.contest_id ? `?contest_id=${encodeURIComponent(context.contest_id)}` : "";
  const url = `${base}/api/sessions/${encodeURIComponent(context.session_id)}/challenges/${encodeURIComponent(context.challenge_id)}/submit${suffix}`;

  try {
    const { response, payload, text } = await postJsonWithTimeout(url, { flag: selection.flag });
    const accepted = response.ok ? acceptedFromSubmitResponse(payload) : false;
    const result = {
      enabled: true,
      attempted: true,
      status: response.ok ? "submitted" : "failed",
      reason: selection.reason,
      flag: selection.flag,
      candidates: selection.candidates,
      submitted_at: submittedAt,
      accepted,
      http_status: response.status,
      response: payload
    };
    if (!response.ok) {
      return {
        ...result,
        error: typeof payload === "string" ? payload.slice(0, 1000) : text.slice(0, 1000)
      };
    }
    return result;
  } catch (error) {
    return {
      enabled: true,
      attempted: true,
      status: "failed",
      reason: selection.reason,
      flag: selection.flag,
      candidates: selection.candidates,
      submitted_at: submittedAt,
      accepted: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
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
  if (request.input) runRequest.input = request.input;
  const result = await new ToolDispatcher().run(runRequest) as Record<string, unknown>;
  return {
    ts: nowIso(),
    by: "agent-hub-ai",
    tool: request.tool,
    target: request.target ?? null,
    args: request.args,
    ...(request.input ? { input: request.input } : {}),
    ...(request.source ? { source: request.source } : {}),
    result,
    ...(request.call_id ? { call_id: request.call_id } : {}),
    ...(request.artifact_path ? { artifact_path: request.artifact_path } : {})
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
  compactionEvents?: Record<string, unknown>[];
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
    context_compaction_events: partial.compactionEvents ?? previousResult.context_compaction_events ?? [],
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
    const taskPrompt = buildPrompt(task);
    const toolLoop = createAiToolLoopState(taskPrompt, systemPrompt());
    let awaitingFinalReview = false;

    let step = 1;
    while (true) {
      if (await shouldStopExecution(taskId)) {
        return await loadTask(taskId);
      }

      const compactResult = await maybeCompactAiContext({
        config,
        state: toolLoop,
        taskPrompt,
        steps
      });
      if (compactResult.compacted) {
        await persistActivity(taskId, {
          phase: "context_compacted",
          step,
          provider,
          model,
          message: "上下文接近当前模型窗口，已自动压缩旧步骤。",
          compaction: compactResult.event
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
          nativeTranscript: getAiToolLoopTranscript(toolLoop),
          compactionEvents: toolLoop.compaction?.events ?? []
        });
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
          if (isContextLengthAiError(error)) {
            await persistActivity(taskId, {
              phase: "context_compacting",
              step,
              provider,
              model,
              attempt,
              message: "AI 返回上下文超限，正在按当前模型窗口压缩旧步骤后重试。",
              last_error: aiErrorMessage(error)
            });
            const reactiveCompact = await maybeCompactAiContext({
              config,
              state: toolLoop,
              taskPrompt,
              steps,
              force: true
            });
            if (reactiveCompact.compacted) {
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
                nativeTranscript: getAiToolLoopTranscript(toolLoop),
                compactionEvents: toolLoop.compaction?.events ?? []
              });
              continue;
            }
          }
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
          nativeTranscript: getAiToolLoopTranscript(toolLoop),
          compactionEvents: toolLoop.compaction?.events ?? []
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
        nativeTranscript: getAiToolLoopTranscript(toolLoop),
        compactionEvents: toolLoop.compaction?.events ?? []
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
          nativeTranscript: getAiToolLoopTranscript(toolLoop),
          compactionEvents: toolLoop.compaction?.events ?? []
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
        if (call.input) result.input = call.input;
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
        nativeTranscript: getAiToolLoopTranscript(toolLoop),
        compactionEvents: toolLoop.compaction?.events ?? []
      });

      step += 1;
    }

    const discoveredFlags = allDiscoveredFlags(finalText, finalFlags, steps);
    let autoSubmit: Awaited<ReturnType<typeof maybeAutoSubmitFlag>> = null;
    if (task.ctf_context?.auto_submit) {
      await persistActivity(taskId, {
        phase: "auto_submit",
        provider,
        model,
        message: "已得到最终答案，正在按题目上下文尝试自动提交 Flag。"
      });
      autoSubmit = await maybeAutoSubmitFlag(task, finalText, finalFlags, steps);
      await audit("flag_auto_submit", {
        user: by,
        task_id: taskId,
        challenge_id: task.ctf_context.challenge_id,
        contest_id: task.ctf_context.contest_id ?? null,
        attempted: autoSubmit?.attempted ?? false,
        status: autoSubmit?.status ?? "disabled",
        accepted: autoSubmit && "accepted" in autoSubmit ? autoSubmit.accepted : null,
        reason: autoSubmit?.reason ?? null
      });
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
      flags: discoveredFlags,
      ...(autoSubmit ? { auto_submit: autoSubmit } : {}),
      usage: mergeUsage(usages),
      ai_tool_request: lastAiToolRequest,
      ai_function_tool_calls: aiFunctionToolCalls,
      raw_tool_request_response: rawResponses.at(-1) ?? null,
      raw_response: rawResponses.length <= 2 ? (rawResponses.length === 1 ? rawResponses[0] : { initial: rawResponses[0], final: rawResponses.at(-1) }) : { responses: rawResponses },
      raw_responses: rawResponses,
      context_compaction_events: toolLoop.compaction?.events ?? [],
      native_tool_loop: getAiToolLoopTranscript(toolLoop),
      agent_steps: steps,
      tool_calls: allToolCalls,
      started_at: startedAt,
      completed_at: finishedAt
    };
    latest.status = "completed";
    latest.updated_at = finishedAt;
    if (autoSubmit) {
      latest.history.push({ ts: finishedAt, action: "flag_auto_submit", by, comment: `status=${autoSubmit.status} attempted=${String(autoSubmit.attempted)}` });
    }
    latest.history.push({ ts: finishedAt, action: "executed", by, comment: `provider=${provider} model=${model} steps=${steps.length}` });
    latest.history.push({ ts: finishedAt, action: "status_change", by, from: "running", to: "completed" });
    await saveTask(latest);
    await audit("task_executed", { user: by, task_id: taskId, provider: finalCompletion?.provider ?? provider, model: finalCompletion?.model ?? model, steps: steps.length, flags: discoveredFlags, auto_submit_status: autoSubmit?.status ?? null });
    publishTaskEvent(taskId, "final", { task: latest, text: finalText, flags: discoveredFlags, auto_submit: autoSubmit });
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
