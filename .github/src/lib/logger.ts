type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const raw = (process.env.LOG_LEVEL ?? "info") as Level;
  return LEVEL_ORDER[raw] ?? LEVEL_ORDER.info;
}

function serializeError(err: unknown): Record<string, unknown> | undefined {
  if (!err) return undefined;
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { value: String(err) };
}

function write(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  if (LEVEL_ORDER[level] < threshold()) return;
  const { err, ...rest } = fields;
  const line = JSON.stringify(
    {
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...rest,
      ...(err ? { err: serializeError(err) } : {}),
    },
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
  );
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};
