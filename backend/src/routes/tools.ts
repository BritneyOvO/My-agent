import type { AppInstance } from "../server.ts";
import { requireToken } from "../core/auth.ts";
import { audit } from "../core/audit.ts";
import { parseOrThrow } from "../lib/http.ts";
import { toolRunRequestSchema } from "../types/tool.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { ToolDispatcher } from "../tools/dispatcher.ts";

export function registerToolRoutes(app: AppInstance) {
  app.get("/tools", async (request) => {
    requireToken(request);
    return { tools: new ToolRegistry().list() };
  });

  app.post("/tools/run", async (request) => {
    const user = requireToken(request);
    const req = parseOrThrow(toolRunRequestSchema, request.body);
    const result = new ToolDispatcher().run(req);
    await audit("tool_run", {
      user,
      tool: req.tool,
      target: req.target ?? null,
      result: Object.fromEntries(Object.entries(result).filter(([key]) => key !== "output"))
    });
    return result;
  });
}
