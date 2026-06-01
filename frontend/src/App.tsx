import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { ApiError, hubGet, hubPatch, hubPost, matchDelete, matchGet, matchPost, type ApiConfig } from "./api";
import { Field, SelectField, TerminalPanel } from "./components/common";
import { asRecord, challengeRecords, extractTargetAddress, firstValue, hasChallengeAttachment, hasChallengeTarget, listingTotal, platformSupportsTargetApi, normalizeChallengeDirection, statusText, targetLooksOpened, toChallengeOptions, toContestOptions } from "./lib/data";
import { renderMarkdown } from "./lib/markdown";
import { parseRoute, routePath } from "./lib/route";
import { loadAccounts, loadAiApiDraft, loadCachedChallenges, loadCachedContests, loadConfig, makeId, optionListFingerprint, saveAccounts, saveAiApiDraft, saveCachedChallenges, saveCachedContests, saveConfig } from "./lib/storage";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import http from "highlight.js/lib/languages/http";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import "highlight.js/styles/github.css";
import { platforms, type AgentPage, type AiApiDraft, type BoundContest, type CtfAccount, type CtfStep, type OptionItem, type Platform, type RouteState, type SessionDraft, type TaskDraft, type Tab } from "./types";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("json", json);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("http", http);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);
hljs.registerLanguage("plaintext", plaintext);

const taskLaneMeta = [
  { key: "pending", label: "待处理", desc: "刚创建或等待分配", tone: "pending" },
  { key: "running", label: "进行中", desc: "正在执行 / 观察中", tone: "running" },
  { key: "completed", label: "已完成", desc: "已处理并归档", tone: "completed" },
  { key: "failed", label: "已失败", desc: "取消或执行异常", tone: "failed" }
] as const;

const aiProviderOptions = ["openai", "anthropic", "deepseek"] as const;
const aiProviderDefaults: Record<(typeof aiProviderOptions)[number], { baseUrl: string; model: string }> = {
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
  anthropic: { baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-5" },
  deepseek: { baseUrl: "https://api.deepseek.com", model: "deepseek-chat" }
};

type ExtractedStepSnippet = {
  title: string;
  language: string;
  code: string;
};

type ExtractedStepPair = {
  input?: ExtractedStepSnippet;
  output?: ExtractedStepSnippet;
};

type ErrorDialog = {
  title: string;
  message: string;
  status?: number;
  method?: string;
  url?: string;
  payload?: unknown;
};

function clippedJson(value: unknown, max = 6000) {
  const text = JSON.stringify(value, null, 2);
  return text.length > max ? `${text.slice(0, max)}\n...<truncated>` : text;
}

function extractDownloadedPaths(value: unknown): string[] {
  const found = new Set<string>();
  const seen = new Set<unknown>();
  const pathKeys = /^(path|saved_to|savedTo|file_path|filePath|local_path|localPath|dest|destination)$/i;
  const looksLikeLocalPath = (text: string) => {
    const trimmed = text.trim();
    if (/^https?:\/\//i.test(trimmed)) return false;
    return /(^\/|^[A-Za-z]:[\\/]|[\\/].+\.(?:zip|7z|rar|tar|gz|xz|bz2|txt|pdf|png|jpg|jpeg|gif|pcap|pcapng|bin|elf|exe|apk|jar|py|c|cpp|go|rs)$)/i.test(trimmed);
  };
  const walk = (item: unknown) => {
    if (!item || seen.has(item)) return;
    if (typeof item === "string") {
      if (looksLikeLocalPath(item)) found.add(item.trim());
      return;
    }
    if (Array.isArray(item)) {
      seen.add(item);
      item.forEach(walk);
      return;
    }
    if (typeof item === "object") {
      seen.add(item);
      for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
        if (pathKeys.test(key) && typeof child === "string" && child.trim()) found.add(child.trim());
        walk(child);
      }
    }
  };
  walk(value);
  return [...found];
}

function parseJsonMaybe(text: string): Record<string, unknown> | null {
  const candidates = [
    text.trim(),
    ...Array.from(text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)).map((match) => match[1]?.trim() ?? ""),
    text.includes("{") ? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1) : ""
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  return null;
}


function stepToolOutputSnippets(step: Record<string, unknown>): ExtractedStepSnippet[] {
  const calls = Array.isArray(step.tool_calls) ? step.tool_calls as Record<string, unknown>[] : [];
  return calls.map((call, index) => {
    const tool = String(call.tool ?? "tool");
    const result = call.result && typeof call.result === "object" ? call.result as Record<string, unknown> : {};
    const exit = result.exit_code ?? result.error_code ?? "done";
    const output = typeof result.output === "string"
      ? result.output
      : typeof result.error === "string"
        ? result.error
        : JSON.stringify(result, null, 2);
    return {
      title: `工具输出 #${index + 1}: ${tool} (${String(exit)})`,
      language: "output",
      code: output || "<empty output>"
    };
  });
}

