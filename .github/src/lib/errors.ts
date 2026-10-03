export type ErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_FAILED"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "UNKNOWN_MODEL"
  | "RATE_LIMITED"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL";

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly headers?: Record<string, string>;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    details?: unknown,
    headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

export const Errors = {
  badRequest: (message: string, details?: unknown) => new AppError(400, "BAD_REQUEST", message, details),
  unauthorized: (message = "A valid API key is required.") => new AppError(401, "UNAUTHORIZED", message),
  forbidden: (message: string, details?: unknown) => new AppError(403, "FORBIDDEN", message, details),
  notFound: (resource: string, id?: string) =>
    new AppError(404, "NOT_FOUND", id ? `${resource} '${id}' was not found.` : `${resource} was not found.`),
  conflict: (message: string, details?: unknown) => new AppError(409, "CONFLICT", message, details),
  payloadTooLarge: (limitBytes: number) =>
    new AppError(413, "PAYLOAD_TOO_LARGE", `Request body exceeds the ${limitBytes} byte limit.`),
  unsupportedMediaType: () =>
    new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Request body must be sent as application/json."),
  unknownModel: (provider: string, model: string) =>
    new AppError(
      422,
      "UNKNOWN_MODEL",
      `No pricing is configured for ${provider}/${model}. Add it to the model price table before routing traffic to it.`,
      { provider, model },
    ),
  rateLimited: (retryAfterSeconds: number) =>
    new AppError(429, "RATE_LIMITED", "Rate limit exceeded for this API key.", { retryAfterSeconds }, {
      "Retry-After": String(retryAfterSeconds),
    }),
  unavailable: (message: string) => new AppError(503, "SERVICE_UNAVAILABLE", message),
};
