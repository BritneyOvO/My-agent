import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { registerHealthRoutes } from "./routes/health.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerReportRoutes } from "./routes/reports.js";
import { registerToolRoutes } from "./routes/tools.js";
import { registerHubRoutes } from "./routes/hub.js";

export function buildServer() {
  const app = Fastify({
    logger: true,
    disableRequestLogging: true
  });

  app.addHook("onRequest", async (request, reply) => {
    const requestId = request.headers["x-request-id"]?.toString() ?? randomUUID();
    request.headers["x-request-id"] = requestId;
    reply.header("X-Request-ID", requestId);
  });

  app.setErrorHandler((error, _request, reply) => {
    if ("statusCode" in error && typeof error.statusCode === "number") {
      return reply.status(error.statusCode).send({ detail: error.message });
    }
    requestScopedError(reply, error);
  });

  registerHealthRoutes(app);
  registerTaskRoutes(app);
  registerReportRoutes(app);
  registerToolRoutes(app);
  registerHubRoutes(app);

  return app;
}

function requestScopedError(reply: { status: (code: number) => { send: (body: unknown) => void } }, error: Error) {
  return reply.status(500).send({ detail: error.message || "internal server error" });
}
