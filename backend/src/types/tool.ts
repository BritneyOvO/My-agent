export type ToolRunRequest = {
  tool: string;
  mode: string;
  target?: string;
  artifact_path?: string;
  args: string[];
};

export const toolRunRequestSchema = {
  parse(input: unknown): ToolRunRequest {
    const body = requireObject(input);
    const tool = readString(body.tool, "tool", 1, 80);
    const mode = readString(body.mode ?? "local_lab", "mode", 1, 120);
    const target = readOptionalString(body.target, "target", 1, 4000);
    const artifactPath = readOptionalString(body.artifact_path, "artifact_path", 1, 260);
    const args = readStringArray(body.args ?? [], "args", 8, 500);
    return defined({ tool, mode, target, artifact_path: artifactPath, args });
  }
};

function requireObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("request body must be an object");
  }
  return input as Record<string, unknown>;
}

function readString(input: unknown, field: string, min: number, max: number) {
  if (typeof input !== "string") {
    throw new Error(`${field} must be a string`);
  }
  if (input.length < min || input.length > max) {
    throw new Error(`${field} length must be between ${min} and ${max}`);
  }
  return input;
}

function readOptionalString(input: unknown, field: string, min: number, max: number) {
  if (input === undefined || input === null) {
    return undefined;
  }
  return readString(input, field, min, max);
}

function readStringArray(input: unknown, field: string, maxItems: number, maxLength: number) {
  if (!Array.isArray(input)) {
    throw new Error(`${field} must be an array`);
  }
  if (input.length > maxItems) {
    throw new Error(`${field} cannot contain more than ${maxItems} items`);
  }
  return input.map((item) => readString(item, field, 0, maxLength));
}

function defined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
