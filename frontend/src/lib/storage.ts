import type { ApiConfig } from "../api";
import type { AiApiDraft, CtfAccount, OptionItem } from "../types";

const defaultHubBase = import.meta.env.VITE_HUB_API_BASE || "/hub-api";
const defaultMatchBase = import.meta.env.VITE_MATCH_API_BASE || "/match-api";
const allowedAiProviders = new Set(["openai", "anthropic", "deepseek"]);

export function loadAccounts(): CtfAccount[] {
  try {
    const parsed = JSON.parse(localStorage.getItem("z3.ctfAccounts") || "[]") as CtfAccount[];
    return Array.isArray(parsed)
      ? parsed.filter((item) => item && item.id && item.platform).map((item) => ({ ...item, contests: Array.isArray(item.contests) ? item.contests : [] }))
      : [];
  } catch {
    return [];
  }
}

export function saveAccounts(accounts: CtfAccount[]) {
  localStorage.setItem("z3.ctfAccounts", JSON.stringify(accounts));
}

export function makeId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function loadConfig(): ApiConfig {
  return {
    hubBase: localStorage.getItem("z3.hubBase") || defaultHubBase,
    matchBase: localStorage.getItem("z3.matchBase") || defaultMatchBase,
    adminToken: localStorage.getItem("z3.adminToken") || ""
  };
}

export function saveConfig(config: ApiConfig) {
  localStorage.setItem("z3.hubBase", config.hubBase);
  localStorage.setItem("z3.matchBase", config.matchBase);
  localStorage.setItem("z3.adminToken", config.adminToken);
}

export function loadAiApiDraft(): AiApiDraft {
  const storedProvider = localStorage.getItem("z3.ai.provider") || "openai";
  const provider = (allowedAiProviders.has(storedProvider) ? storedProvider : "openai") as AiApiDraft["provider"];
  return {
    provider,
    baseUrl: localStorage.getItem("z3.ai.baseUrl") || "https://api.openai.com/v1",
    model: localStorage.getItem("z3.ai.model") || "gpt-4.1-mini",
    reasoningEffort: localStorage.getItem("z3.ai.reasoningEffort") || "default",
    apiKey: "",
    organization: localStorage.getItem("z3.ai.organization") || ""
  };
}

export function saveAiApiDraft(draft: AiApiDraft) {
  localStorage.setItem("z3.ai.provider", draft.provider);
  localStorage.setItem("z3.ai.baseUrl", draft.baseUrl);
  localStorage.setItem("z3.ai.model", draft.model);
  localStorage.setItem("z3.ai.reasoningEffort", draft.reasoningEffort);
  localStorage.setItem("z3.ai.organization", draft.organization);
}

export type CachedOptionList = {
  items: OptionItem[];
  total: number | null;
  updatedAt: string;
  fingerprint: string;
};

function cacheStorageKey(kind: "contests" | "challenges", scope: string, id: string) {
  return `z3.cache.${kind}.${encodeURIComponent(scope)}.${encodeURIComponent(id || "__default__")}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

export function optionListFingerprint(items: OptionItem[], total: number | null = null) {
  return stableStringify({
    total,
    items: items.map((item) => ({
      id: item.id,
      title: item.title,
      subtitle: item.subtitle,
      raw: item.raw
    }))
  });
}

function loadCachedOptionList(kind: "contests" | "challenges", scope: string, id: string): CachedOptionList | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(cacheStorageKey(kind, scope, id)) || "null") as CachedOptionList | null;
    if (!parsed || !Array.isArray(parsed.items) || typeof parsed.fingerprint !== "string") return null;
    return {
      items: parsed.items.filter((item) => item && typeof item.id === "string"),
      total: typeof parsed.total === "number" ? parsed.total : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      fingerprint: parsed.fingerprint
    };
  } catch {
    return null;
  }
}

function saveCachedOptionList(kind: "contests" | "challenges", scope: string, id: string, items: OptionItem[], total: number | null = null) {
  const entry: CachedOptionList = {
    items,
    total,
    updatedAt: new Date().toISOString(),
    fingerprint: optionListFingerprint(items, total)
  };
  try {
    localStorage.setItem(cacheStorageKey(kind, scope, id), JSON.stringify(entry));
  } catch {
    // Cache writes are best-effort; quota errors must not break platform flows.
  }
  return entry;
}

export function loadCachedContests(scope: string, page: number) {
  return loadCachedOptionList("contests", scope, String(page));
}

export function saveCachedContests(scope: string, page: number, items: OptionItem[], total: number | null) {
  return saveCachedOptionList("contests", scope, String(page), items, total);
}

function challengeCacheId(contestId: string, page: number) {
  return `${contestId || "__default__"}::page=${Math.max(1, page)}`;
}

export function loadCachedChallenges(scope: string, contestId: string, page = 1) {
  return loadCachedOptionList("challenges", scope, challengeCacheId(contestId, page));
}

export function saveCachedChallenges(scope: string, contestId: string, page: number, items: OptionItem[], total: number | null = null) {
  return saveCachedOptionList("challenges", scope, challengeCacheId(contestId, page), items, total);
}
