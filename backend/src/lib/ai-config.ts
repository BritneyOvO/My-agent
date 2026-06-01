import path from "node:path";
import { env } from "./env.js";
import { readJsonFile } from "./fs.js";
import { ToolRegistry } from "../tools/registry.js";

export type StoredAiApiConfig = {
  provider: string;
  base_url: string;
  model: string;
  reasoning_effort?: string;
  api_key?: string;
  organization?: string;
  updated_at?: string;
};

export function aiConfigPath() {
  return path.join(env.dataDir, "hub", "ai-api-config.json");
}

export const aiProviders = ["openai", "anthropic", "deepseek"] as const;
type AiProvider = (typeof aiProviders)[number];

const defaultContextWindowByProvider: Record<AiProvider, number> = {
  openai: 128_000,
  anthropic: 200_000,
  deepseek: 64_000
};

function normalizeProvider(value: string | undefined): AiProvider {
  const provider = String(value || "openai").toLowerCase();
  if (provider === "anthropic" || provider === "claude" || provider === "antor") return "anthropic";
  if (provider === "deepseek") return "deepseek";
  return "openai";
}

function defaultBaseUrl(provider: AiProvider) {
  if (provider === "anthropic") return "https://api.anthropic.com/v1";
  if (provider === "deepseek") return "https://api.deepseek.com";
  return process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
}

function defaultModel(provider: AiProvider) {
  if (provider === "anthropic") return "claude-sonnet-4-5";
  if (provider === "deepseek") return "deepseek-chat";
  return env.model;
}

function normalizeConfig(config: StoredAiApiConfig): StoredAiApiConfig {
  const provider = normalizeProvider(config.provider);
  return {
    ...config,
    provider,
    base_url: config.base_url || defaultBaseUrl(provider),
    model: config.model || defaultModel(provider),
    reasoning_effort: config.reasoning_effort ?? "default"
  };
}

export async function readAiConfig(): Promise<StoredAiApiConfig> {
  try {
    return normalizeConfig(await readJsonFile<StoredAiApiConfig>(aiConfigPath()));
  } catch {
    const provider = normalizeProvider(process.env.Z3GH0NE_AI_PROVIDER);
    return {
      provider,
      base_url: defaultBaseUrl(provider),
      model: process.env.Z3GH0NE_MODEL ?? defaultModel(provider),
      reasoning_effort: "default",
      api_key: process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "",
      organization: process.env.OPENAI_ORG_ID ?? ""
    };
  }
}

export function redactAiConfig(config: StoredAiApiConfig) {
  return {
    provider: config.provider,
    base_url: config.base_url,
    model: config.model,
    reasoning_effort: config.reasoning_effort ?? "default",
    organization: config.organization ?? "",
    api_key_set: Boolean(config.api_key),
    updated_at: config.updated_at ?? null,
    context_policy: modelContextPolicy(config)
  };
}

export type AiToolCallRequest = {
  tool: string;
  target?: string;
  artifact_path?: string;
  query?: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
  input?: Record<string, unknown>;
  args: string[];
  call_id?: string;
  raw?: Record<string, unknown>;
};

export type AiCompletionResult = {
  provider: string;
  model: string;
  text: string;
  usage: Record<string, unknown>;
  raw?: Record<string, unknown>;
  tool_calls?: AiToolCallRequest[];
};

export type AiStreamEvent = {
  type: "delta" | "message" | "error";
  text?: string;
  raw?: Record<string, unknown>;
};

export type AiCompletionOptions = {
  stream?: boolean;
  disableTools?: boolean;
  onStreamEvent?: (event: AiStreamEvent) => void | Promise<void>;
};

export type AiNativeToolResult = {
  tool: string;
  target?: string | null;
  artifact_path?: string;
  input?: Record<string, unknown>;
  args: string[];
  call_id?: string;
  result: Record<string, unknown>;
};

export type AiToolLoopState = {
  prompt: string;
  system: string;
  provider?: string;
  model?: string;
  api_mode?: "responses" | "chat" | "anthropic";
  responsesInput: unknown[];
  anthropicMessages: unknown[];
  chatMessages: unknown[];
  compaction?: {
    failures: number;
    summaries: string[];
    events: Record<string, unknown>[];
    lastCompactedStep?: number;
  };
};

