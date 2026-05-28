import path from "node:path";
import { readFile } from "node:fs/promises";
import type { AppInstance } from "../server.ts";
import { env } from "../lib/env.ts";
import { requireToken } from "../core/auth.ts";
import { HttpError } from "../lib/http.ts";

export function registerReportRoutes(app: AppInstance) {
  app.get("/reports/:taskId", async (request, reply) => {
    requireToken(request);
    const { taskId } = request.params as { taskId: string };
    const filePath = path.join(env.dataDir, "tasks", `${taskId}.json`);
    try {
      const content = await readFile(filePath, "utf8");
      reply.type("application/json");
      return content;
    } catch {
      throw new HttpError(404, "task not found");
    }
  });
}
