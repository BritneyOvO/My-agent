import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { env } from "../lib/env.js";
import { parseToolRegistryYaml } from "../lib/yaml.js";
import { toolPrompt, toolPromptSummary } from "./prompts.js";

export type ToolMeta = {
  command: string[];
  risk?: string;
  requires_target?: boolean;
  timeout?: number;
  kind?: string;
  max_output_chars?: number;
  description?: string;
  prompt?: string;
};

type ToolRegistryConfig = {
  tools?: Record<string, ToolMeta>;
};

export class ToolRegistry {
  private readonly tools: Record<string, ToolMeta>;

  constructor() {
    const filePath = path.join(env.configDir, "tool-registry.yaml");
    const raw = parseToolRegistryYaml(readFileSync(filePath, "utf8")) as ToolRegistryConfig;
    this.tools = raw.tools ?? {};
  }

  private commandAvailable(command: string[]) {
    const binary = command[0];
    if (!binary) return false;
    if (binary.startsWith("__builtin_")) return true;
    if (binary.includes("/")) return existsSync(binary);
    const paths = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    return paths.some((dir) => existsSync(path.join(dir, binary)));
  }

  private normalize(name: string, meta: ToolMeta): ToolMeta & Required<Pick<ToolMeta, "requires_target" | "timeout">> {
    const kind = meta.kind ?? inferKind(name);
    return {
      ...meta,
      kind,
      requires_target: meta.requires_target ?? false,
      timeout: meta.timeout ?? 30
    };
  }

  list() {
    return Object.entries(this.tools).map(([name, meta]) => {
      const normalized = this.normalize(name, meta);
      return {
        name,
        risk: normalized.risk,
        kind: normalized.kind,
        requires_target: normalized.requires_target,
        timeout: normalized.timeout,
        max_output_chars: normalized.max_output_chars,
        description: normalized.description ?? toolPromptSummary(name),
        prompt: normalized.prompt ?? toolPrompt(name),
        available: this.commandAvailable(normalized.command),
        binary: normalized.command[0] ?? ""
      };
    });
  }

  get(name: string) {
    const meta = this.tools[name];
    const normalized = meta ? this.normalize(name, meta) : undefined;
    return normalized ? {
      ...normalized,
      description: normalized.description ?? toolPromptSummary(name),
      prompt: normalized.prompt ?? toolPrompt(name)
    } : undefined;
  }
}

function inferKind(name: string) {
  if (name === "web_search") return "search";
  if (["Read", "Write", "Edit", "Glob", "Grep", "LS", "file_read", "file_write", "file_edit", "glob", "grep", "ls"].includes(name)) return "filesystem";
  if (["curl", "whatweb", "nmap", "ffuf"].includes(name)) return "network";
  if (name === "python") return "code";
  if (/extract|decompress|unzip|7z|rar|tar|gzip|bzip2|xz/.test(name)) return "archive";
  if (["readelf", "objdump", "r2"].includes(name)) return "binary";
  if (["file", "strings", "exiftool", "binwalk", "tshark_summary"].includes(name)) return "forensic";
  return "generic";
}