const aiTimeoutMs = Number.parseInt(process.env.Z3GH0NE_AI_TIMEOUT_MS ?? "45000", 10);
const maxStoredStreamEvents = Number.parseInt(process.env.Z3GH0NE_AI_STREAM_RAW_EVENTS ?? "30", 10);

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function joinUrl(baseUrl: string, endpoint: string) {
  const base = trimSlash(baseUrl || "");
  return `${base}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
}

function requireApiKey(config: StoredAiApiConfig) {
  if (!config.api_key) {
    throw new Error(`AI API 未配置 Key：provider=${config.provider}`);
  }
  return config.api_key;
}

function parsePositiveInt(value: string | undefined) {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function modelEnvKey(model: string) {
  return `Z3GH0NE_CONTEXT_WINDOW_${model.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

export function modelContextWindowTokens(config: Pick<StoredAiApiConfig, "provider" | "model">) {
  const globalOverride = parsePositiveInt(process.env.Z3GH0NE_CONTEXT_WINDOW_TOKENS);
  if (globalOverride) return globalOverride;

  const model = String(config.model || "").toLowerCase();
  const modelOverride = parsePositiveInt(process.env[modelEnvKey(model)]);
  if (modelOverride) return modelOverride;

  if (/gpt-5\.[12]-chat|gpt-5-chat/i.test(model)) return 128_000;
  if (/gpt-5\.[45].*(?:mini|nano)|gpt-5.*(?:mini|nano)|gpt-5\.[12]|gpt-5(?:-|$)/i.test(model)) return 400_000;
  if (/gpt-5\.[45]/i.test(model)) return 1_050_000;
  if (/gpt-4\.1|gpt-4-1/i.test(model)) return 1_047_576;
  if (/gpt-4o|gpt-4\.5|gpt-4-5|o1\b/i.test(model)) return 128_000;
  if (/\bo3\b|o3-|o4-mini/i.test(model)) return 200_000;
  if (/claude.*(?:sonnet|opus).*4\.6|claude.*4-6.*(?:sonnet|opus)|claude-(?:sonnet|opus)-4-6/i.test(model)) return 1_000_000;
  if (/claude|sonnet|opus|haiku/i.test(model)) return 200_000;
  if (/deepseek.*v4|deepseek-chat|deepseek-reasoner/i.test(model)) return 1_000_000;
  if (/deepseek/i.test(model)) return 1_000_000;
  if (/qwen.*(1m|1000k|million)/i.test(model)) return 1_000_000;
  if (/qwen.*(235b|long|coder)/i.test(model)) return 128_000;

  return defaultContextWindowByProvider[normalizeProvider(config.provider)];
}

export function modelContextPolicy(config: Pick<StoredAiApiConfig, "provider" | "model">) {
  const windowTokens = modelContextWindowTokens(config);
  const reservedBaseline = Math.min(20_000, Math.max(4_000, Math.floor(windowTokens * 0.1)));
  const reservedCap = Math.max(0, Math.min(Math.floor(windowTokens * 0.25), windowTokens - 1));
  const reservedOutputTokens = Math.min(reservedBaseline, reservedCap);
  const effectiveWindowTokens = Math.max(1, windowTokens - reservedOutputTokens);
  const bufferBaseline = Math.min(16_000, Math.max(4_000, Math.floor(effectiveWindowTokens * 0.12)));
  const bufferCap = Math.max(0, Math.min(Math.floor(effectiveWindowTokens * 0.25), effectiveWindowTokens - 1));
  const bufferTokens = Math.min(bufferBaseline, bufferCap);
  const autoCompactThresholdTokens = Math.max(1, effectiveWindowTokens - bufferTokens);
  return {
    model: config.model,
    provider: normalizeProvider(config.provider),
    windowTokens,
    reservedOutputTokens,
    effectiveWindowTokens,
    autoCompactThresholdTokens
  };
}

export function createAiToolLoopState(prompt: string, system: string): AiToolLoopState {
  return {
    prompt,
    system,
    responsesInput: [{ role: "user", content: prompt }],
    anthropicMessages: [{ role: "user", content: prompt }],
    chatMessages: [{ role: "user", content: prompt }]
  };
}

function isToolLoopState(value: unknown): value is AiToolLoopState {
  return Boolean(value && typeof value === "object" && Array.isArray((value as AiToolLoopState).responsesInput) && Array.isArray((value as AiToolLoopState).anthropicMessages) && Array.isArray((value as AiToolLoopState).chatMessages));
}

export function serializeAiToolResult(call: AiNativeToolResult) {
  return JSON.stringify({
    tool: call.tool,
    target: call.target ?? null,
    artifact_path: call.artifact_path,
    input: call.input,
    args: call.args,
    result: call.result
  });
}

export function appendAiToolResults(state: AiToolLoopState, completion: AiCompletionResult, calls: AiNativeToolResult[]) {
  const callsById = new Map<string, AiNativeToolResult>();
  for (const call of calls) {
    if (call.call_id) callsById.set(call.call_id, call);
  }
  const fallbackText = [
    "工具执行结果：",
    ...calls.map((call) => serializeAiToolResult(call))
  ].join("\n");

  if (completion.provider === "anthropic") {
    const content = Array.isArray((completion.raw as Record<string, unknown> | undefined)?.content)
      ? (completion.raw as Record<string, unknown>).content as Record<string, unknown>[]
      : [];
    const resultBlocks = content
      .filter((item) => String(item.type ?? "") === "tool_use")
      .map((item) => {
        const id = String(item.id ?? "");
        const call = callsById.get(id) ?? calls.find((candidate) => candidate.tool === String(item.name ?? ""));
        if (!id || !call) return null;
        return { type: "tool_result", tool_use_id: id, content: serializeAiToolResult(call) };
      })
      .filter((item): item is { type: string; tool_use_id: string; content: string } => Boolean(item));
    if (resultBlocks.length) state.anthropicMessages.push({ role: "user", content: resultBlocks });
    else if (calls.length) state.anthropicMessages.push({ role: "user", content: fallbackText });
    return;
  }

  if (completion.provider === "deepseek" || Array.isArray((completion.raw as Record<string, unknown> | undefined)?.choices)) {
    for (const call of calls) {
      if (call.call_id) {
        state.chatMessages.push({
          role: "tool",
          tool_call_id: call.call_id,
          content: serializeAiToolResult(call)
        });
      } else {
        state.chatMessages.push({ role: "user", content: fallbackText });
        break;
      }
    }
    return;
  }

  for (const call of calls) {
    if (call.call_id) {
      state.responsesInput.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: serializeAiToolResult(call)
      });
    } else {
      state.responsesInput.push({ role: "user", content: fallbackText });
      break;
    }
  }
}

