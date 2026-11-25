// Provider rules for zhipuai-coding-plan (GLM Coding Plan, open.bigmodel.cn).
//
// Zhipu errors are two-layered: an HTTP status code outside, a business error
// code inside the response body as {"error":{"code":"...","message":"..."}}.
// OpenCode maps every 429 to error.type "provider.rate-limit", so the only
// way to tell quota exhaustion apart from a rate limit is parsing the body's
// error.code. Reference: official error-code table at
// https://docs.bigmodel.cn/cn/api/api-code
//
// This file currently holds the body/reset-time parsers; the retry decision
// handler (createHandler/DEFAULT_CONFIG) is added by the wiring task.

export interface ParsedBody {
  readonly code: string
  readonly message: string
}

/**
 * Parses the zhipuai error envelope from the raw HTTP response body.
 * Returns null for anything unparseable — callers must then leave the retry
 * decision to OpenCode's built-in policy.
 */
export function parseBody(body: string | undefined): ParsedBody | null {
  if (typeof body !== "string" || body.length === 0) return null
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return null
  }
  if (typeof json !== "object" || json === null) return null
  const err = (json as { error?: unknown }).error
  if (typeof err !== "object" || err === null) return null
  const { code, message } = err as { code?: unknown; message?: unknown }
  if (typeof code !== "string" && typeof code !== "number") return null
  return { code: String(code), message: typeof message === "string" ? message : "" }
}

export interface ParsedResetTime {
  /** Verbatim timestamp string — the dedup key for one quota reset window. */
  readonly raw: string
  /** Epoch ms (the timestamp is Beijing time, UTC+8, whatever the host timezone is). */
  readonly epoch: number
}

const RESET_TIME_RE = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/

const inRange = (v: number | undefined, lo: number, hi: number): v is number =>
  v !== undefined && Number.isFinite(v) && v >= lo && v <= hi

/**
 * Extracts the quota reset time from an error message ("您的限额将在
 * YYYY-MM-DD HH:mm:ss 重置"), interpreting it as Beijing time (UTC+8).
 */
export function parseResetTime(message: string): ParsedResetTime | null {
  const raw = RESET_TIME_RE.exec(message)?.[1]
  if (!raw) return null
  const [date = "", time = ""] = raw.split(" ")
  const [y, mo, d] = date.split("-").map(Number)
  const [h, mi, s] = time.split(":").map(Number)
  if (!inRange(y, 1970, 9999) || !inRange(mo, 1, 12) || !inRange(d, 1, 31)) return null
  if (!inRange(h, 0, 23) || !inRange(mi, 0, 59) || !inRange(s, 0, 59)) return null
  const epoch = Date.UTC(y, mo - 1, d, h - 8, mi, s)
  return Number.isFinite(epoch) ? { raw, epoch } : null
}
