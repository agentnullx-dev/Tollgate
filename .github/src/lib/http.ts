import { NextResponse, type NextRequest } from "next/server";
import { ZodError, type ZodType, type ZodTypeDef } from "zod";
import { Prisma } from "@prisma/client";
import { AppError, Errors, type ErrorCode } from "@/lib/errors";
import { assertScopes, authenticateRequest, enforceRateLimit, type AuthContext, type Scope } from "@/lib/auth";
import { logger } from "@/lib/logger";

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    details?: unknown;
  };
}

/** JSON response that safely serializes BigInt values as strings. */
export function json<T>(data: T, init: ResponseInit = {}): NextResponse {
  const body = JSON.stringify(data, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new NextResponse(body, { ...init, headers });
}

const DEFAULT_MAX_BODY_BYTES = 1_000_000;

export async function parseJsonBody<Output, Input = Output>(
  req: NextRequest,
  schema: ZodType<Output, ZodTypeDef, Input>,
  maxBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<Output> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) throw Errors.unsupportedMediaType();

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw Errors.payloadTooLarge(maxBytes);

  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw Errors.payloadTooLarge(maxBytes);
  if (text.trim().length === 0) throw Errors.badRequest("Request body is empty.");

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw Errors.badRequest("Request body is not valid JSON.");
  }
  return schema.parse(raw);
}

export function parseQuery<Output, Input = Output>(
  req: NextRequest,
  schema: ZodType<Output, ZodTypeDef, Input>,
): Output {
  const params: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((value, key) => {
    params[key] = value;
  });
  return schema.parse(params);
}

function formatZodError(err: ZodError) {
  return err.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
    code: issue.code,
  }));
}

function isConnectivityError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientInitializationError) return true;
  if (err instanceof Error) {
    const code = (err as Error & { code?: string }).code;
    return (
      code === "ECONNREFUSED" ||
      code === "ETIMEDOUT" ||
      err.name === "MaxRetriesPerRequestError" ||
      /Connection is closed|connect ECONNREFUSED/i.test(err.message)
    );
  }
  return false;
}

export function toErrorResponse(err: unknown, requestId: string): NextResponse {
  let appError: AppError;

  if (err instanceof AppError) {
    appError = err;
  } else if (err instanceof ZodError) {
    appError = new AppError(422, "VALIDATION_FAILED", "Request validation failed.", formatZodError(err));
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case "P2002":
        appError = Errors.conflict("A record with the same unique fields already exists.", { target: err.meta?.target });
        break;
      case "P2025":
        appError = new AppError(404, "NOT_FOUND", "The requested record was not found.");
        break;
      case "P2003":
        appError = Errors.conflict("The operation references a record that does not exist.");
        break;
      default:
        appError = new AppError(500, "INTERNAL", "An unexpected database error occurred.");
    }
  } else if (isConnectivityError(err)) {
    appError = Errors.unavailable("A backing service is temporarily unavailable. Retry with backoff.");
  } else {
    appError = new AppError(500, "INTERNAL", "An unexpected error occurred.");
  }

  if (appError.status >= 500) {
    logger.error("api.unhandled_error", { requestId, code: appError.code, err });
  }

  const body: ApiErrorBody = {
    error: {
      code: appError.code,
      message: appError.message,
      requestId,
      ...(appError.details !== undefined ? { details: appError.details } : {}),
    },
  };
  return json(body, { status: appError.status, headers: appError.headers });
}

export interface HandlerContext<P> {
  req: NextRequest;
  params: P;
  requestId: string;
  auth: AuthContext;
}

export interface PublicHandlerContext<P> {
  req: NextRequest;
  params: P;
  requestId: string;
}

type RouteSegmentContext<P> = { params: Promise<P> };

interface AuthedOptions {
  scopes: Scope[];
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

export function resolveRequestId(req: NextRequest): string {
  const incoming = req.headers.get("x-request-id");
  return incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();
}

export async function run(
  req: NextRequest,
  requestId: string,
  fn: () => Promise<Response>,
): Promise<Response> {
  const started = performance.now();
  let response: Response;
  try {
    response = await fn();
  } catch (err) {
    response = toErrorResponse(err, requestId);
  }
  response.headers.set("x-request-id", requestId);
  logger.info("api.request", {
    requestId,
    method: req.method,
    path: req.nextUrl.pathname,
    status: response.status,
    durationMs: Math.round(performance.now() - started),
  });
  return response;
}

/** Wrap an authenticated route: API key auth, scope checks, rate limits, error mapping. */
export function withApiHandler<P extends Record<string, string> = Record<string, string>>(
  options: AuthedOptions,
  handler: (ctx: HandlerContext<P>) => Promise<Response>,
) {
  return async function routeHandler(req: NextRequest, segment: RouteSegmentContext<P>): Promise<Response> {
    const requestId = resolveRequestId(req);
    return run(req, requestId, async () => {
      const params = ((await segment?.params) ?? {}) as P;
      const auth = await authenticateRequest(req);
      assertScopes(auth, options.scopes);
      await enforceRateLimit(auth);
      return handler({ req, params, requestId, auth });
    });
  };
}

/** Wrap a public route (health checks): error mapping and request ids only. */
export function withPublicHandler<P extends Record<string, string> = Record<string, string>>(
  handler: (ctx: PublicHandlerContext<P>) => Promise<Response>,
) {
  return async function routeHandler(req: NextRequest, segment: RouteSegmentContext<P>): Promise<Response> {
    const requestId = resolveRequestId(req);
    return run(req, requestId, async () => {
      const params = ((await segment?.params) ?? {}) as P;
      return handler({ req, params, requestId });
    });
  };
}
