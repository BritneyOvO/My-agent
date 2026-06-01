export function parsePolicyYaml(text: string) {
  const result: { allowed_categories?: string[]; blocked_keywords?: string[] } = {};
  let section: keyof typeof result | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (!line.trim()) {
      continue;
    }
    if (!line.startsWith(" ") && line.includes(":")) {
      const key = line.split(":")[0]?.trim();
      section = key === "allowed_categories" || key === "blocked_keywords" ? key : null;
      if (section) {
        result[section] = [];
      }
      continue;
    }
    if (section && line.trim().startsWith("- ")) {
      result[section]?.push(String(parseScalar(line.trim().slice(2))));
    }
  }

  return result;
}

export function parseScopeYaml(text: string) {
  const result: { allowed_targets: Array<{ type?: "host" | "cidr"; value?: string; mode?: string }> } = {
    allowed_targets: []
  };
  let section: "allowed_targets" | null = null;
  let current: Record<string, unknown> | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (!line.trim()) {
      continue;
    }
    if (!line.startsWith(" ") && line.includes(":")) {
      section = line.split(":")[0]?.trim() === "allowed_targets" ? "allowed_targets" : null;
      current = null;
      continue;
    }
    if (section !== "allowed_targets") {
      continue;
    }

    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      current = {};
      result.allowed_targets.push(current);
      const inline = trimmed.slice(2);
      if (inline.includes(":")) {
        assignScalar(current, inline);
      }
      continue;
    }
    if (current && trimmed.includes(":")) {
      assignScalar(current, trimmed);
    }
  }

  return result;
}

export function parseToolRegistryYaml(text: string) {
  const result: {
    tools: Record<string, { command: string[]; risk?: string; requires_target?: boolean; timeout?: number }>;
  } = { tools: {} };
  let inTools = false;
  let currentTool: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (!line.trim()) {
      continue;
    }
    const trimmed = line.trim();
    if (!line.startsWith(" ")) {
      inTools = trimmed === "tools:";
      currentTool = null;
      continue;
    }
    if (!inTools) {
      continue;
    }
    if (line.startsWith("  ") && !line.startsWith("    ") && trimmed.endsWith(":")) {
      currentTool = trimmed.slice(0, -1);
      result.tools[currentTool] = { command: [] };
      continue;
    }
    if (currentTool && line.startsWith("    ") && trimmed.includes(":")) {
      const [rawKey, ...rawValueParts] = trimmed.split(":");
      const key = rawKey?.trim();
      const value = parseScalar(rawValueParts.join(":").trim());
      const tool = result.tools[currentTool];
      if (!tool) {
        continue;
      }
      if (key === "command") {
        tool.command = Array.isArray(value) ? value.map(String) : [String(value)];
      } else if (key === "requires_target") {
        tool.requires_target = Boolean(value);
      } else if (key === "timeout") {
        tool.timeout = Number(value);
      } else if (key === "risk") {
        tool.risk = String(value);
      }
    }
  }

  return result;
}

function assignScalar(target: Record<string, unknown>, keyValue: string) {
  const [rawKey, ...rawValueParts] = keyValue.split(":");
  const key = rawKey?.trim();
  if (!key) {
    return;
  }
  target[key] = parseScalar(rawValueParts.join(":").trim());
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (/^-?\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => parseScalar(item.trim()));
  }
  return trimmed.replace(/^["']|["']$/g, "");
}

function stripComment(line: string) {
  const hashIndex = line.indexOf("#");
  return hashIndex >= 0 ? line.slice(0, hashIndex) : line;
}