export function appendAiUserMessage(state: AiToolLoopState, content: string) {
  state.responsesInput.push({ role: "user", content });
  state.anthropicMessages.push({ role: "user", content });
  state.chatMessages.push({ role: "user", content });
}

function repairMissingResponsesToolOutputs(state: AiToolLoopState) {
  const calls = new Set<string>();
  const outputs = new Set<string>();
  for (const item of state.responsesInput) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (String(record.type ?? "") === "function_call") {
      const callId = typeof record.call_id === "string" ? record.call_id : typeof record.id === "string" ? record.id : "";
      if (callId) calls.add(callId);
    }
    if (String(record.type ?? "") === "function_call_output") {
      const callId = typeof record.call_id === "string" ? record.call_id : "";
      if (callId) outputs.add(callId);
    }
  }
  for (const callId of calls) {
    if (outputs.has(callId)) continue;
    state.responsesInput.push({
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify({
        skipped: true,
        error: "Executor repaired missing tool output for a previous function_call; continue from available context."
      })
    });
  }
}

export function getAiToolLoopTranscript(state: AiToolLoopState) {
  return {
    provider: state.provider ?? null,
    model: state.model ?? null,
    api_mode: state.api_mode ?? null,
    responses_input: state.responsesInput,
    anthropic_messages: state.anthropicMessages,
    chat_messages: state.chatMessages
  };
}

export async function runAiCompletion(
  config: StoredAiApiConfig,
  prompt: string | AiToolLoopState,
  system = "",
  maxTokens = 2048,
  options: AiCompletionOptions = {}
): Promise<AiCompletionResult> {
  const normalized = normalizeConfig(config);
  const state = isToolLoopState(prompt) ? prompt : null;
  const userPrompt: string = state ? state.prompt : prompt as string;
  const systemPrompt: string = state ? state.system : system;
  if (state) {
    state.provider = normalized.provider;
    state.model = normalized.model;
  }
  if (normalized.provider === "anthropic") {
    return runAnthropic(normalized, userPrompt, systemPrompt, maxTokens, state, options);
  }
  if (normalized.provider === "deepseek") {
    return runDeepSeek(normalized, userPrompt, systemPrompt, maxTokens, state, options);
  }
  if (state?.api_mode === "chat") {
    return runChatCompletions(normalized, userPrompt, systemPrompt, maxTokens, state, options);
  }
  try {
    return await runOpenAIResponses(normalized, userPrompt, systemPrompt, maxTokens, state, options);
  } catch (error) {
    // codexmanager/local OpenAI-compatible gateways sometimes return Responses
    // `response.failed` / upstream_error for larger tool-loop payloads while
    // /chat/completions still works. Fall back to native chat tool-calls and
    // keep using chat for the rest of this task state.
    if (state) state.api_mode = "chat";
    return runChatCompletions(normalized, userPrompt, systemPrompt, maxTokens, state, options);
  }
}

async function readJsonResponse(response: Response, label: string) {
  const text = await response.text();
  let data: Record<string, unknown>;
  try {
    data = text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    throw new Error(`${label} ${response.status}: 响应不是 JSON，前 120 字符：${text.slice(0, 120)}`);
  }
  if (!response.ok) {
    throw new Error(`${label} ${response.status}: ${JSON.stringify(data).slice(0, 800)}`);
  }
  return data;
}

