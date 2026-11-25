// Provider rules for zhipuai-coding-plan (GLM Coding Plan, open.bigmodel.cn).
//
// Zhipu errors are two-layered: an HTTP status code outside, a business error
// code inside the response body as {"error":{"code":"...","message":"..."}}.
// OpenCode maps every 429 to error.type "provider.rate-limit", so the only
// way to tell quota exhaustion apart from a rate limit is parsing the body's
// error.code. Reference: official error-code table at
// https://docs.bigmodel.cn/cn/api/api-code (summary below).
//
// 429 family, by behavior:
//   1302                    account rate limit        → provider-wide
//                                                    exponential backoff
//                                                    (shared process-global,
//                                                    see src/ratelimit.ts)
//   1305                    model overload            → OpenCode built-in
//   1308, 1310, 1316–1321   quota windows, message carries the reset time
//                                                    → segmented waiting
//   1113, 1309, 1311,       fatal: retries cannot fix them, a human must act
//   1313, 1314, 1315                                  → fail fast + notify
//   everything else                                    → OpenCode built-in
//
// The 5-hour quota window (1308 and friends) is spanned by proportional
// segments: 7 waiting segments × 45 min capacity ≥ the window, keeping 3
// retry decisions in reserve for post-reset trouble. Weekly/monthly windows
// (1310, 1317, 1319, 1321) exceed the span, so they fail fast with the reset
// time in the notification. That is decided dynamically from the parsed
// reset time, not hardcoded per code.

import { maxSpanMs, segmentDelay, segmentsAvailable } from "../budget.ts"
import type { Logger } from "../logger.ts"
import { NotifyGate, type Notification } from "../notify.ts"
import { sharedRateLimitBackoff, type BackoffDecision } from "../ratelimit.ts"
import type { HandlerDeps, ProviderConfig, ProviderEntry, RetryEvent } from "../types.ts"

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

// ---- Retry decision handler ----

export const DEFAULT_CONFIG: ProviderConfig = {
  enabled: true,
  // The zhipuai coding plan has a reset card: quota exhaustion is actionable
  // (reset now on the website), so notifications are on by default.
  notify: true,
  quota: { waitSegments: 7, reserve: 3, minSegmentMs: 60_000, maxSegmentMs: 2_700_000 },
  // 1302 is account-wide: 30 s base doubling to a 10 min ceiling, shared by
  // every session of this provider in the process (see src/ratelimit.ts).
  rateLimit: { baseMs: 30_000, maxMs: 600_000, decayAfterMs: 600_000 },
}

const RATE_LIMIT_CODE = "1302"
const OVERLOAD_CODE = "1305"

/** Quota-window codes: the message carries a reset time (next_flush_time). */
const QUOTA_CODES = new Set(["1308", "1310", "1316", "1317", "1318", "1319", "1320", "1321"])

/** Fatal codes: retrying cannot help; the hint says what a human should do. */
const FATAL_HINTS: Record<string, string> = {
  "1113": "帳戶欠費，請充值或更換為套餐 Key。",
  "1309": "GLM Coding Plan 套餐已到期，請續訂。",
  "1311": "套餐未開放該模型，請改用套餐內的模型。",
  "1313": "觸發公平使用策略，請到個人中心申請解除限制。",
  "1314": "企業套餐已失效，請聯絡企業管理員。",
  "1315": "API Key 類型不符，請更換對應產品類型的 Key。",
}

/** Fatal notifications re-arm after an hour. */
const FATAL_DEDUP_MS = 3_600_000

