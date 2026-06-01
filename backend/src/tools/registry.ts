import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { env } from "../lib/env.js";
import { parseToolRegistryYaml } from "../lib/yaml.js";

export type ToolMeta = {
  command: string[];
  risk?: string;
  requires_target?: boolean;
  timeout?: number;
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
    if (binary.includes("/")) return existsSync(binary);
    const paths = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    return paths.some((dir) => existsSync(path.join(dir, binary)));
  }

  list() {
    return Object.entries(this.tools).map(([name, meta]) => ({
      name,
      risk: meta.risk,
      requires_target: meta.requires_target ?? false,
      timeout: meta.timeout ?? 30,
      available: this.commandAvailable(meta.command),
      binary: meta.command[0] ?? ""
    }));
  }

  get(name: string) {
    return this.tools[name];
  }
}
