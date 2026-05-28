export const channels = ["default", "ctf", "pentest", "handoff", "dev", "audit"] as const;

export type Channel = (typeof channels)[number];

export type HubMessageInput = {
  channel: Channel;
  message: string;
  metadata: Record<string, unknown>;
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

function readEnum<const T extends readonly string[]>(input: unknown, values: T, field: string): T[number] {
  if (typeof input !== "string" || !values.includes(input)) {
    throw new Error(`${field} must be one of: ${values.join(", ")}`);
  }
  return input;
}