function humanizeMs(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days} 天`)
  if (hours > 0) parts.push(`${hours} 小時`)
  if (mins > 0) parts.push(`${mins} 分`)
  return parts.length > 0 ? parts.join(" ") : "不到 1 分鐘"
}

export const zhipuaiCodingPlan: ProviderEntry = {
  defaultConfig: DEFAULT_CONFIG,
  createHandler(deps: HandlerDeps, config: ProviderConfig) {
    const gate = new NotifyGate()
    const logger: Logger = deps.logger
    // Provider-wide, process-global: every handler instance (one per
    // location) and every session of this provider shares this sequence.
    const rateLimitBackoff = sharedRateLimitBackoff(deps.providerID, config.rateLimit)

    // Fire-and-forget with rollback: never let notification trouble reach
    // the retry path, and never let a FAILED delivery consume a dedup
    // window — if the notifier RPC is unavailable (e.g. the notifier plugin
    // is mid-install/update), the next retry event re-attempts the
    // notification instead of losing it for the whole quota window.
    const fireGated = (key: string, windowMs: number, n: Notification) => {
      if (!gate.allow(key, windowMs, deps.now())) return
      const release = (reason: unknown) => {
        gate.release(key)
        logger.debug("notification not delivered — dedup key released for the next retry event", {
          key,
          reason: String(reason),
        })
      }
      try {
        const result = deps.send(n)
        Promise.resolve(result).then(
          (delivered) => {
            if (delivered !== true) release("sender reported not delivered")
          },
          (err) => release(err),
        )
      } catch (err) {
        release(err)
      }
    }

    return (event: RetryEvent) => {
      const parsed = parseBody(event.error.response?.body)
      if (!parsed) {
        logger.debug("unparseable error body — leaving decision to built-in policy", {
          session: event.sessionID,
          provider: event.model.providerID,
          attempt: event.attempt,
        })
        return
      }
      const code = parsed.code

      if (code === RATE_LIMIT_CODE) {
        // Account-level rate limit: exponential backoff shared across ALL
        // sessions and locations of this provider — N parallel sessions
        // each waiting a fixed delay would keep the account limited; one
        // growing sequence is what actually slows the request rate.
        const backoff: BackoffDecision = rateLimitBackoff.next(deps.now())
        event.decision = { retry: true, delay: backoff.delayMs }
        logger.info("rate limit — provider-wide exponential backoff", {
          session: event.sessionID,
          code,
          attempt: event.attempt,
          delayMs: backoff.delayMs,
          backoffLevel: backoff.level,
        })
        return
      }
      if (code === OVERLOAD_CODE) {
        logger.debug("model overload — built-in policy", {
          session: event.sessionID,
          code,
          attempt: event.attempt,
        })
        return
      }

      const fatalHint = FATAL_HINTS[code]
      if (fatalHint !== undefined) {
        event.decision = { retry: false }
        logger.warn("fatal provider error — failing fast", {
          session: event.sessionID,
          code,
          attempt: event.attempt,
          message: parsed.message,
        })
        if (config.notify) {
          fireGated(
            `fatal:${code}`,
            FATAL_DEDUP_MS,
            {
              title: `⛔ 智譜請求被拒（${code}）`,
              message: `${parsed.message}\n重試無法解決，已停止重試。${fatalHint}`,
              priority: 5,
            },
          )
        }
        return
      }

      if (!QUOTA_CODES.has(code)) {
        logger.debug("unknown code — built-in policy", {
          session: event.sessionID,
          code,
          attempt: event.attempt,
        })
        return
      }

      const reset = parseResetTime(parsed.message)
      if (!reset) {
        logger.warn("quota code without a parseable reset time — built-in policy", {
          session: event.sessionID,
          code,
          attempt: event.attempt,
          message: parsed.message,
        })
        return
      }

      const remaining = reset.epoch - deps.now()
      const segments = segmentsAvailable(event.attempt, config.quota)

      if (segments <= 0) {
        // Waiting budget spent, still quota-limited: give up fast.
        event.decision = { retry: false }
        logger.warn("quota wait budget spent — failing fast", {
          session: event.sessionID,
          code,
          attempt: event.attempt,
          resetAt: reset.raw,
        })
        if (config.notify) {
          fireGated(
            `terminal:${reset.raw}`,
            Infinity,
            {
              title: `❌ 智譜額度未恢復（${code}）`,
              message: `重試預算已用盡仍收到額度上限（${code}），已停止重試。額度重置時間：${reset.raw}。`,
              priority: 5,
            },
          )
        }
        return
      }

      if (remaining > maxSpanMs(segments, config.quota)) {
        // The window is beyond what the retry budget can span (weekly or
        // monthly quota): fail fast and tell the user when it resets.
        event.decision = { retry: false }
        logger.warn("quota window beyond wait span — failing fast", {
          session: event.sessionID,
          code,
          attempt: event.attempt,
          remainingMs: remaining,
          maxSpanMs: maxSpanMs(segments, config.quota),
          resetAt: reset.raw,
        })
        if (config.notify) {
          fireGated(
            `terminal:${reset.raw}`,
            Infinity,
            {
              title: `❌ 智譜額度用盡（${code}，無法等待重置）`,
              message: `距重置時間尚有 ${humanizeMs(remaining)}，超出可等待範圍（${segments} 段 × ${Math.round(config.quota.maxSegmentMs / 60_000)} 分鐘），已停止重試。重置時間：${reset.raw}。`,
              priority: 5,
            },
          )
        }
        return
      }

      const delay = segmentDelay(remaining, segments, config.quota)
      event.decision = { retry: true, delay }
      deps.track?.(event.sessionID, {
        code,
        resetAt: reset.epoch,
        resetRaw: reset.raw,
        delayMs: delay,
        segments,
      })
      logger.info("quota wait scheduled", {
        session: event.sessionID,
        provider: event.model.providerID,
        code,
        attempt: event.attempt,
        segments,
        delayMs: delay,
        resetAt: reset.raw,
      })
      if (config.notify) {
        fireGated(
          `quota:${reset.raw}`,
          Infinity,
          {
            title: `⚠️ 智譜額度用盡（${code}）`,
            message: `額度已用盡（錯誤碼 ${code}），將於 ${reset.raw}（UTC+8）重置。已排程分段等待與自動恢復：額度恢復後將自動繼續任務。`,
            priority: 4,
          },
        )
      }
    }
  },
}
