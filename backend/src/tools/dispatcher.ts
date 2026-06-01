import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { env } from "../lib/env.js";
import { readAiConfig } from "../lib/ai-config.js";
import { ToolRegistry } from "./registry.js";
import { fileOperationToolName, runFileOperationTool } from "./file-ops.js";
import type { ToolRunRequest } from "../types/tool.js";

const extractTools = new Set([
  "unzip",
  "7z_extract",
  "rar_extract",
  "tar_extract",
  "gzip_decompress",
  "bzip2_decompress",
  "xz_decompress"
]);

type ToolResult = {
  allowed: boolean;
  error_code?: string;
  error?: string;
  tool?: string;
  exit_code?: number | null;
  output?: string;
  raw?: Record<string, unknown>;
  truncated?: boolean;
  output_chars?: number;
  timeout_used?: number;
};

const defaultMaxOutputChars = Math.max(1000, Number.parseInt(process.env.Z3GH0NE_TOOL_MAX_OUTPUT_CHARS ?? "100000", 10));
const noisyBinaryExtensions = new Set([".apk", ".aar", ".jar", ".dex", ".so", ".elf", ".bin"]);
const noisyStringsBytes = Number.parseInt(process.env.Z3GH0NE_STRINGS_BULK_BLOCK_BYTES ?? "524288", 10);
const r2DefaultFocusedArgs = [
  "-q",
  "-A",
  "-c", "iI",
  "-c", "ii~JNI",
  "-c", "ii~Java_",
  "-c", "ii~RegisterNatives",
  "-c", "ii~JNI_OnLoad",
  "-c", "afl~JNI",
  "-c", "afl~Java_",
  "-c", "afl~flag",
  "-c", "afl~check",
  "-c", "afl~encrypt",
  "-c", "afl~decrypt",
  "-c", "afl~main",
  "-c", "izz~flag",
  "-c", "izz~ctf",
  "-c", "izz~key",
  "-c", "izz~JNI",
  "-c", "izz~eazy",
  "-c", "izz~correct",
  "-c", "izz~wrong",
  "-c", "izz~success",
  "-c", "izz~error",
  "-c", "q"
];

export class ToolDispatcher {
  private readonly registry = new ToolRegistry();

  private error(code: string, message: string): ToolResult {
    return { allowed: false, error_code: code, error: message };
  }

