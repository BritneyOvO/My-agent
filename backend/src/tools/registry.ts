import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { env } from "../lib/env.js";

export type ToolMeta = {
  command: string[];
  risk?: string;
  requires_scope?: boolean;
  timeout?: number;
};

type ToolRegistryConfig = {
  tools?: Record<string, ToolMeta>;
};

export class ToolRegistry {
  private readonly tools: Record<string, ToolMeta>;

  constructor() {
    const filePath = path.join(env.configDir, "tool-registry.yaml");
    const raw = YAML.parse(readFileSync(filePath, "utf8")) as ToolRegistryConfig;
    this.tools = raw.tools ?? {};
  }

  list() {
    return Object.entries(this.tools).map(([name, meta]) => ({
      name,
      risk: meta.risk,
      requires_scope: meta.requires_scope ?? false,
      timeout: meta.timeout ?? 30
    }));
  }

  get(name: string) {
    return this.tools[name];
  }
}
