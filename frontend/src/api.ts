export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type ApiConfig = {
  hubBase: string;
  matchBase: string;
  adminToken: string;
};

export type RequestOptions = {
  method?: string;
  body?: unknown;
  token?: string;
};

export type ApiErrorRequest = {
  method: string;
  url: string;
};

export class ApiError extends Error {
  readonly status: number;
  readonly payload: unknown;
  readonly request: ApiErrorRequest;

  constructor(status: number, message: string, payload: unknown, request: ApiErrorRequest) {
    super(message);
    this.status = status;
    this.payload = payload;
    this.request = request;
  }
}

function parsePayload(text: string) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

function describePayload(payload: unknown, fallback: string) {
  if (typeof payload === "object" && payload && "detail" in payload) {
    const detail = (payload as { detail: unknown }).detail;
    return typeof detail === "string" ? detail : JSON.stringify(detail);
  }
  if (typeof payload === "object" && payload && "message" in payload) {
    const message = (payload as { message: unknown }).message;
    return typeof message === "string" ? message : JSON.stringify(message);
  }
  if (typeof payload === "string" && payload.trim()) return payload.trim().slice(0, 1000);
  return fallback || "Backend request failed";
}

async function request(base: string, path: string, options: RequestOptions = {}) {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const method = options.method ?? (body ? "POST" : "GET");
  const url = `${base}${path}`;
  let response: Response;
  try {
    response = await fetch(url, { method, headers, body });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ApiError(0, message || "Network request failed", { error: message }, { method, url });
  }
  const text = await response.text();
  const payload = parsePayload(text);
  if (!response.ok) {
    throw new ApiError(response.status, describePayload(payload, response.statusText), payload, { method, url });
  }
  return payload;
}

export function hubGet(config: ApiConfig, path: string) {
  return request(config.hubBase, path, { token: config.adminToken });
}

export function hubPost(config: ApiConfig, path: string, body?: unknown) {
  return request(config.hubBase, path, { method: "POST", token: config.adminToken, body });
}

export function hubPatch(config: ApiConfig, path: string, body?: unknown) {
  return request(config.hubBase, path, { method: "PATCH", token: config.adminToken, body });
}

export function matchGet(config: ApiConfig, path: string) {
  return request(config.matchBase, path);
}

export function matchPost(config: ApiConfig, path: string, body?: unknown) {
  return request(config.matchBase, path, { method: "POST", body });
}

export function matchDelete(config: ApiConfig, path: string, body?: unknown) {
  return request(config.matchBase, path, { method: "DELETE", body });
}

export function pretty(value: unknown) {
  return JSON.stringify(value, null, 2);
}
