import type { CtfStep, RouteState } from "../types";

export function parseRoute(): RouteState {
  const raw = globalThis.location?.pathname?.replace(/^\/+|\/+$/g, "") || "";
  const parts = raw.split("/").filter(Boolean);
  const [section, page] = parts;
  if (section === "agent") {
    return { tab: "agent", ctfStep: "accounts", agentPage: page === "ai-config" ? "ai-config" : "workbench" };
  }
  if (section === "settings") {
    return { tab: "settings", ctfStep: "accounts", agentPage: "workbench" };
  }
  if (section === "ctf") {
    if (page === "accounts" && parts[2]) {
      const accountId = decodeURIComponent(parts[2]);
      if (parts[3] === "contests" && parts[4]) {
        const contestId = decodeURIComponent(parts[4]);
        if (parts[5] === "challenges") {
          return { tab: "ctf", ctfStep: "challenges", agentPage: "workbench", accountId, contestId, challengeId: parts[6] ? decodeURIComponent(parts[6]) : undefined };
        }
        return { tab: "ctf", ctfStep: "contests", agentPage: "workbench", accountId, contestId };
      }
      if (parts[3] === "contests") {
        return { tab: "ctf", ctfStep: "contests", agentPage: "workbench", accountId };
      }
    }
    const ctfStep: CtfStep = page === "contests" || page === "challenges" ? page : "accounts";
    return { tab: "ctf", ctfStep, agentPage: "workbench" };
  }
  return { tab: "ctf", ctfStep: "accounts", agentPage: "workbench" };
}

export function routePath(route: RouteState) {
  if (route.tab === "agent") return `/agent/${route.agentPage}`;
  if (route.tab === "settings") return "/settings";
  if (route.tab === "ctf" && route.accountId) {
    const account = encodeURIComponent(route.accountId);
    if (route.ctfStep === "challenges" && route.contestId) {
      const contest = encodeURIComponent(route.contestId);
      return route.challengeId
        ? `/ctf/accounts/${account}/contests/${contest}/challenges/${encodeURIComponent(route.challengeId)}`
        : `/ctf/accounts/${account}/contests/${contest}/challenges`;
    }
    if (route.ctfStep === "contests") {
      return route.contestId
        ? `/ctf/accounts/${account}/contests/${encodeURIComponent(route.contestId)}`
        : `/ctf/accounts/${account}/contests`;
    }
    return `/ctf/accounts/${account}`;
  }
  return "/ctf/accounts";
}
