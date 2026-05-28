export type AgentResult = {
  summary: string;
  observations: string[];
  hypotheses: string[];
  recommended_actions: string[];
  findings: string[];
  blocked_reason: string | null;
};

export function result(summary: string, input?: Partial<AgentResult>): AgentResult {
  return {
    summary,
    observations: input?.observations ?? [],
    hypotheses: input?.hypotheses ?? [],
    recommended_actions: input?.recommended_actions ?? [],
    findings: input?.findings ?? [],
    blocked_reason: input?.blocked_reason ?? null
  };
}
