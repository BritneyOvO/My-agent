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

  private binaryAvailable(binary: string) {
    const paths = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    return paths.some((dir) => existsSync(path.join(dir, binary)));
  }

  private commandAvailable(name: string, command: string[]) {
    const binary = command[0];
    if (!binary) return false;
    if (binary.startsWith("__builtin_")) return true;
    const dependencies = toolRuntimeDependencies[name] ?? [];
    if (dependencies.some((dependency) => !this.binaryAvailable(dependency))) return false;
    if (binary.includes("/")) {
      const resolvedBinary = path.isAbsolute(binary) ? binary : path.resolve(env.baseDir, binary);
      return existsSync(resolvedBinary);
    }
    return this.binaryAvailable(binary);
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

  private withPrompt(name: string, meta: ToolMeta & Required<Pick<ToolMeta, "requires_target" | "timeout">>) {
    return {
      ...meta,
      description: meta.description ?? toolPromptSummary(name),
      prompt: meta.prompt ?? toolPrompt(name)
    };
  }

  list() {
    return Object.entries(this.tools).map(([name, meta]) => {
      const normalized = this.withPrompt(name, this.normalize(name, meta));
      return {
        name,
        risk: normalized.risk,
        kind: normalized.kind,
        requires_target: normalized.requires_target,
        timeout: normalized.timeout,
        max_output_chars: normalized.max_output_chars,
        description: normalized.description,
        prompt: normalized.prompt,
        available: this.commandAvailable(name, normalized.command),
        binary: normalized.command[0] ?? ""
      };
    });
  }

  get(name: string) {
    const meta = this.tools[name];
    const normalized = meta ? this.normalize(name, meta) : undefined;
    return normalized ? this.withPrompt(name, normalized) : undefined;
  }
}

const toolRuntimeDependencies: Record<string, string[]> = {
  strings_grep: ["strings", "rg"],
  readelf_symbols: ["readelf", "rg"],
  jadx_decompile: ["jadx"],
  apktool_decode: ["apktool"],
  aapt_dump: ["aapt"],
  r2_native_scan: ["r2"]
};

function inferKind(name: string) {
  if (name === "web_search") return "search";
  if (["jadx_decompile", "apktool_decode", "aapt_dump", "strings_grep", "r2_native_scan"].includes(name)) return "android_reverse";
  if (["Read", "Write", "Edit", "Glob", "Grep", "LS"].includes(name)) return "filesystem";
  if (["curl", "wget", "nc", "whatweb", "nmap", "ffuf"].includes(name)) return "network";
  if (name === "python") return "code";
  if (/extract|decompress|unzip|7z|rar|tar|gzip|bzip2|xz|zip/.test(name)) return "archive";
  if (["readelf", "objdump", "r2", "nm"].includes(name)) return "binary";
  if (["gdb", "ltrace", "strace"].includes(name)) return "debug";
  if (["steghide", "stegseek", "zsteg"].includes(name)) return "steg";
  if (["identify", "convert", "montage", "tesseract", "ffmpeg", "sox", "pngcheck"].includes(name)) return "media";
  if (["openssl", "RsaCtfTool", "sage", "cado-nfs", "flatter"].includes(name)) return "crypto";
  if (["gcc", "g++", "make", "cmake"].includes(name)) return "build";
  if (["podman", "podman-compose", "buildah"].includes(name)) return "container";
  if (["git"].includes(name)) return "vcs";
  if (["jq"].includes(name)) return "data";
  if ([
    "file",
    "strings",
    "xxd",
    "hexdump",
    "exiftool",
    "binwalk",
    "tshark_summary",
    "mmls",
    "fls",
    "icat",
    "tsk_recover",
    "fsstat",
    "foremost",
    "testdisk",
    "xfs_db",
    "xfs_repair",
    "dcfldd",
    "vol"
  ].includes(name)) return "forensic";
  return "generic";
}