async function fetchWithTimeout(url: string, init: RequestInit, label: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, aiTimeoutMs));
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${label} 请求超时：${Math.round(aiTimeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readSseResponse(
  response: Response,
  label: string,
  onData: (data: Record<string, unknown>) => void | Promise<void>
) {
  if (!response.ok) {
    await readJsonResponse(response, label);
  }
  if (!response.body) {
    throw new Error(`${label} stream response body is empty`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const dataLines = part
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart());
        if (!dataLines.length) continue;
        const raw = dataLines.join("\n").trim();
        if (!raw || raw === "[DONE]") continue;
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            await onData(parsed as Record<string, unknown>);
          }
        } catch {
          continue;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function compactStreamResponse(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => ![
      "instructions",
      "tools",
      "input",
      "messages",
      "prompt",
      "metadata"
    ].includes(key))
  );
}

function compactStreamEvent(event: Record<string, unknown>) {
  const type = String(event.type ?? event.event ?? "");
  const compact: Record<string, unknown> = { type };
  if (typeof event.sequence_number === "number") compact.sequence_number = event.sequence_number;
  if (typeof event.delta === "string") compact.delta = event.delta;
  if (typeof event.text === "string") compact.text = event.text.slice(0, 2000);
  if (event.usage && typeof event.usage === "object" && !Array.isArray(event.usage)) compact.usage = event.usage;
  if (event.response) {
    const response = compactStreamResponse(event.response);
    if (response) compact.response = response;
  }
  if (event.message && typeof event.message === "object" && !Array.isArray(event.message)) {
    compact.message = compactStreamResponse(event.message);
  }
  if (event.item && typeof event.item === "object" && !Array.isArray(event.item)) {
    compact.item = compactStreamResponse(event.item);
  }
  if (event.content_block && typeof event.content_block === "object" && !Array.isArray(event.content_block)) {
    compact.content_block = compactStreamResponse(event.content_block);
  }
  return compact;
}

function rememberStreamEvent(events: Record<string, unknown>[], event: Record<string, unknown>) {
  if (events.length >= maxStoredStreamEvents) return;
  const type = String(event.type ?? event.event ?? "");
  if (/delta/i.test(type)) return;
  events.push(compactStreamEvent(event));
}

async function emitStreamDelta(options: AiCompletionOptions | undefined, text: string) {
  if (!text) return;
  await options?.onStreamEvent?.({ type: "delta", text });
}

async function emitStreamMessage(options: AiCompletionOptions | undefined, text: string, raw?: Record<string, unknown>) {
  if (!text && !raw) return;
  await options?.onStreamEvent?.({ type: "message", text, ...(raw ? { raw } : {}) });
}


function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function toStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeAiToolCall(value: unknown, raw?: Record<string, unknown>): AiToolCallRequest | null {
  const record = parseJsonObject(value);
  if (!record) return null;
  const tool = typeof record.tool === "string" ? record.tool.trim() : "";
  if (!tool) return null;
  const request: AiToolCallRequest = { tool, args: toStringArray(record.args), ...(raw ? { raw } : {}) };
  if (typeof record.target === "string" && record.target.trim()) request.target = record.target.trim();
  if (typeof record.artifact_path === "string" && record.artifact_path.trim()) request.artifact_path = record.artifact_path.trim();
  if (typeof record.query === "string" && record.query.trim()) request.query = record.query.trim();
  if (Array.isArray(record.allowed_domains)) request.allowed_domains = toStringArray(record.allowed_domains);
  if (Array.isArray(record.blocked_domains)) request.blocked_domains = toStringArray(record.blocked_domains);
  if (record.input && typeof record.input === "object" && !Array.isArray(record.input)) request.input = record.input as Record<string, unknown>;
  const structuredInput = Object.fromEntries(Object.entries(record).filter(([key]) => [
    "file_path", "content", "old_string", "new_string", "replace_all", "pattern", "path", "glob", "output_mode",
    "head_limit", "offset", "limit", "multiline", "type", "context", "-A", "-B", "-C", "-i", "-n"
  ].includes(key)));
  if (Object.keys(structuredInput).length) request.input = { ...(request.input ?? {}), ...structuredInput };
  if (typeof record.call_id === "string" && record.call_id.trim()) request.call_id = record.call_id.trim();
  return request;
}

function extractAiToolCalls(data: Record<string, unknown>): AiToolCallRequest[] {
  const result: AiToolCallRequest[] = [];
  const pushCall = (call: AiToolCallRequest | null) => { if (call) result.push(call); };

  const output = Array.isArray(data.output) ? data.output as Record<string, unknown>[] : [];
  for (const item of output) {
    const type = String(item.type ?? "");
    if (type === "function_call" || type === "tool_call") {
      const name = String(item.name ?? "");
      const args = parseJsonObject(item.arguments) ?? parseJsonObject(item.input) ?? {};
      const callId = typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : undefined;
      if (name === "run_tool") {
        pushCall(normalizeAiToolCall({ ...args, call_id: callId }, item));
      } else if (name) {
        pushCall(normalizeAiToolCall({ tool: name, ...args, call_id: callId }, item));
      }
    }
  }

  const content = Array.isArray(data.content) ? data.content as Record<string, unknown>[] : [];
  for (const item of content) {
    if (String(item.type ?? "") !== "tool_use") continue;
    const name = String(item.name ?? "");
    const input = item.input && typeof item.input === "object" ? item.input as Record<string, unknown> : {};
    const callId = typeof item.id === "string" ? item.id : undefined;
    if (name === "run_tool") {
      pushCall(normalizeAiToolCall({ ...input, call_id: callId }, item));
    } else if (name) {
      pushCall(normalizeAiToolCall({ tool: name, ...input, call_id: callId }, item));
    }
  }

  const choices = Array.isArray(data.choices) ? data.choices as Record<string, unknown>[] : [];
  for (const choice of choices) {
    const message = choice.message && typeof choice.message === "object" ? choice.message as Record<string, unknown> : {};
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls as Record<string, unknown>[] : [];
    for (const item of calls) {
      const fn = item.function && typeof item.function === "object" ? item.function as Record<string, unknown> : {};
      const name = String(fn.name ?? item.name ?? "");
      const args = parseJsonObject(fn.arguments ?? item.arguments) ?? {};
      const callId = typeof item.id === "string" ? item.id : undefined;
      if (name === "run_tool") {
        pushCall(normalizeAiToolCall({ ...args, call_id: callId }, item));
      } else if (name) {
        pushCall(normalizeAiToolCall({ tool: name, ...args, call_id: callId }, item));
      }
    }
  }

  return result;
}

function toolCallFallbackText(toolCalls: AiToolCallRequest[]) {
  return toolCalls.length ? JSON.stringify({ tool_calls: toolCalls.map(({ raw, ...call }) => call) }) : "";
}

function aiToolNames() {
  return new ToolRegistry().list().filter((tool) => tool.available).map((tool) => tool.name);
}

function aiToolPromptCatalog() {
  return new ToolRegistry().list()
    .filter((tool) => tool.available)
    .map((tool) => `${tool.name}: ${String(tool.prompt ?? tool.description ?? "").trim()}`)
    .join("\n\n");
}

function runToolDescription() {
  return [
    "运行 Agent Hub 后端工具。Read/Write/Edit/Glob/Grep/LS 使用 input 结构化参数；web_search 用 query；artifact_path、target 和 args 会按调度器规则追加到对应命令。",
    "APK/Reverse 任务优先使用 aapt_dump、jadx_decompile、apktool_decode、readelf_symbols、r2_native_scan、strings_grep；禁止先跑全量 strings/readelf -a/objdump -d/r2 大反汇编。",
    "大输出必须先用 grep/head/filter、Grep head_limit、Read offset/limit 或具体 r2 symbol/address 缩小，再回灌给模型。",
    "",
    "Tool usage:",
    aiToolPromptCatalog()
  ].join("\n");
}

function runToolParameters() {
  const tools = aiToolNames();
  return {
    type: "object",
    properties: {
      tool: { type: "string", enum: tools, description: "要运行的白名单工具名" },
      query: { type: "string", description: "web_search 查询词；也可用 args[0] 传递" },
      allowed_domains: { type: "array", items: { type: "string" }, description: "web_search 可选：只包含这些域名" },
      blocked_domains: { type: "array", items: { type: "string" }, description: "web_search 可选：排除这些域名" },
      target: { type: "string", description: "URL 或 Host，仅用于 whatweb/nmap/ffuf 等网络工具" },
      artifact_path: { type: "string", description: "上传目录中的附件文件名，或后端可访问的本地绝对路径；用于 file/strings_grep/readelf_symbols/r2_native_scan/jadx_decompile/apktool_decode/aapt_dump/objdump/exiftool/binwalk/解压工具/tshark_summary，或交给 python 执行上传的 .py 脚本" },
      input: {
        type: "object",
        description: "Read/Write/Edit/Glob/Grep/LS 的结构化参数对象，例如 {file_path, content, old_string, new_string, replace_all, pattern, path, output_mode, offset, limit}",
        additionalProperties: true
      },
      file_path: { type: "string", description: "文件工具快捷参数：文件路径" },
      content: { type: "string", description: "Write 快捷参数：完整文件内容" },
      old_string: { type: "string", description: "Edit 快捷参数：要替换的原文本" },
      new_string: { type: "string", description: "Edit 快捷参数：替换后的文本" },
      replace_all: { type: "boolean", description: "Edit 快捷参数：替换全部匹配" },
      pattern: { type: "string", description: "Glob/Grep 快捷参数：glob 或正则模式" },
      path: { type: "string", description: "Glob/Grep/LS 快捷参数：搜索或列目录路径" },
      glob: { type: "string", description: "Grep 快捷参数：文件 glob 过滤" },
      output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "Grep 输出模式" },
      offset: { type: "number", description: "Read/Grep 分页偏移" },
      limit: { type: "number", description: "Read 行数限制" },
      head_limit: { type: "number", description: "Grep/Glob 输出数量限制，0 表示不限制" },
      args: { type: "array", items: { type: "string" }, description: '额外参数；不要把 target 重复放进 args。strings_grep/readelf_symbols 用 ["regex","limit"]；r2 用 ["-A","-c","pdf @ sym.name"] 等聚焦命令；python 可使用 ["-c", "短 Python 代码"]' }
    },
    required: ["tool"],
    additionalProperties: false
  };
}

