export type Tab = "ctf" | "agent" | "settings";
export type CtfStep = "accounts" | "contests" | "challenges";
export type AgentPage = "workbench" | "ai-config";
export type Platform = "ctfd" | "gzctf" | "nssctf" | "adworld" | "ctfplus";

export type RouteState = {
  tab: Tab;
  ctfStep: CtfStep;
  agentPage: AgentPage;
  accountId?: string;
  contestId?: string;
  challengeId?: string;
};

export type TaskDraft = {
  mode: string;
  prompt: string;
  target: string;
  priority: string;
  tags: string;
};

export type SessionDraft = {
  platform: Platform;
  baseUrl: string;
  username: string;
  password: string;
  token: string;
};

export type BoundContest = {
  id: string;
  title: string;
  subtitle: string;
  addedAt: string;
  raw?: unknown;
};

export type CtfAccount = SessionDraft & {
  id: string;
  name: string;
  contests: BoundContest[];
  createdAt: string;
  updatedAt: string;
};

export type AiApiDraft = {
  provider: "openai" | "anthropic" | "deepseek";
  baseUrl: string;
  model: string;
  reasoningEffort: string;
  apiKey: string;
  organization: string;
};

export type OptionItem = {
  id: string;
  title: string;
  subtitle: string;
  raw: unknown;
};

export type PlatformMeta = {
  id: Platform;
  title: string;
  desc: string;
  needsBaseUrl: boolean;
  tokenLabel: string;
};

export const platforms: PlatformMeta[] = [
  { id: "ctfd", title: "CTFd", desc: "标准 CTFd 平台", needsBaseUrl: true, tokenLabel: "Token" },
  { id: "gzctf", title: "GZCTF", desc: "GZCTF 比赛平台", needsBaseUrl: true, tokenLabel: "Token" },
  { id: "nssctf", title: "NSSCTF", desc: "比赛 / 题库", needsBaseUrl: false, tokenLabel: "Token / Cookie" },
  { id: "adworld", title: "攻防世界", desc: "XCTF AdWorld", needsBaseUrl: false, tokenLabel: "Token" },
  { id: "ctfplus", title: "CTFPlus", desc: "主站 + play 节点", needsBaseUrl: false, tokenLabel: "Cookie / Token" }
];
