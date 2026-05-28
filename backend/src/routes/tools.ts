import type { FastifyInstance } from "fastify";
import { requireToken } from "../core/auth.js";
import { audit } from "../core/audit.js";
import { parseOrThrow } from "../lib/http.js";
import { toolRunRequestSchema } from "../types/tool.js";
import { ToolRegistry } from "../tools/registry.js";
import { ToolDispatcher } from "../tools/dispatcher.js";

export function registerToolRoutes(app: FastifyInstance) {
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