function responseToolDefinitions() {
  return aiToolNames().length ? [{ type: "function", name: "run_tool", description: runToolDescription(), parameters: runToolParameters() }] : [];
}

function chatToolDefinitions() {
  return aiToolNames().length ? [{ type: "function", function: { name: "run_tool", description: runToolDescription(), parameters: runToolParameters() } }] : [];
}

function anthropicToolDefinitions() {
  return aiToolNames().length ? [{ name: "run_tool", description: runToolDescription(), input_schema: runToolParameters() }] : [];
}

function withAiTools(body: Record<string, unknown>, api: "responses" | "chat" | "anthropic") {
  const tools = api === "responses" ? responseToolDefinitions() : api === "chat" ? chatToolDefinitions() : anthropicToolDefinitions();
  if (!tools.length) return body;
  if (api === "anthropic") return { ...body, tools, tool_choice: { type: "auto" } };
  return { ...body, tools, tool_choice: "auto" };
}

function withReasoningEffort(config: StoredAiApiConfig, body: Record<string, unknown>, api: "responses" | "chat") {
  const effort = config.reasoning_effort ?? "default";
  if (effort === "default") return body;
  if (api === "responses") return { ...body, reasoning: { effort } };
  return config.provider === "openai" ? { ...body, reasoning_effort: effort } : body;
}

function contentToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        return contentToText(record.text ?? record.content ?? record.value);
      }
      return "";
    }).join("");
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return contentToText(record.text ?? record.content ?? record.value);
  }
  return "";
}

function responseEndpointCandidates(baseUrl: string) {
  const base = trimSlash(baseUrl || "");
  if (!base) return [];
  if (/\/responses$/i.test(base) || /\/response$/i.test(base)) return [base];
  return [joinUrl(base, "/responses")];
}

async function runOpenAIResponses(
  config: StoredAiApiConfig,
  prompt: string,
  system: string,
  maxTokens: number,
  state: AiToolLoopState | null = null,
  options: AiCompletionOptions = {}
): Promise<AiCompletionResult> {
  const apiKey = requireApiKey(config);
  let lastError: unknown = null;
  for (const url of responseEndpointCandidates(config.base_url)) {
    for (const includeTools of (options.disableTools ? [false] : [true, false])) {
      try {
        if (state) repairMissingResponsesToolOutputs(state);
        const baseBody = withReasoningEffort(config, {
          model: config.model,
          instructions: system,
          input: state ? state.responsesInput : prompt,
          max_output_tokens: maxTokens,
          store: false,
          ...(options.stream ? { stream: true } : {})
        }, "responses");
        const body = includeTools ? withAiTools(baseBody, "responses") : baseBody;
        const response = await fetchWithTimeout(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            ...(config.organization ? { "OpenAI-Organization": config.organization } : {})
          },
          body: JSON.stringify(body)
        }, "Responses API");
        if (options.stream) {
          let text = "";
          let finalResponse: Record<string, unknown> | null = null;
          const streamEvents: Record<string, unknown>[] = [];
          await readSseResponse(response, "Responses API", async (event) => {
            rememberStreamEvent(streamEvents, event);
            const eventType = String(event.type ?? "");
            const delta = typeof event.delta === "string"
              ? event.delta
              : typeof event.text === "string" && /delta/i.test(eventType)
                ? event.text
                : "";
            if (delta) {
              text += delta;
              await emitStreamDelta(options, delta);
            }
            const responseValue = event.response;
            if (responseValue && typeof responseValue === "object" && !Array.isArray(responseValue)) {
              finalResponse = responseValue as Record<string, unknown>;
            } else if (String(event.type ?? "") === "response.completed") {
              finalResponse = event;
            }
          });
          const data: Record<string, unknown> = finalResponse ?? { output_text: text };
          if (String(data.status ?? "") === "failed" || data.error) {
            throw new Error(`Responses API failed: ${JSON.stringify(data.error ?? data).slice(0, 1200)}`);
          }
          const toolCalls = extractAiToolCalls(data);
          const finalText = contentToText(data.output_text ?? data.output ?? data.response ?? data.content) || text || toolCallFallbackText(toolCalls);
          if (!finalText.trim() && !toolCalls.length) {
            throw new Error(`Responses API stream 返回空内容：${JSON.stringify(data).slice(0, 800)}`);
          }
          if (state) {
            state.api_mode = "responses";
            const output = Array.isArray(data.output) ? data.output : [];
            state.responsesInput.push(...output);
          }
          await emitStreamMessage(options, finalText, { provider: config.provider, model: config.model });
          return {
            provider: config.provider,
            model: config.model,
            text: finalText,
            usage: data.usage && typeof data.usage === "object" ? data.usage as Record<string, unknown> : {},
            raw: { stream: true, final: compactStreamResponse(data) ?? data, events: streamEvents },
            ...(toolCalls.length ? { tool_calls: toolCalls } : {})
          };
        }
        const data = await readJsonResponse(response, "Responses API");
        if (String(data.status ?? "") === "failed" || data.error) {
          throw new Error(`Responses API failed: ${JSON.stringify(data.error ?? data).slice(0, 1200)}`);
        }
        const toolCalls = extractAiToolCalls(data);
        const text = contentToText(data.output_text ?? data.output ?? data.response ?? data.content) || toolCallFallbackText(toolCalls);
        if (!text.trim() && !toolCalls.length) {
          throw new Error(`Responses API 返回空内容：${JSON.stringify(data).slice(0, 800)}`);
        }
        if (state) {
          state.api_mode = "responses";
          const output = Array.isArray(data.output) ? data.output : [];
          state.responsesInput.push(...output);
        }
        return {
          provider: config.provider,
          model: config.model,
          text,
          usage: data.usage && typeof data.usage === "object" ? data.usage as Record<string, unknown> : {},
          raw: data,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {})
        };
      } catch (error) {
        lastError = error;
        continue;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Responses API failed"));
}

