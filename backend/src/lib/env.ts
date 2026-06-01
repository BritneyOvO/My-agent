import path from "node:path";

function resolveEnvPath(value: string | undefined, fallback: string) {
  return path.resolve(value ?? fallback);
}

export const env = {
  baseDir: resolveEnvPath(process.env.Z3GH0NE_BASE_DIR, process.cwd()),
  configDir: resolveEnvPath(process.env.Z3GH0NE_CONFIG_DIR, path.resolve(process.cwd(), "..", "config")),
  dataDir: resolveEnvPath(process.env.Z3GH0NE_DATA_DIR, path.resolve(process.cwd(), ".runtime-data")),
  logDir: resolveEnvPath(process.env.Z3GH0NE_LOG_DIR, path.resolve(process.cwd(), ".runtime-logs")),
  model: process.env.Z3GH0NE_MODEL ?? "claude-opus-4-6",
  llmMode: process.env.Z3GH0NE_LLM_MODE ?? "external_local_cc",
  adminUser: process.env.Z3GH0NE_ADMIN_USER ?? "agent",
  adminPassword: process.env.Z3GH0NE_ADMIN_PASSWORD ?? "",
  adminToken: process.env.Z3GH0NE_ADMIN_TOKEN ?? "",
  localAgentUser: process.env.Z3GH0NE_LOCAL_AGENT_USER ?? "local-agent",
  localAgentToken: process.env.Z3GH0NE_LOCAL_AGENT_TOKEN ?? "",
  matchApiBase: process.env.Z3GH0NE_MATCH_API_BASE ?? `http://127.0.0.1:${process.env.CTF_PLATFORM_PORT ?? "8000"}`,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  port: Number.parseInt(process.env.PORT ?? "8080", 10),
  uploadsDir: resolveEnvPath(process.env.Z3GH0NE_UPLOADS_DIR, path.resolve(process.cwd(), ".runtime-data", "uploads")),
  workspacesDir: resolveEnvPath(process.env.Z3GH0NE_WORKSPACES_DIR, path.resolve(process.cwd(), ".runtime-data", "workspaces"))
};
