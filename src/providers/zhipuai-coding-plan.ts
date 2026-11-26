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
//   1302, 1305              per-model concurrency cap / → provider+model-wide
//                          platform overload            exponential backoff
//                                                    (shared process-global,
//                                                    see src/ratelimit.ts)
//   1308, 1310, 1316–1321   quota windows, message carries the reset time
//                                                    → segmented waiting
//   1113, 1309, 1311,       fatal: retries cannot fix them, a human must act
//   1313, 1314, 1315                                  → fail fast + notify
//   everything else                                    → OpenCode built-in
//
// The 5-hour quota window (1308 and friends) is spanned by proportional
// segments: 5 wait segments (10 decisions − 5 held in reserve) × 63 min of
// span = 315 min — the window plus the same 15-min slow-clock margin the
// earlier 7 × 45 configuration had. The LAST wait segment lands 1 min past
// the claimed reset (budget.ts landing slack), and once the reset is due
// but the quota is still limited the reserve is spent as one-minute
// probes — an aggregate ~6 min of local-clock-ahead skew absorbed before
// giving up. Weekly/monthly windows (1310, 1317, 1319, 1321) exceed the
// span, so they fail fast with the reset time in the notification. That is
// decided dynamically from the parsed reset time, not hardcoded per code.

import { decisionsRemaining, maxSpanMs, segmentDelay, segmentsAvailable } from "../budget.ts"
import type { Logger } from "../logger.ts"
import { NotifyGate, type Notification } from "../notify.ts"
import { rateLimitKey, sharedRateLimitBackoff, type BackoffDecision } from "../ratelimit.ts"
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
  quota: {
    waitSegments: 7,
    // 5 of the 10 decisions are held in reserve: spent as one-minute probes
    // once the claimed reset is due but the quota is still limited (clock
    // skew / late flush), and left to OpenCode's built-in policy on any
    // post-reset trouble. Together with the landing slack (budget.ts) the
    // fast-clock tolerance is ~6 min.
    reserve: 5,
    minSegmentMs: 60_000,
    // 63 min: 5 usable segments × 63 min = 315 min of span — the 5-hour
    // window plus the same 15-min slow-clock margin 7 × 45 min used to give.
    maxSegmentMs: 3_780_000,
    // Delay cap for a session's FIRST wait in a window (reset-card fast
    // recovery probe). Wired up in the handler; see budget.ts.
    firstSegmentMs: 600_000,
  },
  // 1302 (account per-model concurrency cap) and 1305 (platform overload)
  // both back off on one shared curve: 30 s base growing ×1.5 to a 10 min
  // ceiling, shared by every session of the same provider+model in the
  // process (see src/ratelimit.ts). Gentle on purpose: tool execution
  // between requests already spaces them; only sustained hammering climbs
  // the whole curve. Flash models have far higher limits — they ship with a
  // more lenient base.
  rateLimit: {
    baseMs: 30_000,
    maxMs: 600_000,
    decayAfterMs: 600_000,
    factor: 1.5,
    models: { "glm-5.3-flash": { baseMs: 15_000 } },
  },
}

/** Both backoff codes — 1302 (account concurrency cap) and 1305 (platform
 * overload, docs rate-limit §4) — mean "slow down requests to this
 * provider+model" and share one exponential sequence (see src/ratelimit.ts). */
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

    // The recovery notification closes the loop on the ⚠️ window
    // announcement (and on the ❌ final-probe one): the host's recovery
    // tracker fires it when the session's next turn succeeds. Attached to
    // the wait record only while notifications are enabled.
    const recoveredNotification = (code: string, resetRaw: string): Notification => ({
      title: `✅ 智譜額度已恢復（${code}）`,
      message: `額度已於 ${resetRaw}（UTC+8）重置，會話已自動恢復並繼續任務。`,
      priority: 3,
    })

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

      if (code === RATE_LIMIT_CODE || code === OVERLOAD_CODE) {
        // 1302 = the account's per-model concurrency cap; 1305 = the model
        // overloaded platform-wide (docs.bigmodel.cn/cn/api/rate-limit §4 —
        // the official advice for both amounts to "space out requests to
        // this model"). Both share ONE process-wide exponential sequence per
        // provider+model: N parallel sessions each on their own schedule
        // would keep either limit tripped, while one growing sequence
        // actually slows the aggregate request rate. The lookup is per
        // event because the model is per event, and a models{} override
        // retunes this model's curve.
        const override = config.rateLimit.models?.[event.model.id]
        const rateLimit = override === undefined ? config.rateLimit : { ...config.rateLimit, ...override }
        const backoff: BackoffDecision = sharedRateLimitBackoff(
          rateLimitKey(deps.providerID, event.model.id),
          rateLimit,
        ).next(deps.now())
        event.decision = { retry: true, delay: backoff.delayMs }
        logger.info("rate limit — provider-wide exponential backoff", {
          session: event.sessionID,
          code,
          attempt: event.attempt,
          model: event.model.id,
          delayMs: backoff.delayMs,
          backoffLevel: backoff.level,
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
        if (remaining > config.quota.minSegmentMs) {
          // Waiting budget spent and the (possibly moved) reset is still
          // beyond one probe: give up fast.
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
        // The claimed reset is due (or within one probe of it) yet the quota
        // is still limited: the local clock is ahead of the server, or the
        // flush is running late. Spend the held-back reserve decisions as
        // one-minute probes — with the landing slack, ~6 minutes of skew is
        // absorbed before the retry budget runs out.
        const finalProbe = decisionsRemaining(event.attempt) <= 1
        const delay = config.quota.minSegmentMs
        event.decision = { retry: true, delay }
        deps.track?.(event.sessionID, {
          code,
          resetAt: reset.epoch,
          resetRaw: reset.raw,
          delayMs: delay,
          segments: 0,
          ...(config.notify ? { recoveredNotification: recoveredNotification(code, reset.raw) } : {}),
        })
        logger.info("quota reset due — reserve probe scheduled", {
          session: event.sessionID,
          provider: event.model.providerID,
          code,
          attempt: event.attempt,
          delayMs: delay,
          resetAt: reset.raw,
          finalProbe,
        })
        if (config.notify && finalProbe) {
          fireGated(
            `terminal:${reset.raw}`,
            Infinity,
            {
              title: `❌ 智譜額度未恢復（${code}）`,
              message: `額度重置時間已到（${reset.raw}）仍持續收到額度上限（${code}），已排程最後一次自動探測，若仍未恢復將停止重試。`,
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
        ...(config.notify ? { recoveredNotification: recoveredNotification(code, reset.raw) } : {}),
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
