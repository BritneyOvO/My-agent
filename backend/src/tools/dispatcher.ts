import { spawnSync } from "node:child_process";
import path from "node:path";
import { env } from "../lib/env.js";
import { PolicyGate } from "../core/policy.js";
import { ScopeValidator } from "../core/scope.js";
import { ToolRegistry } from "./registry.js";
import type { ToolRunRequest } from "../types/tool.js";

const dangerousArgPattern = /[;&|`$]|\.\.\/|\/etc\/|\/proc\/|\/sys\//;
const maxOutput = 20000;

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
  private readonly scope = new ScopeValidator();
  private readonly policy = new PolicyGate();

  private error(code: string, message: string): ToolResult {
    return { allowed: false, error_code: code, error: message };
  }

  private validateArgs(args: string[]) {
    for (const arg of args) {
      if (dangerousArgPattern.test(arg)) {
        return `argument contains forbidden characters: ${arg.slice(0, 30)}`;
      }
      if (arg.length > 500) {
        return "argument too long";
      }
    }
    return null;
  }

  run(request: ToolRunRequest): ToolResult {
    const meta = this.registry.get(request.tool);
    if (!meta) {
      return this.error("unknown_tool", `tool '${request.tool}' not found in registry`);
    }

    const policyCheck = this.policy.checkMode(request.mode);
    if (!policyCheck.allowed) {
      return this.error("policy_denied", policyCheck.reason);
    }

    if (request.target) {
      const targetPolicy = this.policy.checkText(request.target);
      if (!targetPolicy.allowed) {
        return this.error("policy_denied", targetPolicy.reason);
      }
    }

    if (meta.requires_scope) {
      if (!request.target) {
        return this.error("scope_missing", "this tool requires a target within allowed scope");
      }
      const decision = this.scope.allowed(request.target, request.mode);
      if (!decision.allowed) {
        return this.error("scope_denied", decision.reason);
      }
    }

    const argError = this.validateArgs(request.args);
    if (argError) {
      return this.error("invalid_args", argError);
    }

    const command = [...meta.command];

    if (request.artifact_path) {
      const safeName = path.basename(request.artifact_path);
      if (!safeName || safeName.startsWith(".")) {
        return this.error("invalid_artifact", "artifact path is invalid");
      }
      const artifactPath = path.posix.join(env.uploadsDir, safeName);
      if (!artifactPath.startsWith(`${env.uploadsDir.replace(/\/$/, "")}/`)) {
        return this.error("invalid_artifact", "artifact path escapes sandbox");
      }
      command.push(artifactPath);
    }

    if (request.target) {
      command.push(request.target);
    }

    command.push(...request.args.slice(0, 8));

    const timeout = Number(meta.timeout ?? 30);
    const [binary, ...args] = command;
    if (!binary) {
      return this.error("invalid_tool", "tool command is empty");
    }

    try {
      const result = spawnSync(binary, args, {
        cwd: env.workspacesDir,
        timeout: timeout * 1000,
        encoding: "utf8"
      });
      if (result.error) {
        if (result.error.name === "ETIMEDOUT") {
          return this.error("timeout", `tool exceeded ${timeout}s timeout`);
        }
        if (/ENOENT/.test(result.error.message)) {
          return this.error("tool_not_found", "binary not available in local runtime");
        }
        return this.error("exec_error", result.error.message.slice(0, 200));
      }
      const rawOutput = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      return {
        allowed: true,
        tool: request.tool,
        exit_code: result.status,
        output: rawOutput.slice(0, maxOutput),
        truncated: rawOutput.length > maxOutput,
        timeout_used: timeout
      };
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
