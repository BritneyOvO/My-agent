import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { env } from "../lib/env.js";
import { ToolRegistry } from "./registry.js";
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
  truncated?: boolean;
  timeout_used?: number;
};

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

  async run(request: ToolRunRequest): Promise<ToolResult> {
    const meta = this.registry.get(request.tool);
    if (!meta) {
      return this.error("unknown_tool", `tool '${request.tool}' not found in registry`);
    }

    if (meta.requires_target) {
      if (!request.target) {
        return this.error("target_missing", "this tool requires a target");
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
      command.push(artifactPath);
    }

    if (request.target) {
      command.push(request.target);
    }

    command.push(...request.args);

    const timeout = Number(meta.timeout ?? 30);
    const [binary, ...args] = command;
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
          finish({
            allowed: true,
            tool: request.tool,
            exit_code: code,
	            output: extractTools.has(request.tool) && resolvedArtifactPath
	              ? `${output}${output.endsWith("\n") ? "" : "\n"}[agent-hub] extract_cwd=${cwd}\n`
	              : output,
	            truncated: false,
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
}
