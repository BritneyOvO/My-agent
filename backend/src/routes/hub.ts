import path from "node:path";
import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { AppInstance } from "../server.ts";
import { env } from "../lib/env.ts";
import { ensureDir } from "../lib/fs.ts";
import { HttpError, parseOrThrow } from "../lib/http.ts";
import { requireToken } from "../core/auth.ts";
import { audit } from "../core/audit.ts";
import { channels, hubMessageSchema } from "../types/hub.ts";

export function registerHubRoutes(app: AppInstance) {
  app.get("/hub/info", async (request) => {
    const user = requireToken(request);
    return {
      name: "z3gh0ne",
      model: env.model,
      llm_mode: env.llmMode,
      user,
      channels: [...channels],
      hub_role: "coordination_policy_audit_handoff",
      primary_developer_agent: "external local Claude Code agent"
    };
  });

  app.get("/hub/channels", async (request) => {
    requireToken(request);
    const hubDir = path.join(env.dataDir, "hub");
    const result = [];

    for (const channel of channels) {
      const filePath = path.join(hubDir, channel, "messages.jsonl");
      let count = 0;
      let lastTs: string | null = null;
      try {
        const lines = (await readFile(filePath, "utf8")).split(/\r?\n/).filter(Boolean);
        count = lines.length;
        const lastLine = lines.at(-1);
        if (lastLine) {
          lastTs = (JSON.parse(lastLine) as { ts?: string }).ts ?? null;
        }
      } catch {
        count = 0;
      }
      result.push({ channel, message_count: count, last_message_ts: lastTs });
    }

    return { channels: result };
  });

  app.post("/hub/messages", async (request) => {
    const user = requireToken(request);
    const req = parseOrThrow(hubMessageSchema, request.body);
    const message = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      from: user,
      channel: req.channel,
      message: req.message,
      metadata: req.metadata
    };
    const dirPath = path.join(env.dataDir, "hub", req.channel);
    await ensureDir(dirPath);
    appendFileSync(path.join(dirPath, "messages.jsonl"), `${JSON.stringify(message)}\n`, "utf8");
    await audit("hub_message", { user, channel: req.channel, message_id: message.id });
    return message;
  });

  app.get("/hub/messages/:channel", async (request) => {
    requireToken(request);
    const { channel } = request.params as { channel: string };
    if (!channels.includes(channel as (typeof channels)[number])) {
      throw new HttpError(400, "invalid channel");
    }

    const query = request.query as Record<string, string | undefined>;
    const limit = clampLimit(query.limit);
    const sender = query.sender;
    const msgType = query.msg_type;
    const since = query.since;
    const filePath = path.join(env.dataDir, "hub", channel, "messages.jsonl");

    let lines: string[];
    try {
      lines = (await readFile(filePath, "utf8")).split(/\r?\n/).filter(Boolean);
    } catch {
      return { channel, messages: [], total: 0 };
    }

    const messages: Array<Record<string, unknown>> = [];
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (sender && parsed.from !== sender) {
          continue;
        }
        if (msgType && (parsed.metadata as Record<string, unknown> | undefined)?.type !== msgType) {
          continue;
        }
        if (since && typeof parsed.ts === "string" && parsed.ts < since) {
          break;
        }
        messages.push(parsed);
        if (messages.length >= limit) {
          break;
        }
      } catch {
        continue;
      }
    }

    messages.reverse();
    return { channel, messages, total: messages.length };
  });
}

function clampLimit(limit: string | undefined) {
  const parsed = Number.parseInt(limit ?? "50", 10);
  if (Number.isNaN(parsed)) {
    return 50;
  }
  return Math.min(200, Math.max(1, parsed));
}
