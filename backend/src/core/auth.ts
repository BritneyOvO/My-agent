import type { RequestContext } from "../server.js";
import { env } from "../lib/env.js";
import { HttpError } from "../lib/http.js";

export function requireToken(request: RequestContext) {
  if (!env.adminToken) {
    throw new HttpError(503, "admin token is not configured");
  }

  const authorization = request.headers.authorization;
  if (authorization === `Bearer ${env.adminToken}`) {
    return env.adminUser;
  }

  if (env.localAgentToken && authorization === `Bearer ${env.localAgentToken}`) {
    return env.localAgentUser;
  }

  throw new HttpError(401, "invalid token");
}
