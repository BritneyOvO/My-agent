import type { ApiConfig } from "../api";
import type { AiApiDraft, CtfAccount } from "../types";

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
