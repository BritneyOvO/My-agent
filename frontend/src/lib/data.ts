import { ApiError } from "../api";
import type { OptionItem } from "../types";

export function statusText(error: unknown) {
  if (error instanceof ApiError) return `${error.status}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstString(record: Record<string, unknown>, keys: string[], fallback = "") {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
    if (typeof value === "number") return String(value);
  }
  return fallback;
}

function arrayFromCandidate(candidate: unknown): unknown[] {
  if (Array.isArray(candidate)) return candidate;
  const record = asRecord(candidate);
  if (!Object.keys(record).length) return [];

  // GZCTF details often return: { challenges: { Web: [...], Pwn: [...] } }.
  // Flatten object-of-arrays while preserving category order.
  const grouped = Object.entries(record)
    .filter(([, value]) => Array.isArray(value))
    .flatMap(([category, value]) => (value as unknown[]).map((item) => {
      const row = asRecord(item);
      return Object.keys(row).length && !row.category ? { ...row, category } : item;
    }));
  if (grouped.length) return grouped;

  return [];
}

function nestedArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  const candidates = [
    record.items,
    record.data,
    record.result,
    record.payload,
    record.contests,
    record.competitions,
    record.games,
    record.events,
    record.rows,
    record.list,
    record.results,
    record.challenges,
    record.problems,
    record.checkpoints,
    record.questions,
    record.records,
    record.rows,
    record.list,
    record.results,
    asRecord(record.result).items,
    asRecord(record.result).challenges,
    asRecord(record.result).problems,
    asRecord(record.result).checkpoints,
    asRecord(record.result).questions,
    asRecord(record.result).records,
    asRecord(record.result).rows,
    asRecord(record.result).list,
    asRecord(record.data).items,
    asRecord(record.data).challenges,
    asRecord(record.data).problems,
    asRecord(record.data).checkpoints,
    asRecord(record.data).questions,
    asRecord(record.data).records,
    asRecord(record.data).rows,
    asRecord(record.data).list,
    asRecord(record.data).results
  ];
  for (const candidate of candidates) {
    const found = arrayFromCandidate(candidate);
    if (found.length) return found;
  }
  return arrayFromCandidate(value);
}

export function toContestOptions(payload: unknown): OptionItem[] {
  return nestedArray(payload).map((item, index) => {
    const row = asRecord(item);
    const id = firstString(row, ["contest_id", "id", "race_id", "shortName", "name"], String(index + 1));
    const title = firstString(row, ["title", "name", "shortName", "display_name"], id);
    const subtitle = firstString(row, ["play_url", "summary", "description", "status", "category"], "contest");
    return { id, title, subtitle, raw: item };
  });
}

export function listingTotal(payload: unknown) {
  const record = asRecord(payload);
  const total = record.total ?? record.count;
  return typeof total === "number" ? total : null;
}

export function firstValue(records: Record<string, unknown>[], keys: string[], fallback = "") {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value;
      if (typeof value === "number") return String(value);
      if (typeof value === "boolean") return value ? "是" : "否";
    }
  }
  return fallback;
}

export function challengeRecords(detail: unknown, raw: unknown) {
  const detailRecord = asRecord(detail);
  const rawRecord = asRecord(raw);
  const detailData = asRecord(detailRecord.data);
  const rawData = asRecord(rawRecord.data);
  return [
    detailRecord,
    detailData,
    asRecord(detailRecord.problem),
    asRecord(detailRecord.challenge),
    asRecord(detailData.problem),
    asRecord(detailData.challenge),
    asRecord(detailRecord.info),
    asRecord(detailData.info),
    rawRecord,
    rawData,
    asRecord(rawRecord.problem),
    asRecord(rawRecord.challenge),
    asRecord(rawRecord.info),
    asRecord(rawData.problem),
    asRecord(rawData.challenge),
    asRecord(rawData.info)
  ];
}

// NSSCTF 题目类型 ID 通常是 1 基；比赛会返回本场启用的 type 列表，不能把 contest_category 当成固定 0 基下标。
const NSS_TYPE_CATEGORY: Record<string, string> = {
  "1": "WEB",
  "2": "PWN",
  "3": "REVERSE",
  "4": "CRYPTO",
  "5": "MISC",
  "6": "MOBILE",
  "7": "ETH",
  "8": "IOT",
  "9": "AI",
  "10": "实战",
  "11": "靶场"
};

function isNumericLike(value: unknown) {
  return typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value.trim()));
}

function valueKey(value: unknown) {
  return typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
}

function extractCategoryMap(payload: unknown): Record<string, string> {
  const root = asRecord(payload);
  const data = asRecord(root.data);
  const categories = asRecord(root.categories ?? data.categories);
  const map: Record<string, string> = {};

  const add = (id: unknown, name: unknown) => {
    const key = valueKey(id);
    if (!key || typeof name !== "string" || !name.trim()) return;
    map[key] = name.trim();
  };

  const walk = (item: unknown) => {
    if (Array.isArray(item)) {
      for (const child of item) walk(child);
      return;
    }
    const record = asRecord(item);
    if (!Object.keys(record).length) return;

    add(record.id ?? record.type ?? record.value ?? record.key, record.name ?? record.title ?? record.label ?? record.category);
    for (const [key, value] of Object.entries(record)) {
      if (/^\d+$/.test(key) && typeof value === "string") add(key, value);
      if (Array.isArray(value) || (value && typeof value === "object")) walk(value);
    }
  };

  walk(categories);

  const types = Array.isArray(categories.type) ? categories.type : Array.isArray(categories.types) ? categories.types : [];
  const names = Array.isArray(categories.name) ? categories.name : Array.isArray(categories.names) ? categories.names : Array.isArray(categories.label) ? categories.label : [];
  types.forEach((type, index) => {
    const explicitName = names[index];
    add(type, explicitName ?? NSS_TYPE_CATEGORY[valueKey(type)] ?? (typeof type === "string" && !isNumericLike(type) ? type : undefined));
  });

  return map;
}

export function normalizeChallengeDirection(records: Record<string, unknown>[], fallback = "未知") {
  for (const record of records) {
    for (const key of ["category", "direction", "classify", "tag"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim() && !isNumericLike(value)) return value.trim();
    }
  }

  for (const record of records) {
    const categoryMap = asRecord(record._categoryMap);
    const value = record.contest_category ?? record.contest_category_id ?? record.category_id;
    if (typeof value === "string" && value.trim() && !isNumericLike(value)) return value.trim();
    if (isNumericLike(value)) {
      const key = valueKey(value);
      return String(categoryMap[key] || NSS_TYPE_CATEGORY[key] || `分类 ${key}`);
    }
  }

  for (const record of records) {
    const type = record.type;
    if (typeof type === "string" && type.trim() && !isNumericLike(type)) return type.trim();
    if (isNumericLike(type)) {
      const key = valueKey(type);
      return NSS_TYPE_CATEGORY[key] || `分类 ${key}`;
    }
  }

  return fallback;
}

function meaningful(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    return Boolean(text) && !["0", "false", "null", "none", "no", "否", "无"].includes(text);
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return Boolean(value);
}

function recordsHaveKey(records: Record<string, unknown>[], match: (key: string) => boolean) {
  const seen = new Set<unknown>();
  const walk = (value: unknown): boolean => {
    if (!value || seen.has(value)) return false;
    if (Array.isArray(value)) {
      seen.add(value);
      return value.some(walk);
    }
    if (typeof value !== "object") return false;
    seen.add(value);
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (match(key) && meaningful(child)) return true;
      if (child && typeof child === "object" && walk(child)) return true;
    }
    return false;
  };
  return records.some(walk);
}

export function hasChallengeAttachment(records: Record<string, unknown>[]) {
  if (recordsHaveKey(records, (key) => /^(files?|attachments?|annex(es)?|download(_?url)?|file_?url|file_?name|attachment_?path|annex_?path|has_?(annex|attachment|file)|is_?(annex|attachment|file))$/i.test(key))) return true;

  // GZCTF static attachment detail shape:
  // { type: "StaticAttachment", context: { url: "https://.../file.zip", fileSize: ... } }
  const seen = new Set<unknown>();
  const looksLikeAttachmentUrl = (text: unknown) => typeof text === "string" && /\.(zip|7z|rar|tar|gz|xz|bz2|txt|pdf|png|jpg|jpeg|gif|pcap|pcapng|bin|elf|exe|apk|jar|py|c|cpp|go|rs)(?:[?#].*)?$/i.test(text.trim());
  const walk = (value: unknown, parent: Record<string, unknown> | null = null): boolean => {
    if (!value || seen.has(value)) return false;
    if (Array.isArray(value)) {
      seen.add(value);
      return value.some((item) => walk(item, parent));
    }
    if (typeof value !== "object") return false;
    seen.add(value);
    const record = value as Record<string, unknown>;
    const type = String(record.type ?? parent?.type ?? "").toLowerCase();
    const context = asRecord(record.context);
    if (type.includes("attachment") && typeof context.url === "string" && context.url.trim()) return true;
    if (looksLikeAttachmentUrl(context.url)) return true;
    if (record.url && (type.includes("attachment") || looksLikeAttachmentUrl(record.url))) return true;
    for (const child of Object.values(record)) {
      if (child && typeof child === "object" && walk(child, record)) return true;
    }
    return false;
  };
  return records.some((record) => walk(record));
}

export function hasChallengeTarget(records: Record<string, unknown>[]) {
  if (records.some((record) => /container|dynamic/i.test(String(record.type ?? "")))) return true;
  return recordsHaveKey(records, (key) => /^(docker|container|instance|instance_?entry|instanceEntry|entry|target|target_?url|remote|service|scene|cscene|scene_?(data|instance|config|config_?id)|with_?scene(_?inst)?|is_?scene_?inst_?running|dynamic|is_?dynamic|has_?(docker|target|container|scene)|is_?(docker|target|container)|need_?(docker|target|scene))$/i.test(key));
}

export function platformSupportsTargetApi(platform: unknown) {
  const value = String(platform || "").toLowerCase();
  return ["nssctf", "nss", "adworld", "xctf", "gzctf", "gz"].includes(value);
}

export function toChallengeOptions(payload: unknown): OptionItem[] {
  const categoryMap = extractCategoryMap(payload);
  return nestedArray(payload).map((item, index) => {
    const row = asRecord(item);
    const id = firstString(row, ["challenge_id", "checkpoint_id", "resource_id", "problem_id", "pid", "id", "uuid", "key", "name", "title"], String(index + 1));
    const title = firstString(row, ["title", "name", "display_name", "checkpoint_name", "resource_name", "problem_name"], id);
    const raw = Object.keys(categoryMap).length && row === item ? { ...row, _categoryMap: categoryMap } : item;
    const records = challengeRecords(null, raw);
    const category = normalizeChallengeDirection(records, firstString(row, ["category", "category_name", "direction", "type_name", "type", "tag"], "challenge"));
    const score = firstString(row, ["score", "points", "point", "value", "current_score", "currentScore", "score_value"], "");
    const subtitle = score ? `${category} / ${score} pts` : category;
    return { id, title, subtitle, raw };
  });
}

export function extractTargetAddress(value: unknown): string {
  const seen = new Set<unknown>();
  const keys = ["entry", "instanceEntry", "connection_url", "address", "addr", "target", "target_url", "targetUrl", "link", "host", "container", "service", "remote", "endpoint", "addresses", "access", "accesses", "public_url", "publicUrl", "url"];
  const looksLikeFileUrl = (text: string) => /\.(zip|7z|rar|tar|gz|xz|bz2|txt|pdf|png|jpg|jpeg|gif|pcap|pcapng|bin|elf|exe|apk|jar|py|c|cpp|go|rs)(?:[?#].*)?$/i.test(text);
  const normalizeTextAddress = (value: string) => {
    const text = value.trim();
    if (!text || looksLikeFileUrl(text)) return "";
    const remote = text.match(/^remote\(["']([^"']+)["']\s*,\s*(\d+)(.*?)\)$/);
    if (remote) {
      const [, host, port, options] = remote;
      const ssl = options.replace(/\s/g, "").includes("ssl=True") ? " --ssl" : "";
      return `ncat${ssl} ${host} ${port}`;
    }
    if (/^(https?:\/\/|[a-zA-Z0-9_.-]+:\d+|nc\s+|ncat\s+|ssh\s+|socat\s+)/i.test(text)) return text;
    return "";
  };
  const walk = (item: unknown): string => {
    if (!item || seen.has(item)) return "";
    if (typeof item === "string") {
      return normalizeTextAddress(item);
    }
    if (Array.isArray(item)) {
      seen.add(item);
      for (const child of item) {
        const found = walk(child);
        if (found) return found;
      }
      return "";
    }
    if (typeof item === "object") {
      seen.add(item);
      const record = item as Record<string, unknown>;
      const protoValue = record.protocol || record.scheme;
      const proto = typeof protoValue === "string" ? protoValue.toLowerCase() : protoValue;
      const host = record.access_ip || record.public_ip || record.outer_ip || record.ip || record.host || record.hostname || record.domain || record.address;
      const port = record.access_port || record.public_port || record.outer_port || record.port || record.expose_port || record.exposed_port;
      const path = typeof record.path === "string" ? record.path : "";
      if (host && port) {
        if (proto === "http" || proto === "https") return `${proto}://${host}:${port}${path}`;
        return `${host}:${port}`;
      }
      for (const key of keys) {
        const found = walk(record[key]);
        if (found) return found;
      }
      for (const child of Object.values(record)) {
        const found = walk(child);
        if (found) return found;
      }
    }
    return "";
  };
  return walk(value);
}

