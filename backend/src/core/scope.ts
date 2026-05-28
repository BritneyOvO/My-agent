import { readFileSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import YAML from "yaml";
import { env } from "../lib/env.js";

type AllowedTarget = {
  type?: "host" | "cidr";
  value?: string;
  mode?: string;
};

type ScopeConfig = {
  allowed_targets?: AllowedTarget[];
};

export class ScopeValidator {
  private readonly config: ScopeConfig;

  constructor() {
    const filePath = path.join(env.configDir, "allowed-scopes.yaml");
    this.config = YAML.parse(readFileSync(filePath, "utf8")) as ScopeConfig;
  }

  normalizeHost(target: string) {
    try {
      const withProtocol = target.includes("://") ? target : `http://${target}`;
      const url = new URL(withProtocol);
      return url.hostname;
    } catch {
      return target.split("/")[0]?.split(":")[0] ?? "";
    }
  }

  allowed(target: string, mode: string) {
    const host = this.normalizeHost(target);
    if (!host) {
      return { allowed: false, reason: "empty target" };
    }

    for (const entry of this.config.allowed_targets ?? []) {
      if (!entry.value || !entry.type) {
        continue;
      }
      if (entry.mode && entry.mode !== mode && entry.mode !== "any") {
        continue;
      }
      if (entry.type === "host" && host === entry.value) {
        return { allowed: true, reason: "host matched scope" };
      }
      if (entry.type === "cidr" && ipInCidr(host, entry.value)) {
        return { allowed: true, reason: "cidr matched scope" };
      }
    }

    return { allowed: false, reason: `target ${host} is outside allowed scope` };
  }
}

function ipInCidr(host: string, cidr: string) {
  if (net.isIP(host) !== 4) {
    return false;
  }

  const [range, bitsText] = cidr.split("/");
  const bits = Number.parseInt(bitsText ?? "32", 10);
  if (!range || Number.isNaN(bits) || bits < 0 || bits > 32 || net.isIP(range) !== 4) {
    return false;
  }

  const hostValue = ipv4ToInt(host);
  const rangeValue = ipv4ToInt(range);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (hostValue & mask) === (rangeValue & mask);
}

function ipv4ToInt(ip: string) {
  return ip.split(".").reduce((result, part) => ((result << 8) + Number.parseInt(part, 10)) >>> 0, 0);
}