type ChatToolCallAccumulator = {
  id?: string;
  type?: string;
  function: {
    name: string;
    arguments: string;
  };
};

function applyChatToolCallDelta(accumulator: Map<number, ChatToolCallAccumulator>, value: unknown) {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const index = typeof record.index === "number" ? record.index : accumulator.size;
    const current = accumulator.get(index) ?? { function: { name: "", arguments: "" } };
    if (typeof record.id === "string") current.id = record.id;
    if (typeof record.type === "string") current.type = record.type;
    const fn = record.function && typeof record.function === "object" ? record.function as Record<string, unknown> : {};
    if (typeof fn.name === "string") current.function.name += fn.name;
    if (typeof fn.arguments === "string") current.function.arguments += fn.arguments;
    accumulator.set(index, current);
  }
}

async function runDeepSeek(
  config: StoredAiApiConfig,
  prompt: string,
  system: string,
  maxTokens: number,
  state: AiToolLoopState | null = null,
  options: AiCompletionOptions = {}
): Promise<AiCompletionResult> {
  return runChatCompletions({ ...config, provider: "deepseek", base_url: config.base_url || defaultBaseUrl("deepseek") }, prompt, system, maxTokens, state, options);
}

async function runChatCompletions(
  config: StoredAiApiConfig,
  prompt: string,
  system: string,
  maxTokens: number,
  state: AiToolLoopState | null = null,
  options: AiCompletionOptions = {}
): Promise<AiCompletionResult> {
  const apiKey = requireApiKey(config);
  try {
    const response = await fetchWithTimeout(joinUrl(config.base_url, "/chat/completions"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(config.organization ? { "OpenAI-Organization": config.organization } : {})
      },
      body: JSON.stringify(options.disableTools ? withReasoningEffort(config, {
        model: config.model,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          ...(state ? state.chatMessages : [{ role: "user", content: prompt }])
        ],
        ...(options.stream ? { stream: true } : {})
      }, "chat") : withAiTools(withReasoningEffort(config, {
        model: config.model,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          ...(state ? state.chatMessages : [{ role: "user", content: prompt }])
        ],
        ...(options.stream ? { stream: true } : {})
      }, "chat"), "chat"))
    }, "AI API");
    if (options.stream) {
      let text = "";
      const streamEvents: Record<string, unknown>[] = [];
      const toolAccumulator = new Map<number, ChatToolCallAccumulator>();
      let usage: Record<string, unknown> = {};
      await readSseResponse(response, "AI API", async (event) => {
        rememberStreamEvent(streamEvents, event);
        if (event.usage && typeof event.usage === "object" && !Array.isArray(event.usage)) {
          usage = event.usage as Record<string, unknown>;
        }
        const choices = Array.isArray(event.choices) ? event.choices as Record<string, unknown>[] : [];
        for (const choice of choices) {
          const delta = choice.delta && typeof choice.delta === "object" ? choice.delta as Record<string, unknown> : {};
          const content = contentToText(delta.content ?? choice.text);
          if (content) {
            text += content;
            await emitStreamDelta(options, content);
          }
          applyChatToolCallDelta(toolAccumulator, delta.tool_calls);
        }
      });

      const toolCalls = [...toolAccumulator.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, value]) => ({
          id: value.id,
          type: value.type ?? "function",
          function: value.function
        }));
      const message: Record<string, unknown> = {
        role: "assistant",
        content: text,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {})
      };
      const data = { choices: [{ message }], usage };
      const extractedToolCalls = extractAiToolCalls(data);
      const finalText = text || toolCallFallbackText(extractedToolCalls);
      if (!finalText.trim() && !extractedToolCalls.length) {
        throw new Error(`AI API stream 返回空内容`);
      }
      if (state) {
        state.api_mode = "chat";
        state.chatMessages.push(message);
      }
      await emitStreamMessage(options, finalText, { provider: config.provider, model: config.model });
      return {
        provider: config.provider,
        model: config.model,
        text: finalText,
        usage,
        raw: { stream: true, final: compactStreamResponse(data) ?? data, events: streamEvents },
        ...(extractedToolCalls.length ? { tool_calls: extractedToolCalls } : {})
      };
    }
    const data = await readJsonResponse(response, "AI API");
    const choices = Array.isArray(data.choices) ? data.choices as Array<Record<string, unknown>> : [];
    const message = choices[0]?.message && typeof choices[0].message === "object" ? choices[0].message as Record<string, unknown> : {};
    const toolCalls = extractAiToolCalls(data);
    const text = contentToText(message.content ?? choices[0]?.text ?? data.output_text ?? data.response) || toolCallFallbackText(toolCalls);
    if (!text.trim() && !toolCalls.length) {
      throw new Error(`AI API 返回空内容：${JSON.stringify(data).slice(0, 800)}`);
    }
    if (state) {
      state.api_mode = "chat";
      state.chatMessages.push(message);
    }
    return {
      provider: config.provider,
      model: config.model,
      text,
      usage: data.usage && typeof data.usage === "object" ? data.usage as Record<string, unknown> : {},
      raw: data,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {})
    };
  } catch (error) {
    throw error;
  }
}

