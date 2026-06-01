export const validModes = [
  "ctf_challenge",
  "local_lab",
  "owned_asset_authorized_test",
  "code_review",
  "log_analysis",
  "report_generation",
  "safe_explanation"
] as const;

export const taskStatuses = [
  "pending",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "blocked"
] as const;

export type TaskMode = (typeof validModes)[number];
export type TaskStatus = (typeof taskStatuses)[number];

export type TaskRequest = {
  mode: TaskMode;
  prompt: string;
  target?: string;
  owner?: string;
  priority: "low" | "medium" | "high" | "critical";
  tags: string[];
  ctf_context?: CtfContext;
};

export type CtfContext = {
  auto_submit?: boolean;
  session_id: string;
  challenge_id: string;
  contest_id?: string;
};

export type TaskStatusUpdate = {
  status: TaskStatus;
  comment?: string;
};

export type TaskComment = {
  text: string;
};

export type TaskRetryRequest = {
  prompt: string;
};

export const taskRequestSchema = {
  parse(input: unknown): TaskRequest {
    const body = requireObject(input);
    const mode = readEnum(body.mode ?? "ctf_challenge", validModes, "mode");
    const prompt = readString(body.prompt, "prompt", 1, 8000);
    const target = readOptionalString(body.target, "target", 1, 4000);
    const owner = readOptionalString(body.owner, "owner", 1, 120);
    const priority = readEnum(body.priority ?? "medium", ["low", "medium", "high", "critical"] as const, "priority");
    const tags = readStringArray(body.tags ?? [], "tags", 100, 80);
    const ctfContext = readOptionalCtfContext(body.ctf_context);
    const result: TaskRequest = { mode, prompt, priority, tags };
    if (target !== undefined) {
      result.target = target;
    }
    if (owner !== undefined) {
      result.owner = owner;
    }
    if (ctfContext !== undefined) {
      result.ctf_context = ctfContext;
    }
    return result;
  }
};

export const taskStatusUpdateSchema = {
  parse(input: unknown): TaskStatusUpdate {
    const body = requireObject(input);
    const status = readEnum(body.status, taskStatuses, "status");
    const comment = readOptionalString(body.comment, "comment", 1, 4000);
    const result: TaskStatusUpdate = { status };
    if (comment !== undefined) {
      result.comment = comment;
    }
    return result;
  }
};

export const taskCommentSchema = {
  parse(input: unknown): TaskComment {
    const body = requireObject(input);
    return { text: readString(body.text, "text", 1, 4000) };
  }
};

export const taskRetrySchema = {
  parse(input: unknown): TaskRetryRequest {
    const body = requireObject(input);
    return { prompt: readString(body.prompt, "prompt", 1, 12000) };
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

function readEnum<const T extends readonly string[]>(input: unknown, values: T, field: string): T[number] {
  if (typeof input !== "string" || !values.includes(input)) {
    throw new Error(`${field} must be one of: ${values.join(", ")}`);
  }
  return input;
}

function readStringArray(input: unknown, field: string, maxItems: number, maxLength: number) {
  if (!Array.isArray(input)) {
    throw new Error(`${field} must be an array`);
  }
  if (input.length > maxItems) {
    throw new Error(`${field} cannot contain more than ${maxItems} items`);
  }
  return input.map((item) => readString(item, field, 1, maxLength));
}

function readOptionalBoolean(input: unknown, field: string) {
  if (input === undefined || input === null) {
    return undefined;
  }
  if (typeof input !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
  return input;
}

function readOptionalCtfContext(input: unknown): CtfContext | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  const body = requireObject(input);
  const sessionId = readString(body.session_id, "ctf_context.session_id", 1, 200);
  const challengeId = readString(body.challenge_id, "ctf_context.challenge_id", 1, 200);
  const contestId = readOptionalString(body.contest_id, "ctf_context.contest_id", 1, 200);
  const autoSubmit = readOptionalBoolean(body.auto_submit, "ctf_context.auto_submit");
  const result: CtfContext = {
    session_id: sessionId,
    challenge_id: challengeId
  };
  if (contestId !== undefined) {
    result.contest_id = contestId;
  }
  if (autoSubmit !== undefined) {
    result.auto_submit = autoSubmit;
  }
  return result;
}