export function targetLooksOpened(value: unknown): boolean {
  const seen = new Set<unknown>();
  const successLike = (item: unknown) => {
    const record = asRecord(item);
    const code = record.code ?? record.status_code ?? record.statusCode;
    if (typeof code === "number") return code >= 200 && code < 300;
    if (typeof code === "string") return code === "200" || code.endsWith("000000");
    const ok = record.ok ?? record.success;
    return ok === true;
  };
  const walk = (item: unknown): boolean => {
    if (!item || seen.has(item)) return false;
    if (Array.isArray(item)) {
      seen.add(item);
      return item.some(walk);
    }
    if (typeof item !== "object") return false;
    seen.add(item);
    const record = item as Record<string, unknown>;
    if (record.closed === true) return false;
    if (record.opened === true || record.pending === true || record.is_open === true || record.isOpen === true) return true;
    if (successLike(record.start_result) || successLike(record.open_result)) return true;
    if (record.kind && (meaningful(record.scene_data) || meaningful(record.addresses)) && record.closed !== true) return true;
    for (const [key, child] of Object.entries(record)) {
      if (/^(already_?running|closed|is_?open|isOpen|is_?scene_?inst_?running|with_?scene_?inst)$/i.test(key)) {
        if (key.toLowerCase() === "closed") return child === false;
        if (child === true || (typeof child === "number" && child > 0) || (typeof child === "string" && /^(true|1|running|opened|open)$/i.test(child.trim()))) return true;
      }
      if (/^(scene_?status|status)$/i.test(key)) {
        if (child === 1 || (typeof child === "string" && /^(1|running|opened|open)$/i.test(child.trim()))) return true;
      }
      if (child && typeof child === "object" && walk(child)) return true;
    }
    return false;
  };
  return walk(value);
}