async function runAnthropic(
  config: StoredAiApiConfig,
  prompt: string,
  system: string,
  maxTokens: number,
  state: AiToolLoopState | null = null,
  options: AiCompletionOptions = {}
): Promise<AiCompletionResult> {
  const apiKey = requireApiKey(config);
  const baseUrl = config.base_url && !/openai\.com/i.test(config.base_url) ? config.base_url : "https://api.anthropic.com/v1";
  const response = await fetchWithTimeout(joinUrl(baseUrl, "/messages"), {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(options.disableTools ? {
      model: config.model,
      max_tokens: maxTokens,
      system,
      messages: state ? state.anthropicMessages : [{ role: "user", content: prompt }],
      ...(options.stream ? { stream: true } : {})
    } : withAiTools({
      model: config.model,
      max_tokens: maxTokens,
      system,
      messages: state ? state.anthropicMessages : [{ role: "user", content: prompt }],
      ...(options.stream ? { stream: true } : {})
    }, "anthropic"))
  }, "AI API");
  if (options.stream) {
    let text = "";
    const streamEvents: Record<string, unknown>[] = [];
    const contentBlocks = new Map<number, Record<string, unknown>>();
    let usage: Record<string, unknown> = {};
    await readSseResponse(response, "AI API", async (event) => {
      rememberStreamEvent(streamEvents, event);
      const eventType = String(event.type ?? "");
      if (event.usage && typeof event.usage === "object" && !Array.isArray(event.usage)) {
        usage = event.usage as Record<string, unknown>;
      }
      if (event.message && typeof event.message === "object" && !Array.isArray(event.message)) {
        const message = event.message as Record<string, unknown>;
        if (message.usage && typeof message.usage === "object" && !Array.isArray(message.usage)) {
          usage = message.usage as Record<string, unknown>;
        }
      }

      const index = typeof event.index === "number" ? event.index : 0;
      if (eventType === "content_block_start") {
        const block = event.content_block && typeof event.content_block === "object" && !Array.isArray(event.content_block)
          ? { ...(event.content_block as Record<string, unknown>) }
          : {};
        contentBlocks.set(index, block);
        return;
      }

      const delta = event.delta && typeof event.delta === "object" && !Array.isArray(event.delta)
        ? event.delta as Record<string, unknown>
        : {};
      if (String(delta.type ?? "") === "text_delta" && typeof delta.text === "string") {
        text += delta.text;
        const block = contentBlocks.get(index) ?? { type: "text", text: "" };
        block.text = `${String(block.text ?? "")}${delta.text}`;
        contentBlocks.set(index, block);
        await emitStreamDelta(options, delta.text);
      }
      if (String(delta.type ?? "") === "input_json_delta" && typeof delta.partial_json === "string") {
        const block = contentBlocks.get(index) ?? { type: "tool_use", input_json: "" };
        block.input_json = `${String(block.input_json ?? "")}${delta.partial_json}`;
        contentBlocks.set(index, block);
      }
    });

    const content = [...contentBlocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => {
      if (String(block.type ?? "") === "tool_use") {
        const input = parseJsonObject(block.input_json) ?? {};
        const { input_json: _inputJson, ...rest } = block;
        return { ...rest, input };
      }
      return block;
    });
    if (!content.length && text) content.push({ type: "text", text });
    const data = { content, usage };
    const toolCalls = extractAiToolCalls(data);
    const finalText = contentToText(data.content) || toolCallFallbackText(toolCalls);
    if (!finalText.trim() && !toolCalls.length) {
      throw new Error(`AI API stream 返回空内容`);
    }
    if (state) {
      state.anthropicMessages.push({ role: "assistant", content });
    }
    await emitStreamMessage(options, finalText, { provider: config.provider, model: config.model });
    return {
      provider: config.provider,
      model: config.model,
      text: finalText,
      usage,
      raw: { stream: true, final: compactStreamResponse(data) ?? data, events: streamEvents },
      ...(toolCalls.length ? { tool_calls: toolCalls } : {})
    };
  }
  const data = await readJsonResponse(response, "AI API");
  const toolCalls = extractAiToolCalls(data);
  const text = contentToText(data.content) || toolCallFallbackText(toolCalls);
  if (!text.trim() && !toolCalls.length) {
    throw new Error(`AI API 返回空内容：${JSON.stringify(data).slice(0, 800)}`);
  }
  if (state) {
    state.anthropicMessages.push({ role: "assistant", content: Array.isArray(data.content) ? data.content : [] });
  }
  return {
    provider: config.provider,
    model: config.model,
    text,
    usage: data.usage && typeof data.usage === "object" ? data.usage as Record<string, unknown> : {},
    raw: data,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {})
  };
}
