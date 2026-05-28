import path from "node:path";

function resolveEnvPath(value: string | undefined, fallback: string) {
  return path.resolve(value ?? fallback);
}

export const env = {
  baseDir: resolveEnvPath(process.env.Z3GH0NE_BASE_DIR, process.cwd()),
  configDir: resolveEnvPath(process.env.Z3GH0NE_CONFIG_DIR, path.resolve(process.cwd(), "..", "config")),
  dataDir: resolveEnvPath(process.env.Z3GH0NE_DATA_DIR, path.resolve(process.cwd(), "..", "data")),
  logDir: resolveEnvPath(process.env.Z3GH0NE_LOG_DIR, path.resolve(process.cwd(), "..", "logs")),
  model: process.env.Z3GH0NE_MODEL ?? "claude-opus-4-6",
  llmMode: process.env.Z3GH0NE_LLM_MODE ?? "external_local_cc",
  adminUser: process.env.Z3GH0NE_ADMIN_USER ?? "agent",
  adminPassword: process.env.Z3GH0NE_ADMIN_PASSWORD ?? "",
  adminToken: process.env.Z3GH0NE_ADMIN_TOKEN ?? "",
  localAgentUser: process.env.Z3GH0NE_LOCAL_AGENT_USER ?? "local-agent",
  localAgentToken: process.env.Z3GH0NE_LOCAL_AGENT_TOKEN ?? "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  port: Number.parseInt(process.env.PORT ?? "8080", 10),
  uploadsDir: process.env.Z3GH0NE_UPLOADS_DIR ?? "/data/uploads",
  workspacesDir: process.env.Z3GH0NE_WORKSPACES_DIR ?? "/data/workspaces"
};
