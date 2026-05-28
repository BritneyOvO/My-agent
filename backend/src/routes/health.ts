import type { AppInstance } from "../server.js";
import { env } from "../lib/env.js";

export function registerHealthRoutes(app: AppInstance) {
  app.get("/health", async () => ({
    ok: true,
    name: "z3gh0ne",
    version: "0.3.0",
    model: env.model,
    llm_mode: env.llmMode,
    hub_role: "coordination_policy_audit_handoff",
    primary_developer_agent: "external local Claude Code agent",
    claude_api_configured: false
  }));
}
