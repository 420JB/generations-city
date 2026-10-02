export type LogFields = Record<string, string | number | boolean | null | undefined>

export interface Logger {
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
}

/** Structured logs: one JSON object per line. Never pass secrets or connection strings as fields. */
export function createLogger(write: (line: string) => void = (line) => process.stdout.write(line)): Logger {
  const emit = (level: string, message: string, fields?: LogFields) => write(`${JSON.stringify({ level, time: new Date().toISOString(), message, ...fields })}\n`)
  return {
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  }
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} }

/** A loggable description of a thrown value: the error's name and code, never its message. */
export function errorFields(err: unknown): LogFields {
  if (err instanceof Error) return { errorName: err.name, errorCode: (err as { code?: unknown }).code?.toString() }
  return { errorName: typeof err }
}
