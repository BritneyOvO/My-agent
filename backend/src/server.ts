import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { registerHealthRoutes } from "./routes/health.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerReportRoutes } from "./routes/reports.js";
import { registerToolRoutes } from "./routes/tools.js";
import { registerHubRoutes } from "./routes/hub.js";

type Method = "GET" | "POST" | "PATCH";
type Params = Record<string, string>;

export type RequestContext = {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  params: Params;
  query: Record<string, string | undefined>;
  body: unknown;
};

export class ReplyContext {
  statusCode = 200;
  headers: Record<string, string> = {};
  sent = false;
  body: unknown;

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  type(contentType: string) {
    this.headers["Content-Type"] = contentType;
    return this;
  }

  header(name: string, value: string) {
    this.headers[name] = value;
    return this;
  }

  send(body: unknown) {
    this.sent = true;
    this.body = body;
    return body;
  }
}

type Handler = (request: RequestContext, reply: ReplyContext) => unknown | Promise<unknown>;

type Route = {
  method: Method;
  path: string;
  matcher: RegExp;
  keys: string[];
  handler: Handler;
};

export class AppInstance {
  private readonly routes: Route[] = [];
  private server: Server | null = null;
  readonly log = {
    error: (error: unknown) => console.error(error)
  };

  get(path: string, handler: Handler) {
    this.addRoute("GET", path, handler);
  }

  post(path: string, handler: Handler) {
    this.addRoute("POST", path, handler);
  }

  patch(path: string, handler: Handler) {
    this.addRoute("PATCH", path, handler);
  }

  listen(options: { host: string; port: number }) {
    const server = createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        this.log.error(error);
        sendJson(response, 500, { detail: "internal server error" }, {});
      });
    });
    this.server = server;

    return new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, () => resolve());
    });
  }

  close() {
    return new Promise<void>((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        this.server = null;
        resolve();
      });
    });
  }

  private addRoute(method: Method, routePath: string, handler: Handler) {
    const { matcher, keys } = compilePath(routePath);
    this.routes.push({ method, path: routePath, matcher, keys, handler });
  }

  private async handle(incoming: IncomingMessage, outgoing: ServerResponse) {
    const requestId = incoming.headers["x-request-id"]?.toString() ?? randomUUID();
    const parsedUrl = new URL(incoming.url ?? "/", "http://localhost");
    const match = this.matchRoute((incoming.method ?? "GET").toUpperCase(), parsedUrl.pathname);
    const baseHeaders = { "X-Request-ID": requestId };

    if (!match) {
      sendJson(outgoing, 404, { detail: "not found" }, baseHeaders);
      return;
    }

    const reply = new ReplyContext();
    reply.header("X-Request-ID", requestId);

    const request: RequestContext = {
      method: incoming.method ?? "GET",
      url: incoming.url ?? "/",
      headers: { ...incoming.headers, "x-request-id": requestId },
      params: match.params,
      query: Object.fromEntries(parsedUrl.searchParams.entries()),
      body: await readBody(incoming)
    };

    try {
      const returned = await match.route.handler(request, reply);
      const body = reply.sent ? reply.body : returned;
      sendResponse(outgoing, reply.statusCode, body, reply.headers);
    } catch (error) {
      const statusCode = getStatusCode(error);
      sendJson(outgoing, statusCode, { detail: error instanceof Error ? error.message : "internal server error" }, reply.headers);
    }
  }

  private matchRoute(method: string, pathname: string) {
    for (const route of this.routes) {
      if (route.method !== method) {
        continue;
      }
      const matched = route.matcher.exec(pathname);
      if (!matched) {
        continue;
      }
      const params = Object.fromEntries(
        route.keys.map((key, index) => [key, decodeURIComponent(matched[index + 1] ?? "")])
      );
      return { route, params };
    }
    return null;
  }
}

export function buildServer() {
  const app = new AppInstance();

  registerRoutes(app);

  return app;
}

function registerRoutes(app: AppInstance) {
  registerHealthRoutes(app);
  registerTaskRoutes(app);
  registerReportRoutes(app);
  registerToolRoutes(app);
  registerHubRoutes(app);
}

function compilePath(routePath: string) {
  const keys: string[] = [];
  const pattern = routePath
    .split("/")
    .map((part) => {
      if (part.startsWith(":")) {
        keys.push(part.slice(1));
        return "([^/]+)";
      }
      return escapeRegExp(part);
    })
    .join("/");
  return { matcher: new RegExp(`^${pattern}$`), keys };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readBody(request: IncomingMessage) {
  if (request.method === "GET") {
    return undefined;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
    return undefined;
  }

  const contentType = request.headers["content-type"] ?? "";
  if (contentType.toString().includes("application/json")) {
    return JSON.parse(raw);
  }
  return raw;
}

function getStatusCode(error: unknown) {
  if (error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number") {
    return error.statusCode;
  }
  return 500;
}

function sendResponse(response: ServerResponse, statusCode: number, body: unknown, headers: Record<string, string>) {
  const contentType = headers["Content-Type"];
  if (typeof body === "string" && contentType) {
    response.writeHead(statusCode, headers);
    response.end(body);
    return;
  }
  sendJson(response, statusCode, body ?? null, headers);
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown, headers: Record<string, string>) {
  response.writeHead(statusCode, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}
