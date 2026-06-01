import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { env } from "../lib/env.js";
import type { ToolRunRequest } from "../types/tool.js";

type BuiltinResult = {
  exit_code: number;
  output: string;
  raw?: Record<string, unknown>;
};

const defaultReadLimit = 2000;
const defaultSearchLimit = 250;
const fileOperationTools = new Set(["Read", "Write", "Edit", "Glob", "Grep", "LS"]);
const fileOperationCommands: Record<string, string> = {
  __builtin_file_read: "Read",
  __builtin_file_write: "Write",
  __builtin_file_edit: "Edit",
  __builtin_glob: "Glob",
  __builtin_grep: "Grep",
  __builtin_ls: "LS"
};

export function isFileOperationTool(name: string) {
  return fileOperationTools.has(name);
}

export function fileOperationToolName(tool: string, command: string | undefined) {
  if (isFileOperationTool(tool)) return tool;
  return command ? fileOperationCommands[command] : undefined;
}

export async function runFileOperationTool(request: ToolRunRequest): Promise<BuiltinResult> {
  if (request.tool === "Read") return readTool(request);
  if (request.tool === "Write") return writeTool(request);
  if (request.tool === "Edit") return editTool(request);
  if (request.tool === "Glob") return globTool(request);
  if (request.tool === "Grep") return grepTool(request);
  if (request.tool === "LS") return lsTool(request);
  throw new Error(`unsupported file operation tool: ${request.tool}`);
}

function inputValue(request: ToolRunRequest, key: string) {
  return request.input?.[key];
}