function pairStepSnippets(inputs: ExtractedStepSnippet[], outputs: ExtractedStepSnippet[]): ExtractedStepPair[] {
  const length = Math.max(inputs.length, outputs.length);
  return Array.from({ length }, (_, index) => ({
    input: inputs[index],
    output: outputs[index]
  }));
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeHighlightLanguage(language: string, code: string) {
  const lang = language.toLowerCase();
  if (lang === "output") {
    const trimmed = code.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) return "json";
    if (/^HTTP\/\d(?:\.\d)?\s+\d{3}/m.test(trimmed) || /^\s*(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+/m.test(trimmed)) return "http";
    return "plaintext";
  }
  if (lang === "shell") return "bash";
  if (lang === "py") return "python";
  if (lang === "js") return "javascript";
  if (lang === "html") return "xml";
  if (lang === "yml") return "yaml";
  return lang;
}

function highlightedCode(language: string, code: string) {
  const lang = normalizeHighlightLanguage(language, code);
  try {
    if (hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    return hljs.highlightAuto(code).value;
  } catch {
    return escapeHtml(code);
  }
}

function CodeBlock(props: { snippet: ExtractedStepSnippet; output?: boolean }) {
  return (
    <div class={`extracted-code-block ${props.output ? "output-block" : ""}`}>
      <div class="code-head">
        <span>{props.snippet.title}</span>
        <small>{props.snippet.language}</small>
      </div>
      <pre><code innerHTML={highlightedCode(props.snippet.language, props.snippet.code)} /></pre>
    </div>
  );
}

function extractStepSnippets(thought: string): { text: string; snippets: ExtractedStepSnippet[] } {
  const parsed = parseJsonMaybe(thought);
  const calls = Array.isArray(parsed?.tool_calls)
    ? parsed.tool_calls as Record<string, unknown>[]
    : Array.isArray(parsed?.tools)
      ? parsed.tools as Record<string, unknown>[]
      : parsed && (typeof parsed.tool === "string" || typeof parsed.tool_name === "string" || typeof parsed.name === "string")
        ? [parsed]
        : splitAdjacentJsonObjects(thought)
          .map((item) => parseJsonMaybe(item))
          .filter((item): item is Record<string, unknown> => Boolean(item && (typeof item.tool === "string" || typeof item.tool_name === "string" || typeof item.name === "string")));
  if (!calls.length) return { text: thought, snippets: [] };

  const snippets: ExtractedStepSnippet[] = [];
  for (const call of calls) {
    const tool = String(call.tool ?? call.tool_name ?? call.name ?? "tool");
    const args = Array.isArray(call.args) ? call.args.map((item) => String(item)) : [];
    const target = typeof call.target === "string" ? call.target : "";
    const artifact = typeof call.artifact_path === "string" ? call.artifact_path : "";
    const input = call.input && typeof call.input === "object" && !Array.isArray(call.input) ? call.input : null;

    if (tool === "python" && args[0] === "-c" && typeof args[1] === "string") {
      snippets.push({ title: "python -c", language: "python", code: args[1] });
      continue;
    }

    const commandParts = [tool, ...args];
    if (target) commandParts.push(target);
    if (artifact) commandParts.push(artifact);
    if (input) commandParts.push(JSON.stringify(input));
    snippets.push({ title: tool, language: "bash", code: commandParts.join(" ") });
  }

  const reason = typeof parsed?.reason === "string" ? parsed.reason : "";
  return {
    text: reason || (snippets.length ? "AI 请求执行以下工具：" : thought),
    snippets
  };
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
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
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

function timestampMs(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatElapsed(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatTokenCount(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return "-";
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 2).replace(/\.?0+$/, "")}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(number >= 100_000 ? 0 : 1).replace(/\.?0+$/, "")}K`;
  return String(Math.round(number));
}

export default function App() {
  const initialRoute = parseRoute();
  const [tab, setTab] = createSignal<Tab>(initialRoute.tab);
  const [ctfStep, setCtfStep] = createSignal<CtfStep>(initialRoute.ctfStep);
  const [addAccountOpen, setAddAccountOpen] = createSignal(false);
  const [agentPage, setAgentPage] = createSignal<AgentPage>(initialRoute.agentPage);
  const [activePlatform, setActivePlatform] = createSignal<Platform>((localStorage.getItem("z3.activePlatform") as Platform) || "ctfd");
  const [config, setConfig] = createSignal<ApiConfig>(loadConfig());
  const [busy, setBusy] = createSignal(false);
  const [output, setOutput] = createSignal<unknown>({ message: "控制台已就绪。登录 CTF 平台后会自动解析比赛列表。" });
  const [errorDialog, setErrorDialog] = createSignal<ErrorDialog | null>(null);
  const [ctfNavigationHint, setCtfNavigationHint] = createSignal("");
  const [hubHealth, setHubHealth] = createSignal<unknown>(null);
  const [hubLoadedRoute, setHubLoadedRoute] = createSignal("");
  const [matchHealth, setMatchHealth] = createSignal<unknown>(null);
  const [tasks, setTasks] = createSignal<unknown[]>([]);
  const [selectedTaskDetail, setSelectedTaskDetail] = createSignal<unknown>(null);
  const [selectedTaskDetailId, setSelectedTaskDetailId] = createSignal("");
  const [assistantStreamText, setAssistantStreamText] = createSignal("");
  const [nowMs, setNowMs] = createSignal(Date.now());
  const [retryTaskId, setRetryTaskId] = createSignal("");
  const [retryPrompt, setRetryPrompt] = createSignal("");
  const [tools, setTools] = createSignal<unknown[]>([]);
  const [aiApiDraft, setAiApiDraft] = createSignal<AiApiDraft>(loadAiApiDraft());
  const [aiApiStatus, setAiApiStatus] = createSignal<unknown>(null);
  const [aiApiLoadedRoute, setAiApiLoadedRoute] = createSignal("");
  const [sessionId, setSessionId] = createSignal(localStorage.getItem("z3.matchSessionId") || "");
  const [accounts, setAccounts] = createSignal<CtfAccount[]>(loadAccounts());
  const [selectedAccountId, setSelectedAccountId] = createSignal(localStorage.getItem("z3.ctfAccountId") || "");
  const [contests, setContests] = createSignal<OptionItem[]>([]);
  const [contestPage, setContestPage] = createSignal(Number(localStorage.getItem("z3.contestPage") || "1"));
  const [contestTotal, setContestTotal] = createSignal<number | null>(null);
  const [contestCacheHint, setContestCacheHint] = createSignal("");
  const [contestBackgroundLoading, setContestBackgroundLoading] = createSignal(false);
  const [challenges, setChallenges] = createSignal<OptionItem[]>([]);
  const [challengeCacheHint, setChallengeCacheHint] = createSignal("");
  const [challengeBackgroundLoading, setChallengeBackgroundLoading] = createSignal(false);
  const [challengePage, setChallengePage] = createSignal(Number(localStorage.getItem("z3.challengePage") || "1"));
  const [challengeTotal, setChallengeTotal] = createSignal<number | null>(null);
  const [challengeTypeFilter, setChallengeTypeFilter] = createSignal("all");
  const [selectedContestId, setSelectedContestId] = createSignal(localStorage.getItem("z3.contestId") || "");
  const [selectedChallengeId, setSelectedChallengeId] = createSignal(localStorage.getItem("z3.challengeId") || "");
  const [selectedChallengeDetail, setSelectedChallengeDetail] = createSignal<unknown>(null);
  const [targetInfo, setTargetInfo] = createSignal<unknown>(null);
  const [flag, setFlag] = createSignal("");
  const [taskDraft, setTaskDraft] = createSignal<TaskDraft>({
    mode: "ctf_challenge",
    prompt: "分析这个 CTF 任务并给出下一步计划",
    target: "",
    priority: "medium",
    tags: "ctf,web"
  });
  const [sessionDraft, setSessionDraft] = createSignal<SessionDraft>({
    platform: activePlatform(),
    baseUrl: "http://ctfd.local",
    username: "",
    password: "",
    token: ""
  });
  const authReady = createMemo(() => Boolean(config().adminToken));
  const currentPlatform = createMemo(() => platforms.find((item) => item.id === sessionDraft().platform) ?? platforms[0]);
  const selectedAccount = createMemo(() => accounts().find((item) => item.id === selectedAccountId()));
  const challengeDirectionOf = (challenge: OptionItem) => normalizeChallengeDirection(challengeRecords(null, challenge.raw));
  const challengeTypeOptions = createMemo(() => Array.from(new Set(challenges().map(challengeDirectionOf).filter((item) => item && item !== "未知"))).sort());
  const filteredChallenges = createMemo(() => {
    const type = challengeTypeFilter();
    if (type === "all") return challenges();
    return challenges().filter((challenge) => challengeDirectionOf(challenge) === type);
  });
  const selectedChallenge = createMemo(() => challenges().find((item) => item.id === selectedChallengeId()));
  const selectedContestOption = createMemo(() => contests().find((item) => item.id === selectedContestId()));
  const selectedContestIsVirtual = createMemo(() => asRecord(selectedContestOption()?.raw).virtual === true);
  const selectedPlatform = createMemo(() => selectedAccount()?.platform || sessionDraft().platform);
  const targetApiSupported = createMemo(() => platformSupportsTargetApi(selectedPlatform()));
  const taskBoard = createMemo(() => {
    const lanes = taskLaneMeta.map((lane) => ({ ...lane, items: [] as Record<string, unknown>[] }));
    const laneMap = new Map(lanes.map((lane) => [lane.key, lane]));
    for (const task of tasks()) {
      const record = asRecord(task);
      const status = String(record.status ?? "pending").toLowerCase();
      const lane = laneMap.get(status as (typeof taskLaneMeta)[number]["key"]) ?? lanes[0];
      lane.items.push(record);
    }
    return lanes;
  });
  const selectedChallengeMeta = createMemo(() => {
    const records = challengeRecords(selectedChallengeDetail(), selectedChallenge()?.raw);
    return {
      description: firstValue(records, ["description", "desc", "content", "statement", "body", "text", "html", "markdown"], "暂无题目描述"),
      score: firstValue(records, ["score", "points", "point", "value", "current_score", "currentScore"], "未知"),
      solves: firstValue(records, ["solves", "solved", "solve_count", "solveCount", "solved_count", "solvedCount", "accepted", "ac_count", "solved_users", "solvedUsers"], "未知"),
      direction: normalizeChallengeDirection(records),
      hasAttachment: hasChallengeAttachment(records),
      hasTarget: hasChallengeTarget(records)
    };
  });
  const targetDisplayText = createMemo(() => {
    const fromTarget = extractTargetAddress(targetInfo());
    if (fromTarget) return fromTarget;
    const fromDetail = extractTargetAddress(selectedChallengeDetail());
    if (fromDetail) return fromDetail;
    if (targetLooksOpened(targetInfo()) || targetLooksOpened(selectedChallengeDetail())) return "已开启，等待平台返回靶机地址";
    return "尚未开启";
  });
  const aiApiLoadKey = () => `${globalThis.location.pathname}::${config().hubBase}::${config().adminToken}`;
  const hubUrl = (path: string, query: Record<string, string> = {}) => {
    const base = config().hubBase.replace(/\/+$/, "");
    const url = new URL(`${base}${path}`, globalThis.location.origin);
    for (const [key, value] of Object.entries(query)) {
      if (value) url.searchParams.set(key, value);
    }
    return url.toString();
  };
  const mergeTaskUpdate = (task: Record<string, unknown>) => {
    const taskId = String(task.task_id ?? "");
    if (!taskId) return;
    setTasks([task, ...tasks().filter((item) => String(asRecord(item).task_id) !== taskId)]);
    if (selectedTaskDetailId() === taskId) {
      setSelectedTaskDetail((current) => {
        const previous = asRecord(current);
        const previousResult = asRecord(previous.result);
        const nextResult = asRecord(task.result);
        return {
          ...previous,
          ...task,
          result: Object.keys(nextResult).length ? { ...previousResult, ...nextResult } : previous.result
        };
      });
    }
  };
  const aiApiSummary = createMemo(() => {
    const value = aiApiStatus();
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const contextPolicy = asRecord(record.context_policy);
    return {
      provider: String(record.provider ?? "未读取"),
      baseUrl: String(record.base_url ?? "未读取"),
      model: String(record.model ?? "未读取"),
      reasoningEffort: String(record.reasoning_effort ?? "default"),
      organization: String(record.organization ?? ""),
      apiKeySet: Boolean(record.api_key_set),
      updatedAt: String(record.updated_at ?? ""),
      contextWindow: contextPolicy.windowTokens,
      contextThreshold: contextPolicy.autoCompactThresholdTokens,
      contextEffective: contextPolicy.effectiveWindowTokens,
      reservedOutput: contextPolicy.reservedOutputTokens
    };
  });
  const taskElapsedText = (task: Record<string, unknown>) => {
    const started = timestampMs(task.started_at) ?? timestampMs(task.created_at);
    if (!started) return "-";
    const status = String(task.status ?? "").toLowerCase();
    const finished = timestampMs(task.completed_at) ?? timestampMs(task.failed_at) ?? timestampMs(asRecord(task.result).completed_at) ?? timestampMs(asRecord(task.result).failed_at);
    const end = status === "completed" || status === "failed" ? (finished ?? timestampMs(task.updated_at) ?? nowMs()) : nowMs();
    return formatElapsed(end - started);
  };
  let challengeRefreshSeq = 0;
  let ctfNavigationTimer: number | undefined;

  function showCtfRouteLoading(message: string) {
    if (ctfNavigationTimer !== undefined) {
      window.clearTimeout(ctfNavigationTimer);
      ctfNavigationTimer = undefined;
    }
    setCtfNavigationHint(message);
  }

  function clearCtfRouteLoading(delay = 900) {
    if (ctfNavigationTimer !== undefined) window.clearTimeout(ctfNavigationTimer);
    ctfNavigationTimer = window.setTimeout(() => {
      setCtfNavigationHint("");
      ctfNavigationTimer = undefined;
    }, delay);
  }

  function ctfCacheScope(accountId = selectedAccountId()) {
    if (accountId) return `account:${accountId}`;
    const draft = sessionDraft();
    return `session:${draft.platform}:${draft.baseUrl || "builtin"}:${draft.username || "token"}`;
  }

  function diffOptionLists(previous: OptionItem[], next: OptionItem[]) {
    const before = new Map(previous.map((item) => [item.id, item]));
    const after = new Map(next.map((item) => [item.id, item]));
    let added = 0;
    let removed = 0;
    let changed = 0;
    for (const [id, item] of after) {
      const old = before.get(id);
      if (!old) {
        added += 1;
        continue;
      }
      if (optionListFingerprint([old]) !== optionListFingerprint([item])) changed += 1;
    }
    for (const id of before.keys()) {
      if (!after.has(id)) removed += 1;
    }
    return { added, removed, changed, hasDiff: added > 0 || removed > 0 || changed > 0 };
  }

  function formatCacheTime(value: string) {
    if (!value) return "未知时间";
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
  }

  function applyChallenges(next: OptionItem[], options: { resetSelection?: boolean } = {}) {
    setChallenges(next);
    setChallengeTypeFilter("all");
    if (options.resetSelection) {
      setSelectedChallengeId("");
      localStorage.removeItem("z3.challengeId");
      setSelectedChallengeDetail(null);
      setTargetInfo(null);
      return;
    }
    if (selectedChallengeId() && !next.some((item) => item.id === selectedChallengeId())) {
      setSelectedChallengeId("");
      localStorage.removeItem("z3.challengeId");
      setSelectedChallengeDetail(null);
      setTargetInfo(null);
    }
  }

  function applyCachedContests(scope: string, page: number) {
    const cached = loadCachedContests(scope, page);
    if (!cached) return null;
    setContests(cached.items);
    setContestTotal(cached.total);
    setContestCacheHint(`已显示缓存，更新于 ${formatCacheTime(cached.updatedAt)}，后台校验平台差异中。`);
    return cached;
  }

  function challengeQuery(contestId: string, page = challengePage()) {
    const params = new URLSearchParams();
    if (contestId) params.set("contest_id", contestId);
    params.set("page", String(Math.max(1, page)));
    params.set("page_size", "50");
    return `?${params.toString()}`;
  }

  function applyRoute(route: RouteState) {
    setTab(route.tab);
    setCtfStep(route.ctfStep);
    setAgentPage(route.agentPage);
  }

  async function restoreCtfRoute(route: RouteState) {
    if (route.tab !== "ctf" || !route.accountId) return;
    const account = accounts().find((item) => item.id === route.accountId);
    if (!account) return;
    setSelectedAccountId(account.id);
    localStorage.setItem("z3.ctfAccountId", account.id);
    setActivePlatform(account.platform);
    setSessionDraft({
      platform: account.platform,
      baseUrl: account.baseUrl,
      username: account.username,
      password: account.password,
      token: account.token
    });
    const sid = sessionId() && selectedAccountId() === account.id
      ? sessionId()
      : await createSessionFromDraft(account, { navigateToContests: false, accountId: account.id, loadContests: false });
    if (!sid) return;
    if (route.contestId) {
      setSelectedContestId(route.contestId);
      localStorage.setItem("z3.contestId", route.contestId);
      openChallengesWithCache(sid, route.contestId, { resetSelection: false, accountId: account.id });
      if (route.challengeId) {
        await chooseChallenge(route.challengeId);
      }
    }
  }


  function navigate(route: Partial<RouteState>) {
    const next: RouteState = {
      tab: route.tab ?? tab(),
      ctfStep: route.ctfStep ?? ctfStep(),
      agentPage: route.agentPage ?? agentPage(),
      accountId: route.accountId,
      contestId: route.contestId,
      challengeId: route.challengeId
    };
    const path = routePath(next);
    if (globalThis.location.pathname !== path) {
      globalThis.history.pushState(null, "", path);
    }
    applyRoute(next);
  }

  onMount(() => {
    const clock = window.setInterval(() => setNowMs(Date.now()), 1000);
    if (globalThis.location.pathname === "/") {
      globalThis.history.replaceState(null, "", routePath(initialRoute));
    }
    void restoreCtfRoute(parseRoute());
    const onPopState = () => {
      const route = parseRoute();
      applyRoute(route);
      void restoreCtfRoute(route);
    };
    globalThis.addEventListener("popstate", onPopState);
    onCleanup(() => {
      window.clearInterval(clock);
      globalThis.removeEventListener("popstate", onPopState);
    });
  });

  createEffect(() => {
    if (tab() !== "agent" || agentPage() !== "ai-config" || !authReady()) return;
    if (aiApiLoadedRoute() === aiApiLoadKey()) return;
    void loadAiApiConfig();
  });

  createEffect(() => {
    if (tab() !== "agent" || agentPage() !== "workbench" || !authReady()) return;
    const key = `${globalThis.location.pathname}::${config().hubBase}::${config().adminToken}`;
    if (hubLoadedRoute() === key) return;
    void refreshHub();
  });

  createEffect(() => {
    if (tab() !== "agent" || agentPage() !== "workbench" || !authReady()) return;
    const hasActiveTask = tasks().some((task) => {
      const status = String(asRecord(task).status ?? "").toLowerCase();
      return status === "pending" || status === "running";
    });
    if (!hasActiveTask) return;
    const timer = setTimeout(() => void refreshHub(), 3000);
    onCleanup(() => clearTimeout(timer));
  });

  createEffect(() => {
    const taskId = selectedTaskDetailId();
    if (!taskId || !authReady()) return;
    let stopped = false;
    let inFlight = false;
    let fallbackTimer: number | undefined;
    let eventSource: EventSource | undefined;
    const refresh = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const detail = await hubGet(config(), `/tasks/${encodeURIComponent(taskId)}`);
        if (!stopped && selectedTaskDetailId() === taskId) {
          setSelectedTaskDetail(detail);
          mergeTaskUpdate(asRecord(detail));
        }
      } catch {
        // 详情自动刷新不打断用户查看，也不污染全局输出。
      } finally {
        inFlight = false;
      }
    };

    const startFallbackPolling = () => {
      if (fallbackTimer !== undefined) return;
      fallbackTimer = window.setInterval(refresh, 2000);
    };

    void refresh();
    try {
      eventSource = new EventSource(hubUrl(`/tasks/${encodeURIComponent(taskId)}/events`, { token: config().adminToken }));
      eventSource.onopen = () => {
        if (fallbackTimer !== undefined) {
          clearInterval(fallbackTimer);
          fallbackTimer = undefined;
        }
      };
      eventSource.onmessage = (event) => {
        const parsed = parseJsonMaybe(event.data);
        const task = asRecord(asRecord(parsed?.payload).task);
        if (task.task_id) mergeTaskUpdate(task);
      };
      for (const eventName of ["snapshot", "task.created", "task.status", "task.retry", "task.comment", "task.artifact", "task.cancelled", "activity", "agent.progress", "tool.result", "assistant.delta", "assistant.message", "assistant.error", "final", "error"]) {
        eventSource.addEventListener(eventName, (event) => {
          const parsed = parseJsonMaybe((event as MessageEvent).data);
          const payload = asRecord(parsed?.payload);
          const task = asRecord(payload.task);
          if (task.task_id) mergeTaskUpdate(task);
          if (eventName === "assistant.delta" && String(parsed?.task_id ?? "") === taskId) {
            setAssistantStreamText((current) => `${current}${String(payload.text ?? "")}`);
          }
          if (eventName === "assistant.message" || eventName === "agent.progress" || eventName === "final" || eventName === "error") {
            setAssistantStreamText("");
          }
          if (eventName === "final" || eventName === "error" || eventName === "task.cancelled") {
            eventSource?.close();
          }
        });
      }
      eventSource.onerror = () => {
        eventSource?.close();
        startFallbackPolling();
      };
    } catch {
      startFallbackPolling();
    }

    onCleanup(() => {
      stopped = true;
      eventSource?.close();
      if (fallbackTimer !== undefined) clearInterval(fallbackTimer);
    });
  });


  function platformMeta(platform: Platform) {
    return platforms.find((item) => item.id === platform) ?? platforms[0];
  }

  function accountTitle(account: CtfAccount) {
    return account.name || `${platformMeta(account.platform).title} / ${account.username || "token"}`;
  }

  function contestTitle(contest: BoundContest) {
    return contest.title || contest.id;
  }

  function resetCtfSelection() {
    setCtfNavigationHint("");
    setSessionId("");
    localStorage.removeItem("z3.matchSessionId");
    setContests([]);
    setContestTotal(null);
    setContestCacheHint("");
    setContestBackgroundLoading(false);
    setChallenges([]);
    setChallengeCacheHint("");
    setChallengeBackgroundLoading(false);
    setChallengePage(1);
    setChallengeTotal(null);
    setChallengeTypeFilter("all");
    setSelectedContestId("");
    setSelectedChallengeId("");
    setSelectedChallengeDetail(null);
    setTargetInfo(null);
  }

  function switchPlatform(platform: Platform) {
    setActivePlatform(platform);
    localStorage.setItem("z3.activePlatform", platform);
    const meta = platformMeta(platform);
    setSessionDraft({ ...sessionDraft(), platform, baseUrl: meta.needsBaseUrl ? sessionDraft().baseUrl : "" });
    setAddAccountOpen(true);
  }

  function goCtfStep(step: CtfStep) {
    navigate({
      tab: "ctf",
      ctfStep: step,
      accountId: selectedAccountId() || undefined,
      contestId: step === "challenges" ? selectedContestId() || undefined : undefined,
      challengeId: step === "challenges" ? selectedChallengeId() || undefined : undefined
    });
  }

  function goAgentPage(page: AgentPage) {
    navigate({ tab: "agent", agentPage: page });
  }

  function updateAiApiDraft(patch: Partial<AiApiDraft>) {
    const next = { ...aiApiDraft(), ...patch };
    setAiApiDraft(next);
    saveAiApiDraft(next);
  }

  function updateAiProvider(provider: (typeof aiProviderOptions)[number]) {
    const defaults = aiProviderDefaults[provider];
    updateAiApiDraft({ provider, baseUrl: defaults.baseUrl, model: defaults.model, reasoningEffort: "default" });
  }

  function updateConfig(patch: Partial<ApiConfig>) {
    const next = { ...config(), ...patch };
    setConfig(next);
    saveConfig(next);
  }

  function setAccountList(next: CtfAccount[]) {
    setAccounts(next);
    saveAccounts(next);
  }

  function updateAccount(accountId: string, updater: (account: CtfAccount) => CtfAccount) {
    const next = accounts().map((item) => item.id === accountId ? updater(item) : item);
    setAccountList(next);
  }

  function bindContestToSelected(contest: OptionItem) {
    const account = selectedAccount();
    if (!account) return;
    const bound: BoundContest = {
      id: contest.id,
      title: contest.title,
      subtitle: contest.subtitle,
      raw: contest.raw,
      addedAt: new Date().toISOString()
    };
    updateAccount(account.id, (item) => {
      const rest = item.contests.filter((x) => x.id !== bound.id);
      return { ...item, contests: [bound, ...rest], updatedAt: bound.addedAt };
    });
  }

  function removeBoundContest(accountId: string, contestId: string) {
    updateAccount(accountId, (item) => ({
      ...item,
      contests: item.contests.filter((contest) => contest.id !== contestId),
      updatedAt: new Date().toISOString()
    }));
    if (selectedAccountId() === accountId && selectedContestId() === contestId) {
      setSelectedContestId("");
      setSelectedChallengeId("");
      setSelectedChallengeDetail(null);
    setTargetInfo(null);
    }
  }

  async function run<T>(title: string, fn: () => Promise<T>, after?: (value: T) => void) {
    setBusy(true);
    setOutput({ running: title });
    try {
      const value = await fn();
      after?.(value);
      setOutput(() => value);
      return value;
    } catch (error) {
      showRequestError(title, error);
      setOutput({ error: statusText(error), payload: error instanceof ApiError ? error.payload : null });
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  function showRequestError(title: string, error: unknown) {
    const payload = error instanceof ApiError
      ? error.payload
      : error instanceof Error
        ? { name: error.name, message: error.message }
        : error;
    setErrorDialog({
      title,
      message: statusText(error),
      ...(error instanceof ApiError ? { status: error.status } : {}),
      ...(error instanceof ApiError ? { method: error.request.method, url: error.request.url } : {}),
      payload
    });
  }

  async function loadAiApiConfig() {
    const value = await run("读取 AI API 配置", () => hubGet(config(), "/hub/ai-config"), (value: any) => {
      const next = {
        ...aiApiDraft(),
        provider: value?.provider || aiApiDraft().provider,
        baseUrl: value?.base_url || aiApiDraft().baseUrl,
        model: value?.model || aiApiDraft().model,
        reasoningEffort: value?.reasoning_effort || "default",
        organization: value?.organization || "",
        apiKey: ""
      };
      setAiApiDraft(next);
      saveAiApiDraft(next);
      setAiApiStatus(value);
    });
    if (value !== undefined) {
      setAiApiLoadedRoute(aiApiLoadKey());
    }
  }

  async function saveAiApiConfig() {
    const draft = aiApiDraft();
    const body: Record<string, unknown> = {
      provider: draft.provider,
      base_url: draft.baseUrl,
      model: draft.model,
      reasoning_effort: draft.reasoningEffort,
      organization: draft.organization || undefined
    };
    if (draft.apiKey) body.api_key = draft.apiKey;
    await run("保存 AI API 配置", () => hubPatch(config(), "/hub/ai-config", body), (value) => {
      setAiApiStatus(value);
      updateAiApiDraft({ apiKey: "" });
    });
  }

  async function refreshHub() {
    await run("刷新 Agent Hub", async () => {
      const [health, info, taskList, toolList] = await Promise.all([
        hubGet(config(), "/health"),
        hubGet(config(), "/hub/info"),
        hubGet(config(), "/tasks?limit=20"),
        hubGet(config(), "/tools")
      ]);
      return { health, info, taskList, toolList };
    }, (value: any) => {
      setHubHealth(value.health);
      setTasks(value.taskList?.tasks || []);
      setTools(value.toolList?.tools || []);
      setHubLoadedRoute(`${globalThis.location.pathname}::${config().hubBase}::${config().adminToken}`);
    });
  }

  async function createTask() {
    const draft = taskDraft();
    await run("创建 Agent 任务", () => hubPost(config(), "/tasks", {
      mode: draft.mode,
      prompt: draft.prompt,
      target: draft.target || undefined,
      priority: draft.priority,
      tags: draft.tags.split(",").map((x) => x.trim()).filter(Boolean)
    }), (task: any) => {
      setTasks([task, ...tasks()]);
      setTimeout(() => void refreshHub(), 800);
      setTimeout(() => void refreshHub(), 2500);
    });
  }

  async function completeTask(taskId: string) {
    await run("更新任务状态", () => hubPatch(config(), `/tasks/${taskId}/status`, { status: "completed", comment: "frontend marked completed" }));
    await refreshHub();
  }

  function openRetryTask(taskId: string, event?: Event) {
    event?.stopPropagation();
    if (!taskId || taskId === "undefined") return;
    setRetryTaskId(taskId);
    setRetryPrompt("");
  }

  function closeRetryTask() {
    setRetryTaskId("");
    setRetryPrompt("");
  }

  async function retryTask() {
    const taskId = retryTaskId();
    const prompt = retryPrompt().trim();
    if (!taskId || !prompt) return;
    await run("重试任务", () => hubPost(config(), `/tasks/${encodeURIComponent(taskId)}/retry`, { prompt }), (task: any) => {
      setTasks([task, ...tasks().filter((item) => String(asRecord(item).task_id) !== taskId)]);
      closeRetryTask();
      setTimeout(() => void refreshHub(), 800);
      setTimeout(() => void refreshHub(), 2500);
    });
  }

  async function openTaskDetail(taskId: string) {
    if (!taskId || taskId === "undefined") return;
    setAssistantStreamText("");
    setSelectedTaskDetailId(taskId);
    await run("读取任务详情", () => hubGet(config(), `/tasks/${encodeURIComponent(taskId)}`), setSelectedTaskDetail);
  }

  function closeTaskDetail() {
    setSelectedTaskDetailId("");
    setSelectedTaskDetail(null);
    setAssistantStreamText("");
  }

  async function refreshMatch() {
    await run("刷新 CTF 平台后端", async () => {
      const [health, platformsPayload] = await Promise.all([
        matchGet(config(), "/health"),
        matchGet(config(), "/api/platforms")
      ]);
      return { health, platforms: platformsPayload };
    }, (value: any) => setMatchHealth(value));
  }

  async function loadContests(sid = sessionId(), page = contestPage(), options: { silent?: boolean } = {}) {
    if (!sid) throw new Error("请先登录平台");
    const safePage = Math.max(1, page);
    const scope = ctfCacheScope();
    setContestPage(safePage);
    localStorage.setItem("z3.contestPage", String(safePage));
    const cached = loadCachedContests(scope, safePage);
    if (cached) {
      setContests(cached.items);
      setContestTotal(cached.total);
      setContestCacheHint(`已显示缓存，更新于 ${formatCacheTime(cached.updatedAt)}，正在校验平台差异。`);
    } else {
      setContestCacheHint("暂无比赛缓存，正在读取平台。");
    }
    let payload: unknown;
    if (options.silent) {
      setContestBackgroundLoading(true);
      try {
        payload = await matchGet(config(), `/api/sessions/${sid}/contests?page=${safePage}`);
      } catch (error) {
        setContestCacheHint(`后台读取比赛失败：${statusText(error)}`);
        return cached?.items ?? [];
      } finally {
        setContestBackgroundLoading(false);
      }
    } else {
      payload = await run(`解析比赛列表 / 第 ${safePage} 页`, () => matchGet(config(), `/api/sessions/${sid}/contests?page=${safePage}`));
    }
    if (payload === undefined) return cached?.items ?? [];
    const parsed = toContestOptions(payload);
    const total = listingTotal(payload);
    const previous = cached?.items ?? contests();
    const diff = diffOptionLists(previous, parsed);
    const nextCache = saveCachedContests(scope, safePage, parsed, total);
    if (!cached || cached.fingerprint !== nextCache.fingerprint) {
      setContests(parsed);
      setContestTotal(total);
      setContestCacheHint(diff.hasDiff ? `比赛缓存已更新：新增 ${diff.added}，移除 ${diff.removed}，变化 ${diff.changed}。` : "比赛缓存已更新。");
    } else {
      setContestCacheHint(`比赛列表无变化，缓存时间 ${formatCacheTime(nextCache.updatedAt)}。`);
    }
    setChallenges([]);
    setChallengeCacheHint("");
    setChallengePage(1);
    setChallengeTotal(null);
    setChallengeTypeFilter("all");
    setSelectedContestId("");
    setSelectedChallengeId("");
    setSelectedChallengeDetail(null);
    setTargetInfo(null);
    if (parsed.length === 0 && safePage === 1) {
      openChallengesWithCache(sid, "", { resetSelection: true });
    }
    return parsed;
  }

  async function loadChallenges(sid = sessionId(), contestId = selectedContestId(), page = challengePage()) {
    if (!sid) throw new Error("请先登录平台");
    const safePage = Math.max(1, page);
    const scope = ctfCacheScope();
    setChallengePage(safePage);
    localStorage.setItem("z3.challengePage", String(safePage));
    const payload = await run(`解析题目列表 / 第 ${safePage} 页`, () => matchGet(config(), `/api/sessions/${sid}/challenges${challengeQuery(contestId, safePage)}`));
    if (payload === undefined) return loadCachedChallenges(scope, contestId, safePage)?.items ?? [];
    const parsed = toChallengeOptions(payload);
    const total = listingTotal(payload);
    const cached = loadCachedChallenges(scope, contestId, safePage);
    const diff = diffOptionLists(cached?.items ?? challenges(), parsed);
    const nextCache = saveCachedChallenges(scope, contestId, safePage, parsed, total);
    setChallengeTotal(total);
    applyChallenges(parsed, { resetSelection: true });
    setChallengeCacheHint(cached && cached.fingerprint === nextCache.fingerprint ? `题目列表无变化，缓存时间 ${formatCacheTime(nextCache.updatedAt)}。` : `题目缓存已更新：新增 ${diff.added}，移除 ${diff.removed}，变化 ${diff.changed}。`);
    return parsed;
  }

  function openChallengesWithCache(sid = sessionId(), contestId = selectedContestId(), options: { resetSelection?: boolean; accountId?: string; page?: number } = {}) {
    const scope = ctfCacheScope(options.accountId);
    const safePage = Math.max(1, options.page ?? challengePage());
    setChallengePage(safePage);
    localStorage.setItem("z3.challengePage", String(safePage));
    const cached = loadCachedChallenges(scope, contestId, safePage);
    if (cached) {
      applyChallenges(cached.items, { resetSelection: options.resetSelection ?? true });
      setChallengeTotal(cached.total);
      setChallengeCacheHint(`已显示第 ${safePage} 页缓存题目，更新于 ${formatCacheTime(cached.updatedAt)}，后台校验差异中。`);
    } else {
      applyChallenges([], { resetSelection: options.resetSelection ?? true });
      setChallengeTotal(null);
      setChallengeCacheHint(`暂无第 ${safePage} 页题目缓存，后台读取平台题目中。`);
    }
    void refreshChallengesInBackground(sid, contestId, safePage, scope, cached);
  }

  async function refreshChallengesInBackground(sid: string, contestId: string, page: number, scope: string, cached: ReturnType<typeof loadCachedChallenges>) {
    const seq = ++challengeRefreshSeq;
    setChallengeBackgroundLoading(true);
    try {
      const payload = await matchGet(config(), `/api/sessions/${sid}/challenges${challengeQuery(contestId, page)}`);
      const parsed = toChallengeOptions(payload);
      const total = listingTotal(payload);
      const currentCache = loadCachedChallenges(scope, contestId, page) ?? cached;
      const nextCache = saveCachedChallenges(scope, contestId, page, parsed, total);
      const diff = diffOptionLists(currentCache?.items ?? [], parsed);
      if (seq !== challengeRefreshSeq) return;
      const stillCurrent = sessionId() === sid && selectedContestId() === contestId && challengePage() === page;
      if (currentCache?.fingerprint === nextCache.fingerprint) {
        setChallengeTotal(total);
        setChallengeCacheHint(`后台校验完成，第 ${page} 页题目无变化。缓存时间 ${formatCacheTime(nextCache.updatedAt)}。`);
        return;
      }
      if (stillCurrent) {
        setChallengeTotal(total);
        applyChallenges(parsed, { resetSelection: false });
      }
      setChallengeCacheHint(`后台发现第 ${page} 页题目差异并已更新：新增 ${diff.added}，移除 ${diff.removed}，变化 ${diff.changed}。`);
    } catch (error) {
      if (seq === challengeRefreshSeq) {
        setChallengeCacheHint(`后台读取题目失败：${statusText(error)}`);
      }
    } finally {
      if (seq === challengeRefreshSeq) setChallengeBackgroundLoading(false);
    }
  }

  async function createSessionFromDraft(draft: SessionDraft, options: { navigateToContests?: boolean; accountId?: string; loadContests?: boolean } = {}) {
    const meta = platformMeta(draft.platform);
    if (meta.needsBaseUrl && !draft.baseUrl.trim()) {
      setOutput({ error: `${meta.title} 需要 Base URL` });
      return;
    }
    if (!draft.token.trim() && (!draft.username.trim() || !draft.password.trim())) {
      setOutput({ error: "请填写 Token，或填写用户名和密码" });
      return;
    }
    const auth = draft.token ? { token: draft.token } : { username: draft.username, password: draft.password };
    const payload: Record<string, unknown> = {
      platform: draft.platform,
      auth
    };
    if (meta.needsBaseUrl && draft.baseUrl) payload.base_url = draft.baseUrl;
    const value = await run("创建 CTF 平台 Session", () => matchPost(config(), "/api/sessions", payload));
    const sid = asRecord(value).session_id;
    if (typeof sid === "string") {
      setSessionId(sid);
      localStorage.setItem("z3.matchSessionId", sid);
      if (options.navigateToContests !== false) {
        navigate({ tab: "ctf", ctfStep: "contests", accountId: options.accountId || selectedAccountId() || undefined });
      }
      if (options.loadContests !== false) {
        const scope = ctfCacheScope(options.accountId);
        applyCachedContests(scope, 1);
        void loadContests(sid, 1, { silent: true });
      }
      return sid;
    }
    return undefined;
  }

  async function createSession() {
    await createSessionFromDraft(sessionDraft());
  }

  function newAccountName(draft: SessionDraft) {
    const meta = platformMeta(draft.platform);
    return `${meta.title} / ${draft.username || "Token 登录"}`;
  }

  async function saveAccount(loginAfter = true) {
    const draft = sessionDraft();
    const meta = platformMeta(draft.platform);
    if (meta.needsBaseUrl && !draft.baseUrl.trim()) {
      setOutput({ error: `${meta.title} 需要 Base URL` });
      return;
    }
    if (!draft.token.trim() && (!draft.username.trim() || !draft.password.trim())) {
      setOutput({ error: "请填写 Token，或填写用户名和密码" });
      return;
    }
    const now = new Date().toISOString();
    const account: CtfAccount = {
      ...draft,
      id: makeId(),
      name: newAccountName(draft),
      contests: [],
      createdAt: now,
      updatedAt: now
    };
    const next = [account, ...accounts()];
    setAccountList(next);
    setSelectedAccountId(account.id);
    localStorage.setItem("z3.ctfAccountId", account.id);
    resetCtfSelection();
    if (loginAfter) {
      setAddAccountOpen(false);
      await createSessionFromDraft(account, { accountId: account.id });
    } else {
      setAddAccountOpen(false);
      goCtfStep("accounts");
    }
  }

  async function chooseAccount(account: CtfAccount) {
    setSelectedAccountId(account.id);
    localStorage.setItem("z3.ctfAccountId", account.id);
    setActivePlatform(account.platform);
    setSessionDraft({
      platform: account.platform,
      baseUrl: account.baseUrl,
      username: account.username,
      password: account.password,
      token: account.token
    });
    resetCtfSelection();
    showCtfRouteLoading("正在进入比赛选择");
    await createSessionFromDraft(account, { accountId: account.id });
    clearCtfRouteLoading();
  }

  async function chooseBoundContest(account: CtfAccount, contest: BoundContest) {
    setSelectedAccountId(account.id);
    localStorage.setItem("z3.ctfAccountId", account.id);
    setActivePlatform(account.platform);
    setSessionDraft({
      platform: account.platform,
      baseUrl: account.baseUrl,
      username: account.username,
      password: account.password,
      token: account.token
    });
    resetCtfSelection();
    showCtfRouteLoading("正在进入题目选择");
    const sid = await createSessionFromDraft(account, { navigateToContests: false, accountId: account.id, loadContests: false });
    if (!sid) {
      setCtfNavigationHint("");
      return;
    }
    setSelectedContestId(contest.id);
    localStorage.setItem("z3.contestId", contest.id);
    setChallengePage(1);
    localStorage.setItem("z3.challengePage", "1");
    navigate({ tab: "ctf", ctfStep: "challenges", accountId: account.id, contestId: contest.id });
    openChallengesWithCache(sid, contest.id, { resetSelection: true, accountId: account.id, page: 1 });
    clearCtfRouteLoading();
  }

  function deleteAccount(accountId: string) {
    const next = accounts().filter((item) => item.id !== accountId);
    setAccountList(next);
    if (selectedAccountId() === accountId) {
      setSelectedAccountId("");
      localStorage.removeItem("z3.ctfAccountId");
      resetCtfSelection();
      goCtfStep("accounts");
    }
  }

  async function chooseContest(contestId: string) {
    showCtfRouteLoading("正在进入题目选择");
    setSelectedContestId(contestId);
    localStorage.setItem("z3.contestId", contestId);
    setChallengePage(1);
    localStorage.setItem("z3.challengePage", "1");
    const contest = contests().find((item) => item.id === contestId);
    if (contest) bindContestToSelected(contest);
    navigate({ tab: "ctf", ctfStep: "challenges", accountId: selectedAccountId() || undefined, contestId });
    openChallengesWithCache(sessionId(), contestId, { resetSelection: true, page: 1 });
    const selected = contests().find((item) => item.id === contestId);
    if (asRecord(selected?.raw).virtual === true) {
      setOutput(selected?.raw ?? selected ?? {});
    } else {
      void matchGet(config(), `/api/sessions/${sessionId()}/contests/${encodeURIComponent(contestId)}`)
      .then((value) => setOutput(value))
      .catch((error) => setOutput({ error: `读取比赛详情失败：${statusText(error)}` }));
    }
    clearCtfRouteLoading();
  }

  async function chooseChallenge(challengeId: string) {
    setSelectedChallengeId(challengeId);
    localStorage.setItem("z3.challengeId", challengeId);
    const cid = selectedContestId();
    const suffix = cid ? `?contest_id=${encodeURIComponent(cid)}` : "";
    setTargetInfo(null);
    await run("读取题目详情", () => matchGet(config(), `/api/sessions/${sessionId()}/challenges/${encodeURIComponent(challengeId)}${suffix}`), setSelectedChallengeDetail);
    navigate({ tab: "ctf", ctfStep: "challenges", accountId: selectedAccountId() || undefined, contestId: cid || undefined, challengeId });
  }

  async function startTarget() {
    if (!targetApiSupported()) {
      setOutput({ error: `${platformMeta(selectedPlatform()).title} 暂未接入开启靶机 API` });
      return;
    }
    const cid = selectedContestId();
    const suffix = cid ? `?contest_id=${encodeURIComponent(cid)}` : "";
    const value = await run("开启靶机", () => matchPost(config(), `/api/sessions/${sessionId()}/challenges/${encodeURIComponent(selectedChallengeId())}/target${suffix}`), setTargetInfo);
    if (value) {
      try {
        const detail = await matchGet(config(), `/api/sessions/${sessionId()}/challenges/${encodeURIComponent(selectedChallengeId())}${suffix}`);
        setSelectedChallengeDetail(detail);
      } catch {
        // 详情刷新失败时保留开启靶机接口返回值，避免 UI 又退回“尚未开启”。
      }
    }
  }

  async function closeTarget() {
    if (!targetApiSupported()) {
      setOutput({ error: `${platformMeta(selectedPlatform()).title} 暂未接入关闭靶机 API` });
      return;
    }
    const cid = selectedContestId();
    const suffix = cid ? `?contest_id=${encodeURIComponent(cid)}` : "";
    await run("关闭靶机", () => matchDelete(config(), `/api/sessions/${sessionId()}/challenges/${encodeURIComponent(selectedChallengeId())}/target${suffix}`), (value) => {
      setTargetInfo(value);
    });
  }

  async function submitFlag() {
    const cid = selectedContestId();
    const suffix = cid ? `?contest_id=${encodeURIComponent(cid)}` : "";
    await run("提交 Flag", () => matchPost(config(), `/api/sessions/${sessionId()}/challenges/${encodeURIComponent(selectedChallengeId())}/submit${suffix}`, { flag: flag() }));
  }

  async function downloadAttachment() {
    const cid = selectedContestId();
    const suffix = cid ? `?contest_id=${encodeURIComponent(cid)}` : "";
    await run("下载附件", () => matchPost(config(), `/api/sessions/${sessionId()}/challenges/${encodeURIComponent(selectedChallengeId())}/download${suffix}`));
  }

	  function buildAiSolvePrompt(input: {
	    attachmentPaths: string[];
	    targetAddress: string;
	    prepErrors: string[];
	  }) {
	    const challenge = selectedChallenge();
	    const meta = selectedChallengeMeta();
	    return [
	      "请作为 CTF 自动解题 Agent 解这道题。默认中文输出，积极使用可用工具分析附件/靶机并尝试拿到 flag。解出后无需手动提交，平台提交由系统自动处理。",
	      "",
	      "## 题目信息",
	      `题目 ID: ${selectedChallengeId()}`,
      `题目标题: ${challenge?.title || "未知"}`,
      `题目方向: ${meta.direction}`,
      `当前分数: ${meta.score}`,
      `已解出数: ${meta.solves}`,
      "",
      "## 题目描述",
      String(meta.description || "暂无题目描述"),
      "",
	      "## 附件",
	      input.attachmentPaths.length
	        ? input.attachmentPaths.map((item) => `- ${item}`).join("\n")
	        : "- 无附件",
	      "",
	      "## 靶机",
	      input.targetAddress
	        ? `靶机地址: ${input.targetAddress}`
	        : "无靶机",
	      "",
	      input.prepErrors.length ? `## 准备阶段错误\n${input.prepErrors.map((item) => `- ${item}`).join("\n")}` : ""
	    ].filter((item) => item !== "").join("\n");
	  }

  async function solveChallengeWithAi() {
    if (!selectedChallengeId()) return;
    if (!authReady()) {
      setOutput({ error: "Hub Token 未配置，无法创建 AI 解题任务" });
      return;
    }

    await run("准备题目信息并创建 AI 解题任务", async () => {
      const cid = selectedContestId();
      const suffix = cid ? `?contest_id=${encodeURIComponent(cid)}` : "";
      let detail = selectedChallengeDetail();
      const prepErrors: string[] = [];
      let attachmentResult: unknown = null;
      let targetResult: unknown = null;

      if (!detail) {
        try {
          detail = await matchGet(config(), `/api/sessions/${sessionId()}/challenges/${encodeURIComponent(selectedChallengeId())}${suffix}`);
          setSelectedChallengeDetail(detail);
        } catch (error) {
          prepErrors.push(`读取题目详情失败: ${statusText(error)}`);
        }
      }

      if (selectedChallengeMeta().hasAttachment) {
        try {
          attachmentResult = await matchPost(config(), `/api/sessions/${sessionId()}/challenges/${encodeURIComponent(selectedChallengeId())}/download${suffix}`);
        } catch (error) {
          prepErrors.push(`下载附件失败: ${statusText(error)}`);
        }
      }

      if (selectedChallengeMeta().hasTarget) {
        if (!targetApiSupported()) {
          prepErrors.push(`${platformMeta(selectedPlatform()).title} 暂未接入开启靶机 API`);
        } else {
          try {
            targetResult = await matchPost(config(), `/api/sessions/${sessionId()}/challenges/${encodeURIComponent(selectedChallengeId())}/target${suffix}`);
            setTargetInfo(targetResult);
            try {
              const refreshed = await matchGet(config(), `/api/sessions/${sessionId()}/challenges/${encodeURIComponent(selectedChallengeId())}${suffix}`);
              setSelectedChallengeDetail(refreshed);
              detail = refreshed;
            } catch {
              // 开启靶机后详情刷新失败时，继续使用开启接口返回值。
            }
          } catch (error) {
            prepErrors.push(`开启靶机失败: ${statusText(error)}`);
          }
        }
      }

      const attachmentPaths = extractDownloadedPaths(attachmentResult);
      const targetAddress = extractTargetAddress(targetResult) || extractTargetAddress(targetInfo()) || extractTargetAddress(detail);
      const prompt = buildAiSolvePrompt({ attachmentPaths, targetAddress, prepErrors });
      const task = await hubPost(config(), "/tasks", {
        mode: "ctf_challenge",
        prompt,
        target: targetAddress || undefined,
        priority: "high",
        tags: ["ctf", selectedPlatform(), selectedChallengeMeta().direction, selectedChallenge()?.title || selectedChallengeId()].filter(Boolean),
        ctf_context: {
          auto_submit: true,
          session_id: sessionId(),
          challenge_id: selectedChallengeId(),
          contest_id: cid || undefined
        }
      });
      return { task, attachment_paths: attachmentPaths, target: targetAddress, prep_errors: prepErrors };
    }, (value: any) => {
      const task = value?.task;
      if (task) {
        setTasks([task, ...tasks()]);
        setTimeout(() => void refreshHub(), 800);
        setTimeout(() => void refreshHub(), 2500);
      }
    });
  }

  async function scoreboard() {
    const cid = selectedContestId();
    await run("读取榜单", () => matchGet(config(), `/api/sessions/${sessionId()}/scoreboard${cid ? `?contest_id=${encodeURIComponent(cid)}` : ""}`));
  }

  return (
    <main>
      <div class="bg-lines" />
      <header class="titlebar">
        <div class="brand">
          <span class="brand-primary">CTF</span>
          <span class="slash">::</span>
          <span>Platform Console</span>
          <span class="cursor">_</span>
        </div>
        <nav>
          <button class={tab() === "ctf" ? "active" : ""} onClick={() => navigate({ tab: "ctf", ctfStep: "accounts" })}>CTF 平台</button>
          <button class={tab() === "agent" ? "active" : ""} onClick={() => navigate({ tab: "agent", agentPage: "workbench" })}>Agent Hub</button>
          <button class={tab() === "settings" ? "active" : ""} onClick={() => navigate({ tab: "settings" })}>设置</button>
        </nav>
      </header>

      <Show when={errorDialog()}>
        {(dialog) => (
          <div class="modal-backdrop" onClick={() => setErrorDialog(null)}>
            <section class="modal-card glass error-modal" onClick={(event) => event.stopPropagation()}>
              <div class="section-head">
                <div>
                  <p class="eyebrow">Backend Error</p>
                  <h2>后端请求失败</h2>
                </div>
                <button class="ghost" onClick={() => setErrorDialog(null)}>关闭</button>
              </div>
              <div class="error-summary">
                <span><b>{dialog().status ?? "ERR"}</b><small>状态</small></span>
                <span><b>{dialog().title}</b><small>请求</small></span>
                <Show when={dialog().url}>
                  <span class="error-url"><b>{dialog().method || "GET"} {dialog().url}</b><small>地址</small></span>
                </Show>
              </div>
              <pre class="task-text error">{dialog().message}</pre>
              <Show when={dialog().payload !== undefined && dialog().payload !== null}>
                <section class="task-detail-section">
                  <h3>返回内容</h3>
                  <pre class="task-text">{clippedJson(dialog().payload, 12000)}</pre>
                </section>
              </Show>
            </section>
          </div>
        )}
      </Show>

      <section class="page-shell">
        <section class="content">
          <Show when={tab() === "ctf"}>
            <section class="platform-main">
              <div class="platform-head platform-head-plain">
                <div>
                  <p class="eyebrow">CTF Accounts</p>
                  <h2>{selectedAccount() ? accountTitle(selectedAccount()!) : "账号管理"}</h2>
                </div>
                <nav class="step-nav">
                  <button class={ctfStep() === "accounts" ? "active" : ""} onClick={() => goCtfStep("accounts")}>账号</button>
                  <button class={ctfStep() === "contests" ? "active" : ""} onClick={() => goCtfStep("contests")} disabled={!sessionId()}>比赛</button>
                  <button class={ctfStep() === "challenges" ? "active" : ""} onClick={() => goCtfStep("challenges")} disabled={!sessionId() || !selectedContestId()}>题目</button>
                </nav>
              </div>

              <Show when={ctfNavigationHint()}>
                <div class="route-loading">
                  <span class="route-spinner" />
                  <b>{ctfNavigationHint()}</b>
                  <small>正在准备缓存和后台同步</small>
                  <span class="route-bar" />
                </div>
              </Show>

              <Show when={ctfStep() === "accounts"}>
                <section class="panel glass page-panel accounts-page">
                  <div class="section-head">
                    <h2>账号列表</h2>
                    <span>{accounts().length} 个账号</span>
                  </div>
                  <div class="button-row page-actions">
                    <button class="primary" onClick={() => setAddAccountOpen(true)}>添加账号</button>
                    <button onClick={refreshMatch} disabled={busy()}>刷新平台后端</button>
                  </div>
                  <Show when={accounts().length} fallback={<div class="empty-detail"><p class="eyebrow">Account</p><h2>暂无账号</h2><p class="muted">点击“添加账号”弹窗添加平台账号；之后选择账号读取比赛，选择比赛后会绑定到该账号。</p></div>}>
                    <div class="account-grid">
                      <For each={accounts()}>{(account) => (
                        <article class={`account-card ${selectedAccountId() === account.id ? "selected" : ""}`}>
                          <div class="account-card-head">
                            <button class="account-main" onClick={() => chooseAccount(account)} disabled={busy()} title="选择账号后进入比赛页面，可继续绑定更多比赛">
                              <b>{accountTitle(account)}</b>
                              <span>{platformMeta(account.platform).desc}</span>
                              <small>{account.baseUrl || "内置平台入口"} · 已绑定 {account.contests.length} 个比赛</small>
                            </button>
                            <button class="danger ghost" onClick={() => deleteAccount(account.id)} disabled={busy()}>删除</button>
                          </div>
                          <Show when={account.contests.length} fallback={<small class="muted account-empty">未绑定比赛，点击账号进入比赛页后选择比赛即可绑定。</small>}>
                            <div class="bound-contests">
                              <For each={account.contests}>{(contest) => (
                                <div class="bound-contest">
                                  <button onClick={() => chooseBoundContest(account, contest)} disabled={busy()} title="进入这个账号绑定的比赛题目">
                                    <b>{contestTitle(contest)}</b>
                                    <small>{contest.subtitle} · {contest.id}</small>
                                  </button>
                                  <button class="danger ghost mini" onClick={() => removeBoundContest(account.id, contest.id)} disabled={busy()}>移除</button>
                                </div>
                              )}</For>
                            </div>
                          </Show>
                        </article>
                      )}</For>
                    </div>
                  </Show>
                </section>
              </Show>

              <Show when={ctfStep() === "contests"}>
                <section class="split-page">
                  <aside class="panel glass picker-pane">
                    <div class="section-head"><h2>比赛选择</h2><span>第 {contestPage()} 页 / 本页 {contests().length} 项{contestTotal() ? ` / 共 ${contestTotal()} 项` : ""}</span></div>
                    <div class="pager">
                      <button onClick={() => goCtfStep("accounts")}>切换账号</button>
                      <button onClick={() => loadContests(sessionId(), contestPage() - 1)} disabled={busy() || !sessionId() || contestPage() <= 1}>上一页</button>
                      <button onClick={() => loadContests(sessionId(), contestPage() + 1)} disabled={busy() || !sessionId() || contests().length === 0}>下一页</button>
                      <button onClick={() => loadContests(sessionId(), 1)} disabled={busy() || !sessionId()}>刷新</button>
                    </div>
                    <Show when={contestCacheHint()}>
                      <div class={`cache-status ${contestBackgroundLoading() || busy() ? "loading" : ""}`}>
                        <span class="cache-spinner" />
                        <p>{contestCacheHint()}</p>
                        <span class="cache-bar" />
                      </div>
                    </Show>
                    <Show when={contests().length} fallback={<p class="muted">暂无比赛。可切换账号重新登录，或读取题库。</p>}>
                      <div class="select-list split-list">
                        <For each={contests()}>{(contest) => (
                          <button title="选择后绑定到当前账号并自动读取题目" class={`choice ${selectedContestId() === contest.id ? "selected" : ""}`} onClick={() => chooseContest(contest.id)}>
                            <b>{contest.title}</b>
                            <span>{contest.subtitle}</span>
                            <small>{contest.id}</small>
                          </button>
                        )}</For>
                      </div>
                    </Show>
                  </aside>
                  <section class="panel glass detail-pane">
                    <Show when={selectedContestId()} fallback={
                      <div class="empty-detail">
                        <p class="eyebrow">Contest</p>
                        <h2>请选择左侧比赛</h2>
                        <p class="muted">当前账号：{selectedAccount() ? accountTitle(selectedAccount()!) : "未选择"}。选中比赛后自动读取题目。</p>
                        <div class="button-row">
                          <button onClick={() => { goCtfStep("challenges"); openChallengesWithCache(sessionId(), "", { resetSelection: true }); }} disabled={busy() || !sessionId()}>读取题库 / 无比赛题目</button>
                        </div>
                      </div>
                    }>
                      <p class="eyebrow">Selected Contest</p>
                      <h2>{selectedContestOption()?.title || selectedContestId()}</h2>
                      <p class="muted">Contest ID: {selectedContestId()}</p>
                      <div class="button-row">
                        <button class="primary" onClick={() => { goCtfStep("challenges"); openChallengesWithCache(sessionId(), selectedContestId(), { resetSelection: true }); }} disabled={busy()}>查看题目</button>
                        <button onClick={scoreboard} disabled={busy() || selectedContestIsVirtual()}>查看榜单</button>
                      </div>
                      <TerminalPanel title="contest detail / last output" value={output()} level="ok" />
                    </Show>
                  </section>
                </section>
              </Show>

              <Show when={ctfStep() === "challenges"}>
                <section class="split-page">
                  <aside class="panel glass picker-pane challenge-picker">
                    <div class="section-head"><h2>题目选择</h2><span>{challengeBackgroundLoading() ? "后台同步中 / " : ""}第 {challengePage()} 页 / {filteredChallenges().length} / {challenges().length} 项{challengeTotal() ? ` / 共 ${challengeTotal()} 项` : ""}</span></div>
                    <div class="pager">
                      <button onClick={() => goCtfStep("contests")}>切换比赛</button>
                      <button onClick={() => openChallengesWithCache(sessionId(), selectedContestId(), { resetSelection: true, page: challengePage() - 1 })} disabled={busy() || challengeBackgroundLoading() || !sessionId() || challengePage() <= 1}>上一页</button>
                      <button onClick={() => openChallengesWithCache(sessionId(), selectedContestId(), { resetSelection: true, page: challengePage() + 1 })} disabled={busy() || challengeBackgroundLoading() || !sessionId() || challenges().length === 0}>下一页</button>
                      <button onClick={() => loadChallenges(sessionId(), selectedContestId(), challengePage())} disabled={busy() || !sessionId()}>刷新本页</button>
                    </div>
                    <Show when={challengeCacheHint()}>
                      <div class={`cache-status ${challengeBackgroundLoading() ? "loading" : ""}`}>
                        <span class="cache-spinner" />
                        <p>{challengeCacheHint()}</p>
                        <span class="cache-bar" />
                      </div>
                    </Show>
                    <Show when={challenges().length} fallback={<p class="muted">选择比赛后自动解析题目。</p>}>
                      <div class="challenge-filter">
                        <label class="field">
                          <span>题目类型筛选</span>
                          <select value={challengeTypeFilter()} onInput={(event) => setChallengeTypeFilter(event.currentTarget.value)}>
                            <option value="all">全部类型</option>
                            <For each={challengeTypeOptions()}>{(type) => <option value={type}>{type}</option>}</For>
                          </select>
                        </label>
                      </div>
                      <Show when={filteredChallenges().length} fallback={<p class="muted">当前类型没有题目。</p>}>
                        <div class="select-list split-list challenge-list">
                          <For each={filteredChallenges()}>{(challenge) => (
                            <button class={`choice ${selectedChallengeId() === challenge.id ? "selected" : ""}`} onClick={() => chooseChallenge(challenge.id)}>
                              <b>{challenge.title}</b>
                              <small>{challengeDirectionOf(challenge)}</small>
                            </button>
                          )}</For>
                        </div>
                      </Show>
                    </Show>
                  </aside>
                  <section class="panel glass detail-pane">
                    <Show when={selectedChallenge()} fallback={
                      <div class="empty-detail">
                        <p class="eyebrow">Challenge</p>
                        <h2>请选择左侧题目</h2>
                        <p class="muted">选中题目后右侧显示详情，并在同一面板内完成附件下载、Flag 提交和详情刷新。</p>
                      </div>
                    }>
                      <p class="eyebrow">Selected Challenge</p>
                      <h2>{selectedChallenge()?.title}</h2>
                      <p class="muted">{selectedChallenge()?.subtitle} · {selectedChallenge()?.id}</p>
                      <div class="challenge-stats">
                        <span><b>{selectedChallengeMeta().direction}</b><small>题目方向</small></span>
                        <span><b>{selectedChallengeMeta().score}</b><small>当前分数</small></span>
                        <span><b>{selectedChallengeMeta().solves}</b><small>已解出数</small></span>
                      </div>
                      <Show when={selectedChallengeMeta().hasTarget}>
                        <section class="target-card">
                          <div>
                            <h3>靶机地址</h3>
                            <p>{targetDisplayText()}</p>
                          </div>
                        </section>
                      </Show>
                      <section class="challenge-description markdown-body">
                        <h3>题目描述</h3>
                        <div innerHTML={renderMarkdown(selectedChallengeMeta().description)} />
                      </section>
                      <div class="action-grid inline-action">
                        <Field label="Flag" value={flag()} onInput={setFlag} placeholder="输入要提交的 Flag" />
                        <div class="button-grid">
                          <Show when={selectedChallengeMeta().hasAttachment}>
                            <button onClick={downloadAttachment} disabled={busy()}>下载附件</button>
                          </Show>
	                          <Show when={selectedChallengeMeta().hasTarget}>
	                            <button onClick={startTarget} disabled={busy() || !selectedChallengeId()}>开启靶机</button>
	                            <button class="danger" onClick={closeTarget} disabled={busy() || !selectedChallengeId()}>关闭靶机</button>
	                          </Show>
	                          <button class="primary" onClick={solveChallengeWithAi} disabled={busy() || !selectedChallengeId() || !authReady()}>AI 解题</button>
	                          <button class="success" onClick={submitFlag} disabled={busy()}>提交 Flag</button>
	                          <button onClick={() => chooseChallenge(selectedChallengeId())} disabled={busy()}>刷新详情</button>
                        </div>
                      </div>
                      <TerminalPanel title="challenge detail" value={selectedChallengeDetail() || selectedChallenge()?.raw} level="ok" />
                      <TerminalPanel title="题目操作结果 / last output" value={output()} level={busy() ? "warn" : "ok"} />
                    </Show>
                  </section>
                </section>
              </Show>
            </section>

            <Show when={addAccountOpen()}>
              <div class="modal-backdrop" onClick={() => setAddAccountOpen(false)}>
                <section class="modal-card glass" onClick={(event) => event.stopPropagation()}>
                  <div class="section-head">
                    <h2>添加账号</h2>
                    <button class="ghost" onClick={() => setAddAccountOpen(false)}>关闭</button>
                  </div>
                  <p class="hint">选择平台并填写用户名密码或 Token。保存后返回账号列表；保存并读取会立即进入比赛页面。</p>
                  <div class="platform-grid account-platform-grid">
                    <For each={platforms}>{(item) => (
                      <button class={`platform-card ${sessionDraft().platform === item.id ? "selected" : ""}`} onClick={() => switchPlatform(item.id)}>
                        <b>{item.title}</b>
                        <span>{item.desc}</span>
                        <small>{item.needsBaseUrl ? "需要 Base URL" : "内置入口"}</small>
                      </button>
                    )}</For>
                  </div>
                  <div class="grid two form-grid">
                    <Show when={currentPlatform().needsBaseUrl}>
                      <Field label="Base URL" value={sessionDraft().baseUrl} onInput={(baseUrl) => setSessionDraft({ ...sessionDraft(), baseUrl })} placeholder="例如 https://ctfd.example.com" />
                    </Show>
                    <Field label="用户名" value={sessionDraft().username} onInput={(username) => setSessionDraft({ ...sessionDraft(), username })} />
                    <Field label="密码" type="password" value={sessionDraft().password} onInput={(password) => setSessionDraft({ ...sessionDraft(), password })} />
                    <Field label={currentPlatform().tokenLabel} type="password" value={sessionDraft().token} onInput={(token) => setSessionDraft({ ...sessionDraft(), token })} />
                  </div>
                  <div class="button-row">
                    <button class="primary" onClick={() => saveAccount(true)} disabled={busy()}>保存并读取比赛</button>
                    <button onClick={() => saveAccount(false)} disabled={busy()}>仅保存</button>
                  </div>
                  <p class="hint">CTFd/GZCTF 显示 Base URL，其余平台使用内置默认入口。</p>
                </section>
              </div>
            </Show>
          </Show>

          <Show when={tab() === "agent"}>
            <div class="hero hero-plain">
              <div>
                <p class="eyebrow">Agent Hub</p>
                <h1>Agent 工作台</h1>
                <p>以看板方式管理任务执行和 AI API 配置。</p>
              </div>
              <div class="button-row">
                <button class={agentPage() === "workbench" ? "active" : ""} onClick={() => goAgentPage("workbench")}>工作台</button>
                <button class={agentPage() === "ai-config" ? "active" : ""} onClick={() => goAgentPage("ai-config")}>AI API 配置</button>
                <button class="primary" onClick={refreshHub} disabled={busy() || !authReady()}>刷新 Agent 状态</button>
              </div>
            </div>

            <Show when={agentPage() === "workbench"}>
              <section class="kanban-shell">
                <aside class="kanban-rail">
                  <section class="panel glass kanban-panel task-composer">
                    <div class="section-head">
                      <h2>新建任务</h2>
                      <span>Task</span>
                    </div>
                    <div class="task-composer-grid">
                      <SelectField label="模式" value={taskDraft().mode} options={["ctf_challenge", "local_lab", "code_review", "log_analysis", "report_generation"] as const} onInput={(mode) => setTaskDraft({ ...taskDraft(), mode })} />
                      <SelectField label="优先级" value={taskDraft().priority} options={["low", "medium", "high", "critical"] as const} onInput={(priority) => setTaskDraft({ ...taskDraft(), priority })} />
                      <Field label="目标" value={taskDraft().target} onInput={(target) => setTaskDraft({ ...taskDraft(), target })} placeholder="可选，例如 127.0.0.1" />
                      <Field label="标签" value={taskDraft().tags} onInput={(tags) => setTaskDraft({ ...taskDraft(), tags })} />
                    </div>
                    <label class="field"><span>Prompt / 消息</span><textarea value={taskDraft().prompt} onInput={(e) => setTaskDraft({ ...taskDraft(), prompt: e.currentTarget.value })} /></label>
                    <div class="button-row">
                      <button class="primary" onClick={createTask} disabled={busy() || !authReady()}>创建任务</button>
                    </div>
                  </section>
                  <section class="panel glass kanban-panel">
                    <div class="section-head">
                      <h2>Hub 状态</h2>
                      <span>/health</span>
                    </div>
                    <TerminalPanel title="/health" value={hubHealth() || "尚未刷新"} level={hubHealth() ? "ok" : "warn"} />
                  </section>
                </aside>

                <main class="kanban-board">
                  <div class="kanban-columns">
                    <For each={taskBoard()}>{(lane) => (
                      <section class={`kanban-column ${lane.tone}`}>
                        <div class="kanban-column-head">
                          <div>
                            <b>{lane.label}</b>
                            <small>{lane.desc}</small>
                          </div>
                          <span>{lane.items.length}</span>
                        </div>
                        <div class="kanban-cards">
                          <Show when={lane.items.length} fallback={<p class="muted kanban-empty">暂无任务</p>}>
                            <For each={lane.items}>{(task) => (
                              <article
                                class="kanban-card clickable"
                                role="button"
                                tabIndex={0}
                                onClick={() => openTaskDetail(String(task.task_id))}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    void openTaskDetail(String(task.task_id));
                                  }
                                }}
                              >
                                <div class="kanban-card-head">
                                  <b>{String(task.task_id ?? "task")}</b>
                                  <span>{String(task.priority ?? "medium")}</span>
                                </div>
                                <p>{String(task.prompt ?? "")}</p>
                                <Show when={task.result_summary}>
                                  <p class="kanban-result">{String(task.result_summary)}</p>
                                </Show>
                                <small>{String(task.mode ?? "unknown")} / {String(task.updated_at ?? task.created_at ?? "")}</small>
	                                <div class="button-row">
	                                  <button class="mini" onClick={(event) => { event.stopPropagation(); void openTaskDetail(String(task.task_id)); }} disabled={busy()}>详情</button>
	                                  <button class="mini primary" onClick={(event) => { event.stopPropagation(); void completeTask(String(task.task_id)); }} disabled={busy() || lane.key === "completed" || lane.key === "failed"}>完成</button>
	                                  <Show when={lane.key === "completed" || lane.key === "failed"}>
	                                    <button class="mini primary" onClick={(event) => openRetryTask(String(task.task_id), event)} disabled={busy() || !authReady()}>重试</button>
	                                  </Show>
	                                </div>
                              </article>
                            )}</For>
                          </Show>
                        </div>
                      </section>
                    )}</For>
                  </div>
                </main>
              </section>
            </Show>

            <Show when={agentPage() === "ai-config"}>
              <div class="grid two">
                <section class="panel glass page-panel">
                  <h2>AI API 配置</h2>
                  <p class="hint">配置 Agent Hub 使用的模型 API。API Key 保存到 Hub 运行数据目录，读取时只显示是否已配置，不回显明文。</p>
                  <SelectField label="Provider" value={aiApiDraft().provider} options={aiProviderOptions} onInput={updateAiProvider} />
                  <Field label="Base URL" value={aiApiDraft().baseUrl} onInput={(baseUrl) => updateAiApiDraft({ baseUrl })} placeholder="例如 https://api.openai.com/v1" />
                  <Field label="Model" value={aiApiDraft().model} onInput={(model) => updateAiApiDraft({ model })} placeholder="例如 gpt-4.1-mini / claude-sonnet-4-5" />
                  <SelectField label="思考深度" value={aiApiDraft().reasoningEffort} options={["default", "none", "minimal", "low", "medium", "high", "xhigh"] as const} onInput={(reasoningEffort) => updateAiApiDraft({ reasoningEffort })} />
                  <p class="hint">默认表示由模型自行决定。OpenAI 使用 Responses API + reasoning.effort；Anthropic 使用 Messages tools；DeepSeek 使用 Chat Completions tools。</p>
                  <Field label="API Key" type="password" value={aiApiDraft().apiKey} onInput={(apiKey) => updateAiApiDraft({ apiKey })} placeholder="留空表示不覆盖后端已有 Key" />
                  <Field label="Organization / 可选" value={aiApiDraft().organization} onInput={(organization) => updateAiApiDraft({ organization })} />
                  <div class="button-grid">
                    <button onClick={loadAiApiConfig} disabled={busy() || !authReady()}>从 Hub 读取</button>
                    <button class="primary" onClick={saveAiApiConfig} disabled={busy() || !authReady()}>保存到 Hub</button>
                  </div>
                  <Show when={aiApiSummary()}>
                    {(summary) => (
                      <div class="settings-status">
                        <div class="mini-status"><span class={`led ${summary().apiKeySet ? "ok" : "warn"}`} /><span>API Key：{summary().apiKeySet ? "已配置" : "未配置"}</span></div>
                        <div class="mini-status"><span class="led ok" /><span>Provider：{summary().provider}</span></div>
                        <div class="mini-status"><span class="led ok" /><span>Model：{summary().model}</span></div>
                        <div class="mini-status"><span class="led ok" /><span>思考深度：{summary().reasoningEffort}</span></div>
                        <div class="mini-status"><span class="led ok" /><span>Context：{formatTokenCount(summary().contextWindow)} / 自动压缩 {formatTokenCount(summary().contextThreshold)}</span></div>
                        <div class="mini-status"><span class="led ok" /><span>预留输出：{formatTokenCount(summary().reservedOutput)}；有效窗口：{formatTokenCount(summary().contextEffective)}</span></div>
                        <div class="mini-status"><span class="led ok" /><span>Base URL：{summary().baseUrl}</span></div>
                        <Show when={summary().organization}>
                          <div class="mini-status"><span class="led ok" /><span>Organization：{summary().organization}</span></div>
                        </Show>
                        <Show when={summary().updatedAt}>
                          <div class="mini-status"><span class="led ok" /><span>更新时间：{summary().updatedAt}</span></div>
                        </Show>
                      </div>
                    )}
                  </Show>
                  <p class="hint">当前 Hub API Base：{config().hubBase}；保存需要 Settings 里的 Admin Token。</p>
                </section>
                <section class="panel glass page-panel">
                  <h2>当前 AI 配置状态</h2>
                  <TerminalPanel title="/hub/ai-config" value={aiApiStatus() || "尚未读取或保存"} level={aiApiStatus() ? "ok" : "warn"} />
                  <TerminalPanel title="last output" value={output()} level={busy() ? "warn" : "ok"} />
                </section>
              </div>
            </Show>

            <Show when={selectedTaskDetail()}>
              {(detail) => {
	                const task = () => asRecord(detail());
	                const result = () => asRecord(task().result);
	                const activity = () => asRecord(result().current_activity);
	                const agentSteps = () => Array.isArray(result().agent_steps) ? result().agent_steps as Record<string, unknown>[] : [];
	                const compactionEvents = () => Array.isArray(result().context_compaction_events) ? result().context_compaction_events as Record<string, unknown>[] : [];
	                const history = () => Array.isArray(task().history) ? task().history as Record<string, unknown>[] : [];
	                const visibleHistory = () => history().filter((item) => String(item.action ?? "") !== "agent_step");
	                const timeline = () => {
	                  const items: Record<string, unknown>[] = [
	                    ...agentSteps().map((step, index) => ({ type: "step", ts: String(step.ts ?? ""), order: index, payload: step })),
	                    ...visibleHistory().map((item, index) => ({ type: "history", ts: String(item.ts ?? ""), order: agentSteps().length + index, payload: item }))
	                  ];
	                  return items.sort((a, b) => {
	                    const left = timestampMs(a.ts) ?? 0;
	                    const right = timestampMs(b.ts) ?? 0;
	                    return left - right || Number(a.order ?? 0) - Number(b.order ?? 0);
	                  });
	                };
                return (
	                  <div class="modal-backdrop" onClick={closeTaskDetail}>
	                    <section class="modal-card glass task-modal" onClick={(event) => event.stopPropagation()}>
                      <div class="section-head">
                        <div>
                          <p class="eyebrow">Task Detail</p>
                          <h2>任务详情</h2>
                        </div>
	                        <button class="ghost" onClick={closeTaskDetail}>关闭</button>
                      </div>

                      <div class="task-detail-head">
                        <div>
                          <small>Task ID</small>
                          <b>{String(task().task_id ?? "")}</b>
                        </div>
                        <span class={`task-status ${String(task().status ?? "unknown").toLowerCase()}`}>{String(task().status ?? "unknown")}</span>
                      </div>

                      <div class="task-meta-grid">
                        <span><b>{String(task().mode ?? "-")}</b><small>模式</small></span>
                        <span><b>{String(task().priority ?? "-")}</b><small>优先级</small></span>
                        <span><b>{String(task().updated_at ?? task().created_at ?? "-")}</b><small>更新时间</small></span>
                        <span><b>{taskElapsedText(task())}</b><small>已执行时间</small></span>
                      </div>

	                      <section class="task-detail-section">
	                        <h3>Prompt</h3>
	                        <pre class="task-text">{String(task().prompt ?? "")}</pre>
	                      </section>

	                      <Show when={activity().phase}>
	                        <section class="task-detail-section">
	                          <h3>当前执行状态</h3>
	                          <div class="task-meta-grid compact">
	                            <span><b>{String(activity().phase ?? "-")}</b><small>阶段</small></span>
	                            <span><b>{String(activity().step ?? "-")}</b><small>Step</small></span>
	                            <span><b>{String(activity().attempt ?? "-")}</b><small>请求次数</small></span>
	                            <span><b>{String(activity().ts ?? "-")}</b><small>更新时间</small></span>
	                          </div>
	                          <p class="hint">{String(activity().message ?? "")}</p>
	                          <Show when={activity().tool}>
	                            <pre class="task-text">{[
	                              `tool: ${String(activity().tool ?? "")}`,
	                              activity().target ? `target: ${String(activity().target)}` : "",
	                              activity().artifact_path ? `artifact: ${String(activity().artifact_path)}` : "",
	                              Array.isArray(activity().args) ? `args: ${(activity().args as unknown[]).map(String).join(" ")}` : "",
	                              activity().last_error ? `last_error: ${String(activity().last_error)}` : ""
	                            ].filter(Boolean).join("\n")}</pre>
	                          </Show>
	                        </section>
	                      </Show>

	                      <Show when={assistantStreamText()}>
	                        <section class="task-detail-section">
	                          <h3>AI 实时输出</h3>
	                          <pre class="task-text">{assistantStreamText()}</pre>
	                        </section>
	                      </Show>

	                      <Show when={result().text || result().error}>
                        <section class="task-detail-section">
                          <h3>{result().error ? "执行错误" : "AI 执行结果"}</h3>
                          <pre class={`task-text ${result().error ? "error" : "success"}`}>{String(result().error ?? result().text ?? "")}</pre>
                          <div class="task-meta-grid compact">
                            <span><b>{String(result().executor ?? "-")}</b><small>Executor</small></span>
                            <span><b>{String(result().provider ?? "-")}</b><small>Provider</small></span>
                            <span><b>{String(result().model ?? "-")}</b><small>Model</small></span>
                            <span><b>{String(result().completed_at ?? result().failed_at ?? "-")}</b><small>结束时间</small></span>
                          </div>
                        </section>
                      </Show>

                      <Show when={result().ai_tool_request}>
                        <section class="task-detail-section">
                          <div class="section-head">
                            <h3>AI 工具请求</h3>
                          </div>
                          <Show when={result().ai_tool_request}>
                            <pre class="task-text">{String(result().ai_tool_request ?? "")}</pre>
                          </Show>
                        </section>
                      </Show>

                      <Show when={compactionEvents().length}>
                        <section class="task-detail-section">
                          <div class="section-head">
                            <h3>上下文压缩</h3>
                            <span>{compactionEvents().length} compact</span>
                          </div>
                          <div class="task-timeline">
                            <For each={compactionEvents()}>{(event) => (
                              <article>
                                <b>{String(event.trigger ?? "auto")}</b>
                                <span>{formatTokenCount(event.pre_tokens_estimate)} → {formatTokenCount(event.post_tokens_estimate)}</span>
                                <small>{String(event.ts ?? "")} / window {formatTokenCount(event.window_tokens)} / threshold {formatTokenCount(event.threshold_tokens)}</small>
                                <p>summarized {String(event.summarized_steps ?? 0)} steps, kept {String(event.kept_steps ?? 0)} steps</p>
                              </article>
                            )}</For>
                          </div>
                        </section>
                      </Show>

                      <Show when={timeline().length}>
                        <section class="task-detail-section">
                          <div class="section-head">
                            <h3>Agent 解题步骤</h3>
                            <span>{agentSteps().length} steps / {visibleHistory().length} history</span>
                          </div>
                          <div class="tool-call-list">
                            <For each={timeline()}>{(entry) => {
                              const payload = () => asRecord(entry.payload);
                              return (
                                <Show when={entry.type === "step"} fallback={
                                  <article class="history-inline">
                                    <div class="section-head">
                                      <div>
                                        <b>History {String(payload().action ?? "-")}</b>
                                        <small>{String(payload().ts ?? "")}</small>
                                      </div>
                                      <span>{String(payload().by ?? "system")}</span>
                                    </div>
                                    <p class="hint">{String(payload().from ?? "")}{payload().to ? ` -> ${String(payload().to)}` : ""}</p>
                                    <Show when={payload().comment}><pre class="task-text">{String(payload().comment)}</pre></Show>
                                  </article>
                                }>
                                <article>
                                  <div class="section-head">
                                    <div>
                                      <b>Step {String(payload().step ?? "-")}</b>
                                      <small>{String(payload().ts ?? "")}</small>
                                    </div>
                                    {(() => {
                                      const toolCalls = payload().tool_calls;
                                      return <span>{Array.isArray(toolCalls) ? toolCalls.length : 0} tools</span>;
                                    })()}
                                  </div>
                                  {(() => {
                                    const rendered = extractStepSnippets(String(payload().thought ?? ""));
                                    const pairs = pairStepSnippets(rendered.snippets, stepToolOutputSnippets(payload()));
                                    return (
                                      <>
                                        <Show when={rendered.text}>
                                          <pre class="task-text">{rendered.text}</pre>
                                        </Show>
                                        <For each={pairs}>{(pair) => (
                                          <div class="tool-io-pair">
                                            <Show when={pair.input}>
                                              {(snippet) => (
                                                <CodeBlock snippet={snippet()} />
                                              )}
                                            </Show>
                                            <Show when={pair.output}>
                                              {(snippet) => (
                                                <CodeBlock snippet={snippet()} output />
                                              )}
                                            </Show>
                                          </div>
                                        )}</For>
                                      </>
                                    );
                                  })()}
                                  <Show when={payload().analysis}>
                                    <p class="hint">{String(payload().analysis)}</p>
                                  </Show>
                                </article>
                                </Show>
                              );
                            }}</For>
                          </div>
                        </section>
                      </Show>

                    </section>
                  </div>
                );
              }}
            </Show>
          </Show>

          <Show when={retryTaskId()}>
            <div class="modal-backdrop" onClick={closeRetryTask}>
              <section class="modal-card glass retry-modal" onClick={(event) => event.stopPropagation()}>
                <div class="section-head">
                  <div>
                    <p class="eyebrow">Retry Task</p>
                    <h2>重试并继续执行</h2>
                    <p class="muted">任务 ID：{retryTaskId()}</p>
                  </div>
                  <button class="ghost" onClick={closeRetryTask}>关闭</button>
                </div>
                <label class="field">
                  <span>补充提示词</span>
                  <textarea
                    value={retryPrompt()}
                    onInput={(event) => setRetryPrompt(event.currentTarget.value)}
                    placeholder="输入这次继续执行的要求，例如：继续分析上次没拿到 flag 的部分，优先用 r2 和 python 静态还原算法。"
                    rows={8}
                  />
                </label>
                <div class="button-row">
                  <button onClick={closeRetryTask} disabled={busy()}>取消</button>
                  <button class="primary" onClick={retryTask} disabled={busy() || !retryPrompt().trim() || !authReady()}>提交并继续跑</button>
                </div>
              </section>
            </div>
          </Show>

          <Show when={tab() === "settings"}>
            <div class="hero hero-plain">
              <div>
                <p class="eyebrow">Settings</p>
                <h1>连接与运行配置</h1>
                <p>这里集中配置 Agent Hub、CTF Match Backend 和 Admin Token，不再占用工作区页面。</p>
              </div>
              <div class="button-row">
                <button onClick={refreshHub} disabled={busy() || !authReady()}>测试 Hub</button>
                <button class="primary" onClick={refreshMatch} disabled={busy()}>测试 CTF</button>
              </div>
            </div>
            <div class="grid two">
              <section class="panel glass page-panel">
                <h2>API 连接</h2>
                <Field label="Hub API Base" value={config().hubBase} onInput={(hubBase) => updateConfig({ hubBase })} />
                <Field label="Match API Base" value={config().matchBase} onInput={(matchBase) => updateConfig({ matchBase })} />
                <Field label="Admin Token" type="password" value={config().adminToken} onInput={(adminToken) => updateConfig({ adminToken })} />
                <div class="button-grid">
                  <button onClick={refreshHub} disabled={busy() || !authReady()}>测试 Hub</button>
                  <button onClick={refreshMatch} disabled={busy()}>测试 CTF</button>
                </div>
              </section>
              <section class="panel glass page-panel">
                <h2>状态</h2>
                <div class="settings-status">
                  <div class="mini-status"><span class={authReady() ? "led ok" : "led err"} /><span>{authReady() ? "Hub Token 已配置" : "Hub Token 未配置"}</span></div>
                  <div class="mini-status"><span class={busy() ? "led warn pulse" : "led ok"} /><span>{busy() ? "请求执行中" : "空闲"}</span></div>
                  <Show when={sessionId()}>
                    <div class="session-chip"><span>CTF Session</span><b>{sessionId().slice(0, 18)}…</b></div>
                  </Show>
                </div>
                <TerminalPanel title="Hub health" value={hubHealth() || "尚未测试"} level={hubHealth() ? "ok" : "warn"} />
                <TerminalPanel title="Match health" value={matchHealth() || "尚未测试"} level={matchHealth() ? "ok" : "warn"} />
              </section>
            </div>
          </Show>

        </section>
      </section>
    </main>
  );
}