  private resolveArtifactPath(rawPath: string): string {
    if (path.isAbsolute(rawPath)) {
      return path.resolve(rawPath);
    }

    // 相对路径不再强制限定 uploads/workspaces。为了兼容旧上传文件名，优先找：
    // 1) 当前工作区相对路径；2) uploads 相对路径；3) workspaces 相对路径；
    // 都不存在时原样交给底层工具报错，避免调度层拦截。
    const candidates = [
      path.resolve(env.workspacesDir, rawPath),
      path.resolve(env.uploadsDir, rawPath),
      path.resolve(rawPath)
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? rawPath;
  }

  private resolveCommandBinary(binary: string): string {
    if (!binary.includes("/") || path.isAbsolute(binary)) return binary;
    return path.resolve(env.baseDir, binary);
  }

  private localPathFromRequest(request: ToolRunRequest, resolvedArtifactPath: string) {
    if (resolvedArtifactPath) return resolvedArtifactPath;
    const candidate = [...request.args].reverse().find((arg) => (
      arg.startsWith("/") || arg.startsWith(".") || noisyBinaryExtensions.has(path.extname(arg).toLowerCase())
    ));
    if (!candidate) return "";
    return this.resolveArtifactPath(candidate);
  }

  private blockNoisyToolRequest(request: ToolRunRequest, resolvedArtifactPath: string): ToolResult | null {
    if (request.tool === "strings" && process.env.Z3GH0NE_ALLOW_BULK_STRINGS !== "1") {
      const filePath = this.localPathFromRequest(request, resolvedArtifactPath);
      const ext = path.extname(filePath).toLowerCase();
      const size = safeFileSize(filePath);
      if (noisyBinaryExtensions.has(ext) || size > noisyStringsBytes) {
        return this.error(
          "bulk_strings_blocked",
          [
            "Full strings output is blocked for large binary/APK/DEX/native files.",
            "Use strings_grep with a focused regex, or jadx_decompile/apktool_decode/aapt_dump for APKs.",
            "Example: strings_grep artifact_path=<file> args=[\"flag|ctf|JNI|Java_|check|encrypt\", \"200\"]."
          ].join(" ")
        );
      }
    }

    if (request.tool === "readelf" && request.args.some((arg) => arg === "-a" || arg === "--all")) {
      return this.error(
        "bulk_readelf_blocked",
        "readelf -a is too noisy for agent loops. Use readelf_symbols for symbols, or pass targeted readelf args such as -h, -S, -d, -r, or -s."
      );
    }

    if (request.tool === "objdump" && request.args.some((arg) => arg === "-d" || arg === "--disassemble") && !request.args.some((arg) => arg.startsWith("--disassemble="))) {
      return this.error(
        "bulk_objdump_blocked",
        "Full objdump disassembly is blocked. Use r2_native_scan first, then r2 with a specific function/address or objdump --disassemble=<symbol>."
      );
    }

    if (request.tool === "r2") {
      const commands = r2CommandsFromArgs(request.args);
      const unsafeCommand = commands.find((command) => command.includes("|"));
      if (unsafeCommand) {
        return this.error(
          "r2_pipe_blocked",
          `r2 command '${unsafeCommand}' contains a raw pipe character. Use multiple focused -c commands instead, for example '-c izz~flag' and '-c izz~ctf', or escape/filter outside r2.`
        );
      }
      const noisyCommand = commands.find(isNoisyR2Command);
      if (noisyCommand) {
        return this.error(
          "bulk_r2_blocked",
          `r2 command '${noisyCommand}' is too broad for agent loops. Use r2_native_scan first, then focused commands such as 'afl~check', 'izz~flag', 'pdf @ sym.name', 'pd 80 @ 0xADDR', or 'axt @ 0xADDR'.`
        );
      }
    }

    return null;
  }

  async run(request: ToolRunRequest): Promise<ToolResult> {
    const meta = this.registry.get(request.tool);
    if (!meta) {
      return this.error("unknown_tool", `tool '${request.tool}' not found in registry`);
    }

    if (request.tool === "web_search") {
      return this.runWebSearch(request, Number(meta.timeout ?? 45), Number(meta.max_output_chars ?? defaultMaxOutputChars));
    }

    const builtinFileTool = fileOperationToolName(request.tool, meta.command[0]);
    if (builtinFileTool) {
      try {
        const result = await runFileOperationTool({ ...request, tool: builtinFileTool });
        const output = result.output;
        const truncated = truncateMiddle(output, Number(meta.max_output_chars ?? defaultMaxOutputChars));
        const response: ToolResult = {
          allowed: true,
          tool: request.tool,
          exit_code: result.exit_code,
          output: truncated.text,
          truncated: truncated.truncated,
          output_chars: output.length,
          timeout_used: Number(meta.timeout ?? 30)
        };
        if (result.raw) response.raw = result.raw;
        return response;
      } catch (error) {
        return this.error("file_op_error", error instanceof Error ? error.message.slice(0, 500) : "unknown file operation error");
      }
    }

    const command = [...meta.command];
    let cwd = env.workspacesDir;
    let resolvedArtifactPath = "";

    if (request.artifact_path) {
      const artifactPath = this.resolveArtifactPath(request.artifact_path);
      resolvedArtifactPath = artifactPath;
      if (extractTools.has(request.tool)) {
        // 解压类工具默认在压缩包所在目录执行，避免解压到全局 workspaces 后 AI 误判路径。
        cwd = path.dirname(artifactPath);
      }
      if (request.tool !== "r2") {
        command.push(artifactPath);
      }
    }

    if (request.target) {
      command.push(request.target);
    }

    if (request.tool === "r2" && resolvedArtifactPath) {
      command.push("-e", "scr.color=false", "-e", "scr.utf8=false", ...normalizeR2Args(request.args), resolvedArtifactPath);
    } else {
      command.push(...request.args);
    }

    const timeout = Number(meta.timeout ?? 30);
    const maxOutputChars = Number(meta.max_output_chars ?? defaultMaxOutputChars);
    const noisyPolicyError = this.blockNoisyToolRequest(request, resolvedArtifactPath);
    if (noisyPolicyError) return noisyPolicyError;

    const [rawBinary, ...args] = command;
    const binary = rawBinary ? this.resolveCommandBinary(rawBinary) : "";
    if (!binary) {
      return this.error("invalid_tool", "tool command is empty");
    }

    try {
      return await new Promise<ToolResult>((resolve) => {
        const child = spawn(binary, args, {
          cwd,
          stdio: ["ignore", "pipe", "pipe"]
        });
        let output = "";
        let settled = false;
        let timedOut = false;
        const append = (chunk: Buffer | string) => {
          output += chunk.toString();
        };
        child.stdout?.on("data", append);
        child.stderr?.on("data", append);
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeout * 1000);
        const finish = (result: ToolResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        child.once("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") {
            finish(this.error("tool_not_found", "binary not available in local runtime"));
            return;
          }
          finish(this.error("exec_error", error.message.slice(0, 200)));
        });
        child.once("close", (code) => {
          if (timedOut) {
            finish(this.error("timeout", `tool exceeded ${timeout}s timeout`));
            return;
          }
          const rawFinalOutput = extractTools.has(request.tool) && resolvedArtifactPath
            ? `${output}${output.endsWith("\n") ? "" : "\n"}[agent-hub] extract_cwd=${cwd}\n`
            : output;
          const finalOutput = postProcessToolOutput(request.tool, rawFinalOutput, resolvedArtifactPath);
          const truncated = truncateMiddle(finalOutput, maxOutputChars);
          finish({
            allowed: true,
            tool: request.tool,
            exit_code: code,
            output: truncated.text,
            truncated: truncated.truncated,
            output_chars: finalOutput.length,
            timeout_used: timeout
          });
        });
      });
    } catch (error) {
      if (error instanceof Error && error.name === "ETIMEDOUT") {
        return this.error("timeout", `tool exceeded ${timeout}s timeout`);
      }
      if (error instanceof Error && /ENOENT/.test(error.message)) {
        return this.error("tool_not_found", "binary not available in local runtime");
      }
      return this.error("exec_error", error instanceof Error ? error.message.slice(0, 200) : "unknown exec error");
    }
  }

  private async runWebSearch(request: ToolRunRequest, timeout: number, maxOutputChars: number): Promise<ToolResult> {
    const query = request.query?.trim() || request.target?.trim() || request.args.join(" ").trim();
    if (!query) {
      return this.error("query_missing", "web_search requires query, target, or args");
    }

    const config = await readAiConfig();
    if (config.provider !== "openai") {
      return this.error("unsupported_provider", `web_search currently supports openai/codex Responses providers only; current provider=${config.provider}`);
    }
    if (!config.api_key) {
      return this.error("api_key_missing", "AI API key is not configured");
    }

    const baseUrl = config.base_url.replace(/\/+$/, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, timeout * 1000));
    try {
      const tools: Array<Record<string, unknown>> = [{ type: "web_search" }];
      if (request.allowed_domains?.length) {
        tools[0]!.filters = { allowed_domains: request.allowed_domains };
      }
      if (request.blocked_domains?.length) {
        tools[0]!.filters = { blocked_domains: request.blocked_domains };
      }

      const response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.api_key}`,
          "Content-Type": "application/json",
          ...(config.organization ? { "OpenAI-Organization": config.organization } : {})
        },
        body: JSON.stringify({
          model: config.model,
          input: [
            "Use web search for the query below.",
            "Return a concise answer and include relevant source URLs.",
            "",
            `Query: ${query}`
          ].join("\n"),
          tools,
          tool_choice: "auto",
          max_output_tokens: 1200,
          store: false
        })
      });
      const text = await response.text();
      const data = parseJsonRecord(text);
      if (!response.ok) {
        return this.error("web_search_api_error", `Responses API ${response.status}: ${text.slice(0, 1000)}`);
      }

      const answer = extractResponseText(data);
      const searchCalls = extractSearchCalls(data);
      const sources = extractUrls(answer);
      const output = [
        `Web search query: ${query}`,
        searchCalls.length ? `Search calls: ${searchCalls.join("; ")}` : "",
        "",
        answer || "<empty answer>",
        sources.length ? `\nSources:\n${sources.map((url) => `- ${url}`).join("\n")}` : ""
      ].filter(Boolean).join("\n");
      const truncated = truncateMiddle(output, maxOutputChars);

      return {
        allowed: true,
        tool: request.tool,
        exit_code: 0,
        output: truncated.text,
        raw: compactWebSearchRaw(data),
        truncated: truncated.truncated,
        output_chars: output.length,
        timeout_used: timeout
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return this.error("timeout", `web_search exceeded ${timeout}s timeout`);
      }
      return this.error("web_search_error", error instanceof Error ? error.message.slice(0, 500) : "unknown web_search error");
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeFileSize(filePath: string) {
  try {
    return filePath && existsSync(filePath) ? statSync(filePath).size : 0;
  } catch {
    return 0;
  }
}

function normalizeR2Args(args: string[]) {
  const normalized = args.length ? [...args] : [...r2DefaultFocusedArgs];
  const hasQuiet = normalized.includes("-q");
  const hasQuitCommand = r2CommandsFromArgs(normalized).some((command) => command === "q" || command === "quit");
  return [
    ...(hasQuiet ? [] : ["-q"]),
    ...normalized,
    ...(hasQuitCommand ? [] : ["-c", "q"])
  ];
}

function r2CommandsFromArgs(args: string[]) {
  const commands: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-c" && typeof args[index + 1] === "string") {
      commands.push(...String(args[index + 1]).split(";").map((item) => item.trim()).filter(Boolean));
      index += 1;
    }
  }
  return commands;
}

function isNoisyR2Command(command: string) {
  const normalized = command.trim();
  if (!normalized || normalized === "q" || normalized === "quit") return false;
  if (/^(izz?|izzz|afl|aflj|is|isj|ii|iij)$/i.test(normalized)) return true;
  const pdCount = normalized.match(/^pd\s+(\d+)\b/i);
  if (pdCount && Number(pdCount[1]) > 100) return true;
  if (/^(pd|pD)\s*(?:$|\$\$|all\b)/i.test(normalized)) return true;
  if (/^pdr\s*$/i.test(normalized)) return true;
  return false;
}

function postProcessToolOutput(tool: string, output: string, resolvedArtifactPath: string) {
  if (tool === "unzip_list" && /\.(apk|aar|jar)$/i.test(resolvedArtifactPath)) {
    return summarizeAndroidZipListing(output);
  }
  if (tool === "unzip" && /\.(apk|aar|jar)$/i.test(resolvedArtifactPath)) {
    return summarizeAndroidZipExtraction(output, resolvedArtifactPath);
  }
  return output;
}

function summarizeAndroidZipListing(output: string) {
  const lines = output.split(/\r?\n/);
  const header = lines.filter((line) => /^Archive:|^\s*Length\s+Date|^-{5,}/.test(line)).slice(0, 4);
  const interesting = lines.filter((line) => (
    /\b(AndroidManifest\.xml|classes\d*\.dex|resources\.arsc|DebugProbesKt\.bin)\b/.test(line) ||
    /\s(lib\/[^/]+\/[^/\s]+\.so)\s*$/.test(line) ||
    /\s(assets\/[^/\s]+|assets\/[^/]+\/[^/\s]+)\s*$/.test(line) ||
    /\s(META-INF\/[^/\s]+\.(?:RSA|DSA|EC|SF|MF))\s*$/i.test(line)
  ));
  const totalEntries = lines.filter((line) => /^\s*\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+/.test(line)).length;
  const body = interesting.slice(0, 240);
  return [
    "[agent-hub] APK/JAR archive listing summarized to avoid flooding context.",
    `[agent-hub] total_entries=${totalEntries} shown_interesting=${body.length}`,
    ...header,
    ...body,
    body.length < interesting.length ? `[agent-hub] ${interesting.length - body.length} additional interesting entries omitted; use a narrower archive/resource query if needed.` : "",
    "[agent-hub] Prefer aapt_dump, jadx_decompile, apktool_decode, and r2_native_scan for APK/Reverse analysis instead of full archive listings."
  ].filter(Boolean).join("\n");
}

function summarizeAndroidZipExtraction(output: string, resolvedArtifactPath: string) {
  const lines = output.split(/\r?\n/);
  const interesting = lines.filter((line) => (
    /(?:extracting|inflating):\s+(AndroidManifest\.xml|classes\d*\.dex|resources\.arsc|DebugProbesKt\.bin)\s*$/.test(line) ||
    /(?:extracting|inflating):\s+lib\/[^/]+\/[^/\s]+\.so\s*$/.test(line) ||
    /(?:extracting|inflating):\s+assets\/[^/\s]+(?:\/[^/\s]+)?\s*$/.test(line)
  ));
  const extractedCount = lines.filter((line) => /(?:extracting|inflating):/.test(line)).length;
  return [
    "[agent-hub] APK/JAR extraction output summarized to avoid flooding context.",
    `[agent-hub] archive=${resolvedArtifactPath}`,
    `[agent-hub] extracted_entries=${extractedCount} shown_interesting=${interesting.length}`,
    ...interesting.slice(0, 160),
    interesting.length > 160 ? `[agent-hub] ${interesting.length - 160} additional interesting entries omitted.` : "",
    "[agent-hub] Continue with Glob/Grep on specific paths, readelf_symbols/r2_native_scan for lib/*.so, and strings_grep with narrow regex for classes.dex."
  ].filter(Boolean).join("\n");
}

function truncateMiddle(text: string, maxChars: number) {
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) {
    return { text, truncated: false };
  }
  const marker = "\n...[truncated output; showing head and tail. Re-run with grep/head/filter or a narrower tool query before feeding more output back.]...\n";
  const budget = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(budget * 0.65);
  const tail = Math.floor(budget * 0.35);
  return {
    text: `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ""}`,
    truncated: true
  };
}

function parseJsonRecord(text: string) {
  try {
    const parsed = text ? JSON.parse(text) as unknown : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return { raw_text: text };
  }
}

function contentToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentToText).join("");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return contentToText(record.text ?? record.content ?? record.value);
  }
  return "";
}

function extractResponseText(data: Record<string, unknown>) {
  const direct = contentToText(data.output_text);
  if (direct.trim()) return direct.trim();
  return contentToText(data.output).trim();
}

function extractSearchCalls(data: Record<string, unknown>) {
  const output = Array.isArray(data.output) ? data.output as Record<string, unknown>[] : [];
  return output
    .filter((item) => String(item.type ?? "") === "web_search_call")
    .map((item) => {
      const action = item.action && typeof item.action === "object" ? item.action as Record<string, unknown> : {};
      return String(action.query ?? (Array.isArray(action.queries) ? action.queries.join(", ") : "")).trim();
    })
    .filter(Boolean);
}

function extractUrls(text: string) {
  return Array.from(new Set(Array.from(text.matchAll(/https?:\/\/[^\s)>\]]+/g)).map((match) => match[0] ?? ""))).filter(Boolean);
}

function compactWebSearchRaw(data: Record<string, unknown>) {
  return {
    status: data.status,
    output: Array.isArray(data.output)
      ? (data.output as Record<string, unknown>[]).map((item) => ({
        type: item.type,
        status: item.status,
        action: item.action,
        content: item.content
      }))
      : undefined,
    usage: data.usage
  };
}