function stringInput(request: ToolRunRequest, key: string, fallback?: string) {
  const value = inputValue(request, key);
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function numberInput(request: ToolRunRequest, key: string, fallback?: number) {
  const value = inputValue(request, key);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function booleanInput(request: ToolRunRequest, key: string, fallback = false) {
  const value = inputValue(request, key);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return /^(true|1|yes)$/i.test(value);
  return fallback;
}

function firstPath(request: ToolRunRequest) {
  return stringInput(request, "file_path", request.artifact_path ?? request.target ?? request.args[0]);
}

function resolveLocalPath(rawPath: string) {
  const expanded = rawPath === "~" || rawPath.startsWith("~/")
    ? path.join(homedir(), rawPath.slice(2))
    : rawPath;
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(env.workspacesDir, expanded);
}

function requireString(value: string | undefined, label: string) {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

async function readTool(request: ToolRunRequest): Promise<BuiltinResult> {
  const filePath = resolveLocalPath(requireString(firstPath(request), "file_path"));
  const offset = Math.max(1, numberInput(request, "offset", request.args[1] ? Number.parseInt(request.args[1], 10) : 1) ?? 1);
  const limit = Math.max(1, numberInput(request, "limit", request.args[2] ? Number.parseInt(request.args[2], 10) : defaultReadLimit) ?? defaultReadLimit);
  const stats = await stat(filePath);
  if (stats.isDirectory()) {
    throw new Error(`Read expects a file, got directory: ${filePath}. Use LS for directories.`);
  }
  const content = await readFile(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const startIndex = Math.max(0, offset - 1);
  const selected = lines.slice(startIndex, startIndex + limit);
  const numbered = selected.map((line, index) => `${String(startIndex + index + 1).padStart(6, " ")}\t${line}`).join("\n");
  const truncated = startIndex + limit < lines.length;
  const output = [
    `File: ${filePath}`,
    `Lines: ${startIndex + 1}-${startIndex + selected.length} of ${lines.length}${truncated ? " (truncated)" : ""}`,
    "",
    numbered || "[empty file]"
  ].join("\n");
  return {
    exit_code: 0,
    output,
    raw: { type: "text", filePath, startLine: startIndex + 1, numLines: selected.length, totalLines: lines.length, truncated }
  };
}

async function writeTool(request: ToolRunRequest): Promise<BuiltinResult> {
  const filePath = resolveLocalPath(requireString(firstPath(request), "file_path"));
  const content = stringInput(request, "content", request.args[1]);
  if (content === undefined) throw new Error("content is required");
  const existed = existsSync(filePath);
  const original = existed ? await readFile(filePath, "utf8") : null;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return {
    exit_code: 0,
    output: [
      `${existed ? "Updated" : "Created"} ${filePath}`,
      `Bytes: ${Buffer.byteLength(content, "utf8")}`,
      original !== null ? `Previous bytes: ${Buffer.byteLength(original, "utf8")}` : ""
    ].filter(Boolean).join("\n"),
    raw: { type: existed ? "update" : "create", filePath, bytes: Buffer.byteLength(content, "utf8"), previousBytes: original === null ? null : Buffer.byteLength(original, "utf8") }
  };
}

async function editTool(request: ToolRunRequest): Promise<BuiltinResult> {
  const filePath = resolveLocalPath(requireString(firstPath(request), "file_path"));
  const oldString = stringInput(request, "old_string", request.args[1]);
  const newString = stringInput(request, "new_string", request.args[2]);
  const replaceAll = booleanInput(request, "replace_all", /^(true|1|all)$/i.test(request.args[3] ?? ""));
  if (oldString === undefined) throw new Error("old_string is required");
  if (newString === undefined) throw new Error("new_string is required");
  if (oldString === newString) throw new Error("old_string and new_string are identical");

  const existed = existsSync(filePath);
  const original = existed ? await readFile(filePath, "utf8") : "";
  if (!existed && oldString !== "") {
    throw new Error(`File does not exist: ${filePath}`);
  }

  let updated: string;
  let replacements = 0;
  if (oldString === "") {
    updated = newString;
    replacements = 1;
  } else {
    replacements = original.split(oldString).length - 1;
    if (replacements === 0) throw new Error(`String to replace not found in file: ${oldString}`);
    if (replacements > 1 && !replaceAll) {
      throw new Error(`Found ${replacements} matches of old_string; set replace_all=true or provide a more specific old_string.`);
    }
    updated = replaceAll ? original.split(oldString).join(newString) : original.replace(oldString, newString);
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, updated, "utf8");
  return {
    exit_code: 0,
    output: [
      `${existed ? "Edited" : "Created"} ${filePath}`,
      `Replacements: ${replaceAll ? replacements : Math.min(replacements, 1)}`,
      `Bytes: ${Buffer.byteLength(original, "utf8")} -> ${Buffer.byteLength(updated, "utf8")}`
    ].join("\n"),
    raw: { filePath, replacements: replaceAll ? replacements : Math.min(replacements, 1), previousBytes: Buffer.byteLength(original, "utf8"), bytes: Buffer.byteLength(updated, "utf8") }
  };
}

async function globTool(request: ToolRunRequest): Promise<BuiltinResult> {
  const pattern = requireString(stringInput(request, "pattern", request.query ?? request.args[0]), "pattern");
  const searchPath = resolveLocalPath(stringInput(request, "path", request.target ?? request.args[1] ?? ".") ?? ".");
  const headLimit = Math.max(0, numberInput(request, "head_limit", defaultSearchLimit) ?? defaultSearchLimit);
  const args = ["--files", "--hidden", "-g", pattern, searchPath];
  const result = await runCommand("rg", args, env.workspacesDir, Number(request.input?.timeout ?? 30));
  if (result.exitCode !== 0 && !result.output.trim()) {
    return { exit_code: result.exitCode, output: `No files found for pattern: ${pattern}`, raw: { pattern, path: searchPath, numFiles: 0 } };
  }
  const files = uniqueLines(result.output).sort((a, b) => fileMtimeMs(b) - fileMtimeMs(a));
  const selected = headLimit === 0 ? files : files.slice(0, headLimit);
  const truncated = selected.length < files.length;
  return {
    exit_code: 0,
    output: selected.length
      ? [...selected, truncated ? "(Results are truncated. Use a more specific pattern or head_limit=0.)" : ""].filter(Boolean).join("\n")
      : "No files found",
    raw: { pattern, path: searchPath, numFiles: files.length, filenames: selected, truncated }
  };
}

async function grepTool(request: ToolRunRequest): Promise<BuiltinResult> {
  const pattern = requireString(stringInput(request, "pattern", request.query ?? request.args[0]), "pattern");
  const searchPath = resolveLocalPath(stringInput(request, "path", request.target ?? request.args[1] ?? ".") ?? ".");
  const outputMode = stringInput(request, "output_mode", "files_with_matches");
  const headLimit = Math.max(0, numberInput(request, "head_limit", defaultSearchLimit) ?? defaultSearchLimit);
  const offset = Math.max(0, numberInput(request, "offset", 0) ?? 0);
  const args = ["--hidden", "--max-columns", "500", "--glob", "!.git", "--glob", "!node_modules"];
  if (booleanInput(request, "multiline")) args.push("-U", "--multiline-dotall");
  if (booleanInput(request, "-i")) args.push("-i");
  if (outputMode === "files_with_matches") args.push("-l");
  else if (outputMode === "count") args.push("-c");
  else args.push("-n");
  const glob = stringInput(request, "glob");
  if (glob) args.push("--glob", glob);
  const type = stringInput(request, "type");
  if (type) args.push("--type", type);
  const context = numberInput(request, "context", numberInput(request, "-C"));
  if (context !== undefined) args.push("-C", String(context));
  const before = numberInput(request, "-B");
  if (before !== undefined) args.push("-B", String(before));
  const after = numberInput(request, "-A");
  if (after !== undefined) args.push("-A", String(after));
  args.push(pattern, searchPath);

  const result = await runCommand("rg", args, env.workspacesDir, Number(request.input?.timeout ?? 60));
  const allLines = uniqueLines(result.output);
  const selected = headLimit === 0 ? allLines.slice(offset) : allLines.slice(offset, offset + headLimit);
  const truncated = selected.length + offset < allLines.length;
  const content = selected.join("\n");
  return {
    exit_code: result.exitCode === 1 ? 0 : result.exitCode,
    output: content
      ? `${content}${truncated ? `\n\n[Showing results with pagination = limit: ${headLimit}, offset: ${offset}]` : ""}`
      : "No matches found",
    raw: { pattern, path: searchPath, mode: outputMode, numLines: selected.length, totalLines: allLines.length, truncated }
  };
}

async function lsTool(request: ToolRunRequest): Promise<BuiltinResult> {
  const dirPath = resolveLocalPath(stringInput(request, "path", request.artifact_path ?? request.target ?? request.args[0] ?? ".") ?? ".");
  const entries = await readdir(dirPath, { withFileTypes: true });
  const rows = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dirPath, entry.name);
    const itemStat = await stat(fullPath);
    const suffix = entry.isDirectory() ? "/" : "";
    return `${entry.isDirectory() ? "d" : "-"} ${String(itemStat.size).padStart(10, " ")} ${entry.name}${suffix}`;
  }));
  return {
    exit_code: 0,
    output: [`Directory: ${dirPath}`, ...rows.sort()].join("\n"),
    raw: { path: dirPath, entries: rows.length }
  };
}

function uniqueLines(text: string) {
  return Array.from(new Set(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)));
}

function fileMtimeMs(filePath: string) {
  try {
    return existsSync(filePath) ? Number(statSync(filePath).mtimeMs) : 0;
  } catch {
    return 0;
  }
}

async function runCommand(binary: string, args: string[], cwd: string, timeoutSeconds: number) {
  return new Promise<{ exitCode: number; output: string }>((resolve, reject) => {
    const child = spawn(binary, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, Math.max(1, timeoutSeconds) * 1000);
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ exitCode: 124, output: `command timed out after ${timeoutSeconds}s` });
        return;
      }
      resolve({ exitCode: code ?? 0, output });
    });
  });
}
