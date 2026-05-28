import { appendFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "../lib/env.ts";
import { ensureDir } from "../lib/fs.ts";

const sensitiveKeys = new Set(["authorization", "token", "password", "api_key", "anthropic_api_key"]);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        sensitiveKeys.has(key.toLowerCase()) ? "<redacted>" : redact(nested)
      ])
    );
  }

  return value;
}

export async function audit(event: string, payload: Record<string, unknown>) {
  const requestId = typeof payload.request_id === "string" ? payload.request_id : randomUUID();
  const entry = {
    ts: new Date().toISOString(),
    event,
    request_id: requestId,
    payload: redact(payload)
  };
  const auditDir = path.join(env.logDir, "audit");
  await ensureDir(auditDir);
  await appendFile(path.join(auditDir, "audit.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
  return requestId;
}
