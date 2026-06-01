import type { AppInstance } from "../server.js";
import { requireToken } from "../core/auth.js";
import { audit } from "../core/audit.js";
import { parseOrThrow } from "../lib/http.js";
import { toolRunRequestSchema } from "../types/tool.js";
import { ToolRegistry } from "../tools/registry.js";
import { ToolDispatcher } from "../tools/dispatcher.js";
import { appendTaskToolCall } from "../agents/executor.js";

export function registerToolRoutes(app: AppInstance) {
  app.get("/tools", async (request) => {
    requireToken(request);
    return { tools: new ToolRegistry().list() };
  });

  app.post("/tools/run", async (request) => {
    const user = requireToken(request);
    const req = parseOrThrow(toolRunRequestSchema, request.body);
    const result = await new ToolDispatcher().run(req);
    await audit("tool_run", {
      user,
      tool: req.tool,
      task_id: req.task_id ?? null,
      target: req.target ?? null,
      result: Object.fromEntries(Object.entries(result).filter(([key]) => key !== "output"))
    });
    if (req.task_id) {
      await appendTaskToolCall(req.task_id, {
        by: user,
        tool: req.tool,
        target: req.target ?? null,
        args: req.args,
        ...(req.input ? { tool_input: req.input } : {}),
        result: result as Record<string, unknown>
      });
    }
    return result;
  });
}
