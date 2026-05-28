import { readFileSync } from "node:fs";
import path from "node:path";
import { env } from "../lib/env.js";
import { parsePolicyYaml } from "../lib/yaml.js";

type PolicyConfig = {
  allowed_categories?: string[];
  blocked_keywords?: string[];
};

export class PolicyGate {
  private readonly config: PolicyConfig;
  private readonly blockedKeywords: string[];

  constructor() {
    const filePath = path.join(env.configDir, "agent-policy.yaml");
    this.config = parsePolicyYaml(readFileSync(filePath, "utf8")) as PolicyConfig;
    this.blockedKeywords = (this.config.blocked_keywords ?? []).map((item) => item.toLowerCase());
  }

  checkText(text: string) {
    const lowered = text.toLowerCase();
    for (const keyword of this.blockedKeywords) {
      if (lowered.includes(keyword)) {
        return { allowed: false, reason: `blocked by safety policy: ${keyword}` };
      }
    }
    return { allowed: true, reason: "allowed" };
  }

  checkMode(mode: string) {
    const allowed = new Set(this.config.allowed_categories ?? []);
    if (!allowed.has(mode)) {
      return { allowed: false, reason: `mode ${mode} is not allowed` };
    }
    return { allowed: true, reason: "allowed" };
  }
}
