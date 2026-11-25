// V2 plugin context has no structured log endpoint; console output is
// captured by the server log (filter role=server). Same pattern as
// opencode-remote-notifier-plugin.

export type LoggerLevel = "debug" | "info" | "warn" | "error"

export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
}

export function createLogger(): Logger {
  const log = (level: LoggerLevel, message: string, extra?: Record<string, unknown>) => {
    const suffix = extra && Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : ""
    const line = `[error-handler] ${message}${suffix}`
    if (level === "error") console.error(line)
    else if (level === "warn") console.warn(line)
    else if (level === "debug") console.debug(line)
    else console.log(line)
  }
  return {
    debug: (msg, extra) => log("debug", msg, extra),
    info: (msg, extra) => log("info", msg, extra),
    warn: (msg, extra) => log("warn", msg, extra),
    error: (msg, extra) => log("error", msg, extra),
  }
}
