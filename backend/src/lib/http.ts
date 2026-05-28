export class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export type Parser<T> = {
  parse(input: unknown): T;
};

export function parseOrThrow<T>(parser: Parser<T>, input: unknown): T {
  try {
    return parser.parse(input);
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(422, error instanceof Error ? error.message : "invalid request body");
  }
}
