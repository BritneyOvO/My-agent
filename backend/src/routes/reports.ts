import path from "node:path";
import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { env } from "../lib/env.js";
import { requireToken } from "../core/auth.js";
import { HttpError } from "../lib/http.js";

export function registerReportRoutes(app: FastifyInstance) {
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
