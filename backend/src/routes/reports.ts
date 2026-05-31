import { readFile } from "node:fs/promises";
import type { AppInstance } from "../server.js";
import { requireToken } from "../core/auth.js";
import { HttpError } from "../lib/http.js";
import { taskFilePath } from "../lib/task-path.js";

export function registerReportRoutes(app: AppInstance) {
  app.get("/reports/:taskId", async (request, reply) => {
    requireToken(request);
    const { taskId } = request.params as { taskId: string };
    const filePath = taskFilePath(taskId);
    try {
      const content = await readFile(filePath, "utf8");
      reply.type("application/json");
      return content;
    } catch {
      throw new HttpError(404, "task not found");
    }
  });
}
