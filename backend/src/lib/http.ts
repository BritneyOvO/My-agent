import { ZodError, type ZodSchema } from "zod";

export class HttpError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

export function parseOrThrow<T>(schema: ZodSchema<T>, input: unknown): T {
  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new HttpError(422, error.issues.map((issue) => issue.message).join("; "));
    }
    throw error;
  }
}
