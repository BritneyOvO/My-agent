export const channels = ["default", "ctf", "pentest", "handoff", "dev", "audit"] as const;

export type Channel = (typeof channels)[number];
export const aiProviders = ["openai", "anthropic", "deepseek"] as const;
export const reasoningEfforts = ["default", "none", "minimal", "low", "medium", "high", "xhigh"] as const;

export type HubMessageInput = {
  channel: Channel;
  message: string;
  metadata: Record<string, unknown>;
};

export type AiApiConfigInput = {
  provider: (typeof aiProviders)[number];
  base_url: string;
  model: string;
  reasoning_effort: (typeof reasoningEfforts)[number];
  api_key?: string;
  organization?: string;
};

export const hubMessageSchema = {
  parse(input: unknown): HubMessageInput {
    const body = requireObject(input);
    const channel = readEnum(body.channel ?? "default", channels, "channel");
    const message = readString(body.message, "message", 1, 12000);
    const metadata = body.metadata === undefined ? {} : requireObject(body.metadata);
    return { channel, message, metadata };
  }
};

export const aiApiConfigSchema = {
  parse(input: unknown): AiApiConfigInput {
    const body = requireObject(input);
    const apiKey = readOptionalString(body.api_key, "api_key", 1, 8000);
    const organization = readOptionalString(body.organization, "organization", 1, 300);
    const result: AiApiConfigInput = {
      provider: readEnum(body.provider, aiProviders, "provider"),
      base_url: readString(body.base_url, "base_url", 1, 1000),
      model: readString(body.model, "model", 1, 300),
      reasoning_effort: readEnum(body.reasoning_effort ?? "default", reasoningEfforts, "reasoning_effort")
    };
    if (apiKey !== undefined) {
      result.api_key = apiKey;
    }
    if (organization !== undefined) {
      result.organization = organization;
    }
    return result;
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
  if (input === undefined || input === null || input === "") {
    return undefined;
  }
  return readString(input, field, min, max);
}

function readEnum<const T extends readonly string[]>(input: unknown, values: T, field: string): T[number] {
  if (typeof input !== "string" || !values.includes(input)) {
    throw new Error(`${field} must be one of: ${values.join(", ")}`);
  }
  return input;
}
