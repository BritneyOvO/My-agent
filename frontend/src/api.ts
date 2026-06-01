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

export class ApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, message: string, payload: unknown) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

async function request(base: string, path: string, options: RequestOptions = {}) {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? (body ? "POST" : "GET"),
    headers,
    body
  });
  const text = await response.text();
  let payload: unknown = text;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    const detail = typeof payload === "object" && payload && "detail" in payload ? String((payload as { detail: unknown }).detail) : response.statusText;
    throw new ApiError(response.status, detail, payload);
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
