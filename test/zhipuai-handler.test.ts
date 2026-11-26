import { describe, test, expect } from "bun:test"
import { DEFAULT_CONFIG, zhipuaiCodingPlan } from "../src/providers/zhipuai-coding-plan.ts"
import { maxSpanMs, segmentsAvailable } from "../src/budget.ts"
import type { Notification, NotifySender } from "../src/notify.ts"
import type { ProviderConfig, QuotaConfig, RateLimitConfig, RetryEvent } from "../src/types.ts"

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

// Fixed clock: 2026-11-25 10:00:00 UTC (18:00 Beijing).
const NOW = Date.UTC(2026, 10, 25, 10, 0, 0)

// Reset window A: 2026-11-25 20:10:12 Beijing == 12:10:12 UTC → 7,812,000 ms away.
const RESET_A = "2026-11-25 20:10:12"
const RESET_A_EPOCH = Date.UTC(2026, 10, 25, 12, 10, 12)

const body1308 = (reset: string) =>
  JSON.stringify({ error: { code: "1308", message: `已达到 5 小时的使用上限。您的限额将在 ${reset} 重置。` } })
const body1316 = (reset: string) =>
  JSON.stringify({ error: { code: "1316", message: `已达到 5 小时使用上限。主账号余额不足，无法使用超额按量付费。您的限额将在 ${reset} 重置。` } })

const body1302 = () =>
  JSON.stringify({ error: { code: "1302", message: "您的账户已达到速率限制，请您控制请求频率" } })

// Unique providerID per handler: the rate-limit backoff is shared globally
// per provider key, so tests must not inherit each other's backoff level.
let providerSeq = 0
const freshProviderID = () => `test-zhipuai-${providerSeq++}`

function ev(body: string | undefined, opts: Partial<RetryEvent> = {}): RetryEvent {
  const builtIn = { retry: true, delay: 4000 } as const
  return {
    sessionID: "ses_1",
    agent: "build",
    model: { providerID: "zhipuai-coding-plan", id: "glm-5.3" },
    error: {
      type: "provider.rate-limit",
      message: "provider rate limited",
      status: 429,
      ...(body === undefined ? {} : { response: { body } }),
    },
    attempt: 2,
    decision: { ...builtIn },
    ...opts,
  }
}

interface Harness {
  sent: Notification[]
  handle(event: RetryEvent): void
  now: number
  providerID: string
}

/** Test-visible provider config: every field optional, nested sections mergeable. */
type TestConfig = Partial<Omit<ProviderConfig, "quota" | "rateLimit">> & {
  quota?: Partial<QuotaConfig>
  rateLimit?: Partial<RateLimitConfig>
}

function harness(
  config: TestConfig = {},
  now: number = NOW,
  providerID: string = freshProviderID(),
): Harness {
  const sent: Notification[] = []
  const send: NotifySender = (n) => {
    sent.push(n)
    return true
  }
  const cfg: ProviderConfig = {
    enabled: config.enabled ?? DEFAULT_CONFIG.enabled,
    notify: config.notify ?? DEFAULT_CONFIG.notify,
    quota: { ...DEFAULT_CONFIG.quota, ...config.quota },
    rateLimit: { ...DEFAULT_CONFIG.rateLimit, ...config.rateLimit },
  }
  const handler = zhipuaiCodingPlan.createHandler(
    { now: () => now, send, logger: silentLogger, providerID },
    cfg,
  )
  return { sent, handle: handler, now, providerID }
}

describe("decision table", () => {
  test("1302 → retry after the base delay at any attempt (fresh backoff)", () => {
    for (const attempt of [2, 5, 11]) {
      const h = harness()
      const event = ev(body1302(), { attempt })
      h.handle(event)
      expect(event.decision).toEqual({ retry: true, delay: 30_000 })
      expect(h.sent).toBeEmpty()
    }
  })

  test("1305 → retry after the base delay at any attempt (fresh backoff)", () => {
    // Platform overload (docs rate-limit §4): "稍后重试、增加重试间隔" —
    // the same shared provider+model sequence as 1302.
    for (const attempt of [2, 5, 11]) {
      const h = harness()
      const event = ev(JSON.stringify({ error: { code: "1305", message: "该模型当前访问量过大，请您稍后再试" } }), { attempt })
      h.handle(event)
      expect(event.decision).toEqual({ retry: true, delay: 30_000 })
      expect(h.sent).toBeEmpty()
    }
  })

  test("1305 joins the same shared sequence as 1302 (either code means: slow down this model)", () => {
    const h = harness()
    const first = ev(body1302())
    h.handle(first)
    expect(first.decision).toEqual({ retry: true, delay: 30_000 })
    const overload = ev(
      JSON.stringify({ error: { code: "1305", message: "该模型当前访问量过大，请您稍后再试" } }),
      { sessionID: "ses_overload" },
    )
    h.handle(overload)
    // Same provider+model, different cause — one growing sequence.
    expect(overload.decision).toEqual({ retry: true, delay: 45_000 })
    const again = ev(body1302(), { sessionID: "ses_2" })
    h.handle(again)
    expect(again.decision).toEqual({ retry: true, delay: 68_000 })
  })

  test("unknown codes → untouched, no notification", () => {
    for (const code of ["1301", "1234", "9999", "1113x"]) {
      const h = harness()
      const event = ev(JSON.stringify({ error: { code, message: "whatever" } }))
      const original = event.decision
      h.handle(event)
      expect(event.decision).toBe(original)
      expect(h.sent).toBeEmpty()
    }
  })

  test("body missing / invalid / codeless → untouched", () => {
    for (const body of [undefined, "not json", JSON.stringify({ error: {} }), JSON.stringify({ ok: true })]) {
      const h = harness()
      const event = ev(body)
      const original = event.decision
      h.handle(event)
      expect(event.decision).toBe(original)
    }
  })

  test("1308 without a parseable reset time → untouched", () => {
    const h = harness()
    const event = ev(JSON.stringify({ error: { code: "1308", message: "已达到使用上限" } }))
    const original = event.decision
    h.handle(event)
    expect(event.decision).toBe(original)
    expect(h.sent).toBeEmpty()
  })
})

describe("1302 rate limit — provider-wide exponential backoff", () => {
  // The backoff state lives in a process-global registry keyed by providerID,
  // so consecutive 1302 events (across sessions AND handler instances — one
  // per location) share one growing delay: this is what actually slows the
  // aggregate request rate against the provider.
  test("consecutive events grow the delay by factor, capped", () => {
    const h = harness()
    const delays: number[] = []
    let attempt = 2
    for (let i = 0; i < 8; i++) {
      const event = ev(body1302(), { attempt })
      h.handle(event)
      delays.push((event.decision as { retry: true; delay: number }).delay)
      attempt++
    }
    expect(delays).toEqual([30_000, 45_000, 68_000, 101_000, 152_000, 228_000, 342_000, 513_000])
  })

  test("the backoff is shared across handler instances of the same provider", () => {
    const providerID = freshProviderID()
    const a = harness({}, NOW, providerID)
    const b = harness({}, NOW, providerID)
    const first = ev(body1302())
    a.handle(first)
    expect(first.decision).toEqual({ retry: true, delay: 30_000 })
    const second = ev(body1302(), { sessionID: "ses_2" })
    b.handle(second)
    expect(second.decision).toEqual({ retry: true, delay: 45_000 })
    const third = ev(body1302(), { sessionID: "ses_3" })
    a.handle(third)
    expect(third.decision).toEqual({ retry: true, delay: 68_000 })
  })

  test("different models keep independent backoffs (limits are per model)", () => {
    // 1302 means the account's concurrency cap for THAT model was hit;
    // glm-5.3 being limited says nothing about glm-5.3-flash.
    const h = harness()
    const main1 = ev(body1302())
    h.handle(main1)
    expect(main1.decision).toEqual({ retry: true, delay: 30_000 })
    const main2 = ev(body1302())
    h.handle(main2)
    expect(main2.decision).toEqual({ retry: true, delay: 45_000 })
    const flash = ev(body1302(), {
      sessionID: "ses_title",
      model: { providerID: "zhipuai-coding-plan", id: "glm-5.3-flash" },
    })
    h.handle(flash)
    // flash ships a more lenient default: base 15 s instead of 30 s
    expect(flash.decision).toEqual({ retry: true, delay: 15_000 })
  })

  test("flash backoff grows from its own (lenient) base", () => {
    const h = harness()
    const delays: number[] = []
    for (let i = 0; i < 4; i++) {
      const event = ev(body1302(), {
        sessionID: "ses_title",
        model: { providerID: "zhipuai-coding-plan", id: "glm-5.3-flash" },
      })
      h.handle(event)
      delays.push((event.decision as { retry: true; delay: number }).delay)
    }
    expect(delays).toEqual([15_000, 23_000, 34_000, 51_000])
  })

  test("a models override retunes one model without touching others", () => {
    const h = harness({ rateLimit: { models: { "glm-5.3-flash": { baseMs: 5_000 } } } })
    const flash = ev(body1302(), {
      model: { providerID: "zhipuai-coding-plan", id: "glm-5.3-flash" },
    })
    h.handle(flash)
    expect(flash.decision).toEqual({ retry: true, delay: 5_000 })
    const main = ev(body1302())
    h.handle(main)
    expect(main.decision).toEqual({ retry: true, delay: 30_000 })
  })

  test("the level decays back to the base after a quiet period", () => {
    let now = NOW
    const h = harness({}, now)
    let event = ev(body1302())
    h.handle(event)
    expect(event.decision).toEqual({ retry: true, delay: 30_000 })
    event = ev(body1302())
    h.handle(event)
    expect(event.decision).toEqual({ retry: true, delay: 45_000 })
    // 10 quiet minutes (decayAfterMs): the next 1302 restarts from the base.
    now += DEFAULT_CONFIG.rateLimit.decayAfterMs
    event = ev(body1302())
    const h2 = harness({}, now, h.providerID)
    h2.handle(event)
    expect(event.decision).toEqual({ retry: true, delay: 30_000 })
  })

  test("rateLimit config overrides the sequence (base, factor, cap)", () => {
    const h = harness({ rateLimit: { baseMs: 5_000, maxMs: 20_000, factor: 2 } })
    const delays: number[] = []
    for (let i = 0; i < 4; i++) {
      const event = ev(body1302())
      h.handle(event)
      delays.push((event.decision as { retry: true; delay: number }).delay)
    }
    expect(delays).toEqual([5_000, 10_000, 20_000, 20_000])
  })

  test("no notification fires for rate limits (transient, recovers alone)", () => {
    const h = harness()
    for (let i = 0; i < 5; i++) h.handle(ev(body1302()))
    expect(h.sent).toBeEmpty()
  })
})

describe("quota segmented waiting", () => {
  test("1308 at attempt 2: 10-minute first probe (reset-card fast recovery), one notification", () => {
    const h = harness()
    const event = ev(body1308(RESET_A))
    h.handle(event)
    // A session's first wait in a window is capped at firstSegmentMs (10 min)
    // instead of the proportional share (7,812,000 / 5 = 1,562,400 ms).
    expect(event.decision).toEqual({ retry: true, delay: 600_000 })
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.title).toContain("1308")
    expect(h.sent[0]?.message).toContain(RESET_A)
    expect(h.sent[0]?.message).toContain("自動恢復")
    expect(h.sent[0]?.priority).toBe(4)
  })

  test("the ⚠️ notification tells the user a card reset recovers at the first probe", () => {
    const h = harness()
    const event = ev(body1308(RESET_A))
    h.handle(event)
    expect(h.sent[0]?.message).toContain("若使用重置卡提前重置，將於首段探測（10 分）自動恢復。")
  })

  test("second wait in the same window: proportional with the raised cap", () => {
    let now = NOW
    const handler = zhipuaiCodingPlan.createHandler(
      { now: () => now, send: () => true, logger: silentLogger, providerID: freshProviderID() },
      DEFAULT_CONFIG,
    )
    const first = ev(body1308(RESET_A))
    handler(first)
    expect(first.decision).toEqual({ retry: true, delay: 600_000 })
    now += 600_000
    const second = ev(body1308(RESET_A), { attempt: 3 })
    handler(second)
    // ceil((7_812_000 − 600_000) / 4) = 1_803_000
    expect(second.decision).toEqual({ retry: true, delay: 1_803_000 })
  })

  test("each session gets its own first probe in the same window", () => {
    const h = harness()
    h.handle(ev(body1308(RESET_A))) // ses_1 first probe
    const other = ev(body1308(RESET_A), { sessionID: "ses_2" })
    h.handle(other)
    expect(other.decision).toEqual({ retry: true, delay: 600_000 })
    const again = ev(body1308(RESET_A), { attempt: 3 }) // ses_1, window seen
    h.handle(again)
    expect(again.decision).toEqual({ retry: true, delay: 1_953_000 })
  })

  test("each event recomputes segments from its own attempt", () => {
    const h = harness()
    h.handle(ev(body1308(RESET_A))) // registers the window → no first cap below
    const event = ev(body1308(RESET_A), { attempt: 3 })
    h.handle(event)
    // 7,812,000 ms over 4 segments = 1,953,000 ms
    expect(event.decision).toEqual({ retry: true, delay: 1_953_000 })
  })

  test("other quota codes with reset times follow the same path", () => {
    const h = harness()
    const event = ev(body1316(RESET_A))
    h.handle(event)
    expect(event.decision).toEqual({ retry: true, delay: 600_000 })
    expect(h.sent).toHaveLength(1)
  })

  test("reset time already past: delay clamps to the minimum (probe)", () => {
    const h = harness()
    // 08:00 Beijing == 00:00 UTC — two hours before NOW
    const event = ev(body1308("2026-11-25 08:00:00"))
    h.handle(event)
    expect(event.decision).toEqual({ retry: true, delay: 60_000 })
    expect(h.sent).toHaveLength(1)
  })

  test("attempt 6 with a reachable reset still schedules the last segment (with landing slack)", () => {
    const h = harness()
    // 40 minutes ahead, one segment left: 40 min + 1 min landing slack
    const event = ev(body1308("2026-11-25 18:40:00"), { attempt: 6 })
    h.handle(event)
    expect(event.decision).toEqual({ retry: true, delay: 2_460_000 })
  })

  test("reset too far to span (weekly/monthly window): fail fast + terminal notify", () => {
    const h = harness()
    const event = ev(body1308("2099-06-01 12:00:00"))
    h.handle(event)
    expect(event.decision).toEqual({ retry: false })
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.message).toContain("2099-06-01 12:00:00")
    // The copy names the first-aware span: 10 min + 4 × 78 min = 322 min.
    expect(h.sent[0]?.message).toContain("最長約 5 小時 22 分")
    expect(h.sent[0]?.priority).toBe(5)
  })

  test("waiting budget exhausted (attempt 9+): fail fast + terminal notify", () => {
    const h = harness()
    const event = ev(body1308(RESET_A), { attempt: 9 })
    h.handle(event)
    expect(event.decision).toEqual({ retry: false })
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.message).toContain(RESET_A)
    expect(h.sent[0]?.priority).toBe(5)
  })
})

describe("reserve probes — reset due, waiting budget spent", () => {
  // 2026-11-25 17:59:00 Beijing == 09:59 UTC: one minute PAST the fixed NOW.
  const PAST = "2026-11-25 17:59:00"

  test("quota still limited past the reset → one-minute probe, no notification", () => {
    const h = harness()
    const event = ev(body1308(PAST), { attempt: 7 })
    h.handle(event)
    expect(event.decision).toEqual({ retry: true, delay: 60_000 })
    expect(h.sent).toBeEmpty()
  })

  test("the probe is tracked like a wait segment (carrying its recovery notification)", () => {
    const tracked: Array<{ delayMs: number; segments: number; recoveredNotification?: Notification }> = []
    const handler = zhipuaiCodingPlan.createHandler(
      {
        now: () => NOW,
        send: () => true,
        logger: silentLogger,
        providerID: freshProviderID(),
        track: (_sessionID, wait) =>
          tracked.push({ delayMs: wait.delayMs, segments: wait.segments, recoveredNotification: wait.recoveredNotification }),
      },
      DEFAULT_CONFIG,
    )
    handler(ev(body1308(PAST), { attempt: 7 }))
    expect(tracked).toHaveLength(1)
    expect(tracked[0]!.delayMs).toBe(60_000)
    expect(tracked[0]!.segments).toBe(0)
    expect(tracked[0]!.recoveredNotification?.title).toContain("已恢復")
  })

  test("a reset merely nearly due (within one probe interval) also probes", () => {
    const h = harness()
    // 30 seconds ahead — inside the one-probe gate.
    const event = ev(body1308("2026-11-25 18:00:30"), { attempt: 9 })
    h.handle(event)
    expect(event.decision).toEqual({ retry: true, delay: 60_000 })
    expect(h.sent).toBeEmpty()
  })

  test("a reset still ahead (beyond one probe) → fail fast + terminal notify", () => {
    const h = harness()
    // 2 minutes ahead — a moved reset; one-minute probes cannot reach it.
    const event = ev(body1308("2026-11-25 18:02:00"), { attempt: 9 })
    h.handle(event)
    expect(event.decision).toEqual({ retry: false })
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.priority).toBe(5)
  })

  test("the final reserve probe (attempt 11) carries the terminal notification", () => {
    const h = harness()
    const event = ev(body1308(PAST), { attempt: 11 })
    h.handle(event)
    expect(event.decision).toEqual({ retry: true, delay: 60_000 })
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.title).toContain("額度未恢復")
    expect(h.sent[0]?.message).toContain(PAST)
    expect(h.sent[0]?.message).toContain("最後一次")
    expect(h.sent[0]?.priority).toBe(5)
  })

  test("earlier probes stay silent; only the final one notifies", () => {
    const h = harness()
    for (const attempt of [7, 8, 9, 10]) {
      const event = ev(body1308(PAST), { attempt })
      h.handle(event)
      expect(event.decision).toEqual({ retry: true, delay: 60_000 })
    }
    expect(h.sent).toBeEmpty()
    h.handle(ev(body1308(PAST), { attempt: 11 }))
    expect(h.sent).toHaveLength(1)
  })
})

describe("skew walkthrough — local clock 3 minutes ahead of the server", () => {
  test("five wait segments, landing slack, then reserve probes absorb the skew", () => {
    const sent: Notification[] = []
    let now = NOW + 3 * 60_000 // local clock ahead; server truth stays NOW
    // True reset (server): 15:00 UTC = 5 h after NOW; local reads 5 h − 3 min.
    const RESET = "2026-11-25 23:00:00"
    const handler = zhipuaiCodingPlan.createHandler(
      { now: () => now, send: (n) => { sent.push(n); return true }, logger: silentLogger, providerID: freshProviderID() },
      DEFAULT_CONFIG,
    )
    const delays: number[] = []
    // attempts 2..6: the five wait segments; 7..8: reserve probes while the
    // server-side reset is still 2/1 minutes away; attempt 9 then succeeds.
    for (const attempt of [2, 3, 4, 5, 6, 7, 8]) {
      const event = ev(body1308(RESET), { attempt })
      handler(event)
      const delay = (event.decision as { retry: true; delay: number }).delay
      delays.push(delay)
      now += delay
    }
    expect(delays).toEqual([
      600_000, // first probe: min(firstSegmentMs, ceil(17_820_000 / 5))
      4_305_000, 4_305_000, 4_305_000, // proportional: ceil(remaining / 4|3|2)
      4_365_000, // last segment: 4_305_000 + 60 s landing slack
      60_000, 60_000, // reserve probes while the true reset is still ahead
    ])
    // Local clock now reads past the reset; the next attempt runs exactly
    // when the server has flushed — recovered, no terminal notification.
    expect(sent).toHaveLength(1) // the ⚠️ window notification only
  })
})

describe("notification dedup", () => {
  test("one notification per reset window, decisions keep flowing", () => {
    const h = harness()
    h.handle(ev(body1308(RESET_A)))
    h.handle(ev(body1308(RESET_A), { attempt: 3 }))
    h.handle(ev(body1308(RESET_A), { attempt: 4 }))
    expect(h.sent).toHaveLength(1)
  })

  test("one window notification across handler instances (OpenCode runs one plugin instance per location)", () => {
    // Production evidence (2026-11-27): parallel sessions in three project
    // locations hit the same account quota window and each location's
    // handler instance re-announced it — three ⚠️ for one window. The dedup
    // gate must live in module scope (process scope), like the rate-limit
    // backoff, so every location's instance shares it.
    const providerID = freshProviderID()
    const locXuansi = harness({}, NOW, providerID)
    const locYanshi = harness({}, NOW, providerID)
    const locOpencode = harness({}, NOW, providerID)
    locXuansi.handle(ev(body1308(RESET_A))) // first session in the window
    locYanshi.handle(ev(body1308(RESET_A), { sessionID: "ses_yanshi" }))
    locOpencode.handle(ev(body1308(RESET_A), { sessionID: "ses_opencode", attempt: 3 }))
    expect(locXuansi.sent).toHaveLength(1)
    expect(locYanshi.sent).toBeEmpty()
    expect(locOpencode.sent).toBeEmpty()
  })

  test("a failing window notification in one location re-attempts from another", async () => {
    // The rollback semantics survive the sharing: when location A's send
    // fails, the released key lets location B's next event re-attempt.
    const flush = () => new Promise<void>((r) => setTimeout(r, 0))
    const providerID = freshProviderID()
    const sent: Notification[] = []
    let deliver = false
    const make = () => {
      const handler = zhipuaiCodingPlan.createHandler(
        { now: () => NOW, send: (n) => { sent.push(n); return deliver }, logger: silentLogger, providerID },
        DEFAULT_CONFIG,
      )
      return handler
    }
    make()(ev(body1308(RESET_A))) // attempted, not delivered → key released
    await flush()
    expect(sent).toHaveLength(1)
    deliver = true
    make()(ev(body1308(RESET_A), { sessionID: "ses_2" })) // fresh instance, re-attempt
    await flush()
    expect(sent).toHaveLength(2)
  })

  test("a new reset window notifies again", () => {
    const h = harness()
    h.handle(ev(body1308(RESET_A)))
    h.handle(ev(body1308("2026-11-26 01:00:00")))
    expect(h.sent).toHaveLength(2)
  })

  test("terminal notifications dedup separately from the window notification", () => {
    const h = harness()
    h.handle(ev(body1308("2099-06-01 12:00:00")))
    h.handle(ev(body1308("2099-06-01 12:00:00")))
    expect(h.sent).toHaveLength(1)
  })

  test("fatal codes dedup on a time window, not forever", () => {
    let now = NOW
    const sent: Notification[] = []
    const handler = zhipuaiCodingPlan.createHandler(
      { now: () => now, send: (n) => { sent.push(n); return true }, logger: silentLogger, providerID: freshProviderID() },
      DEFAULT_CONFIG,
    )
    const body = JSON.stringify({ error: { code: "1309", message: "您的 GLM Coding Plan 套餐已到期，暂无法使用" } })
    handler(ev(body))
    now += 30 * 60_000
    handler(ev(body))
    expect(sent).toHaveLength(1)
    now += 31 * 60_000
    handler(ev(body))
    expect(sent).toHaveLength(2)
  })

  test("notify:false disables sends but keeps decisions", () => {
    const h = harness({ notify: false })
    const event = ev(body1308(RESET_A))
    h.handle(event)
    expect(event.decision).toEqual({ retry: true, delay: 600_000 })
    expect(h.sent).toBeEmpty()
  })
})

describe("fatal plan errors", () => {
  test("fail fast with an actionable hint", () => {
    const h = harness()
    const event = ev(JSON.stringify({ error: { code: "1309", message: "您的 GLM Coding Plan 套餐已到期，暂无法使用" } }))
    h.handle(event)
    expect(event.decision).toEqual({ retry: false })
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.message).toContain("套餐")
    expect(h.sent[0]?.message).toContain("續訂")
    expect(h.sent[0]?.priority).toBe(5)
  })

  test("covers the other fatal codes", () => {
    for (const code of ["1113", "1311", "1313", "1314", "1315"]) {
      const h = harness()
      const event = ev(JSON.stringify({ error: { code, message: "x" } }))
      h.handle(event)
      expect(event.decision).toEqual({ retry: false })
      expect(h.sent).toHaveLength(1)
    }
  })
})

describe("robustness", () => {
  test("a throwing sender never breaks the decision", () => {
    const handler = zhipuaiCodingPlan.createHandler(
      {
        now: () => NOW,
        send: () => {
          throw new Error("boom")
        },
        logger: silentLogger,
        providerID: freshProviderID(),
      },
      DEFAULT_CONFIG,
    )
    const event = ev(body1308(RESET_A))
    expect(() => handler(event)).not.toThrow()
    expect(event.decision).toEqual({ retry: true, delay: 600_000 })
  })
})

test("DEFAULT_CONFIG ships zhipuai enabled with notifications", () => {
  expect(DEFAULT_CONFIG).toEqual({
    enabled: true,
    notify: true,
    quota: { waitSegments: 7, reserve: 5, minSegmentMs: 60_000, maxSegmentMs: 4_680_000, firstSegmentMs: 600_000 },
    rateLimit: {
      baseMs: 30_000,
      maxMs: 600_000,
      decayAfterMs: 600_000,
      factor: 1.5,
      models: { "glm-5.3-flash": { baseMs: 15_000 } },
    },
  })
})

test("default quota arithmetic still spans the 5-hour window with a slow-clock margin", () => {
  // 10 decisions − 5 reserved = 5 usable wait segments: a 10-min first probe
  // (reset card fast recovery) + 4 × 78 min = 322 min — the 5-hour window
  // plus a slow-clock margin (was 5 × 63 = 315 min before the first probe).
  const usable = segmentsAvailable(2, DEFAULT_CONFIG.quota)
  expect(usable).toBe(5)
  expect(maxSpanMs(usable, DEFAULT_CONFIG.quota, true)).toBe(19_320_000)
})

describe("notification delivery failures release the dedup window", () => {
  const flush = () => new Promise<void>((r) => setTimeout(r, 0))

  test("an undelivered send (false) retries on the next event; success holds", async () => {
    const sent: Notification[] = []
    let deliver = false
    const handler = zhipuaiCodingPlan.createHandler(
      { now: () => NOW, send: (n) => { sent.push(n); return deliver }, logger: silentLogger, providerID: freshProviderID() },
      DEFAULT_CONFIG,
    )
    const body = body1308(RESET_A)
    handler(ev(body)) // first 1308: send attempted, not delivered
    await flush()
    expect(sent).toHaveLength(1)
    handler(ev(body)) // gate released → re-attempt, still failing
    await flush()
    expect(sent).toHaveLength(2)
    deliver = true
    handler(ev(body)) // released again → now delivered
    await flush()
    expect(sent).toHaveLength(3)
    handler(ev(body)) // delivered → gate holds → no fourth send
    await flush()
    expect(sent).toHaveLength(3)
  })

  test("an async rejection also releases the window", async () => {
    const sent: Notification[] = []
    let reject = true
    const handler = zhipuaiCodingPlan.createHandler(
      {
        now: () => NOW,
        send: (n) => {
          sent.push(n)
          return reject ? Promise.reject(new Error("rpc down")) : Promise.resolve(true)
        },
        logger: silentLogger,
        providerID: freshProviderID(),
      },
      DEFAULT_CONFIG,
    )
    const body = body1308(RESET_A)
    handler(ev(body))
    await flush()
    expect(sent).toHaveLength(1)
    reject = false
    handler(ev(body))
    await flush()
    expect(sent).toHaveLength(2)
    handler(ev(body))
    await flush()
    expect(sent).toHaveLength(2)
  })

  test("a sync-throwing sender releases the window and never breaks the decision", async () => {
    const sent: Notification[] = []
    let throwSync = true
    const handler = zhipuaiCodingPlan.createHandler(
      {
        now: () => NOW,
        send: (n) => {
          sent.push(n)
          if (throwSync) throw new Error("boom")
          return true
        },
        logger: silentLogger,
        providerID: freshProviderID(),
      },
      DEFAULT_CONFIG,
    )
    const event = ev(body1308(RESET_A))
    expect(() => handler(event)).not.toThrow()
    expect(event.decision.retry).toBe(true)
    await flush()
    expect(sent).toHaveLength(1)
    throwSync = false
    handler(ev(body1308(RESET_A)))
    await flush()
    expect(sent).toHaveLength(2)
  })

  test("tracks scheduled quota waits via deps.track", () => {
    const providerID = freshProviderID()
    const tracked: Array<[string, { code: string; resetRaw: string; delayMs: number; providerID: string; recoveredNotification?: Notification }]> = []
    const handler = zhipuaiCodingPlan.createHandler(
      {
        now: () => NOW,
        send: () => true,
        logger: silentLogger,
        providerID,
        track: (sessionID, wait) =>
          tracked.push([sessionID, { code: wait.code, resetRaw: wait.resetRaw, delayMs: wait.delayMs, providerID: wait.providerID, recoveredNotification: wait.recoveredNotification }]),
      },
      DEFAULT_CONFIG,
    )
    handler(ev(body1308(RESET_A)))
    expect(tracked).toHaveLength(1)
    expect(tracked[0]![0]).toBe("ses_1")
    expect(tracked[0]![1].code).toBe("1308")
    expect(tracked[0]![1].resetRaw).toBe(RESET_A)
    expect(tracked[0]![1].delayMs).toBeGreaterThan(0)
    // The wait record names its provider: the host's recovery-notification
    // dedup is keyed per provider, shared across location instances.
    expect(tracked[0]![1].providerID).toBe(providerID)
    // The recovery notification rides along for the tracker to fire on the
    // session's next successful turn.
    expect(tracked[0]![1].recoveredNotification?.title).toContain("已恢復")
    expect(tracked[0]![1].recoveredNotification?.message).toContain(RESET_A)
    expect(tracked[0]![1].recoveredNotification?.priority).toBe(3)
  })

  test("notify:false tracks without a recovery notification", () => {
    const tracked: Array<{ recoveredNotification?: Notification }> = []
    const handler = zhipuaiCodingPlan.createHandler(
      {
        now: () => NOW,
        send: () => true,
        logger: silentLogger,
        providerID: freshProviderID(),
        track: (_sessionID, wait) => tracked.push({ recoveredNotification: wait.recoveredNotification }),
      },
      { ...DEFAULT_CONFIG, notify: false },
    )
    handler(ev(body1308(RESET_A)))
    expect(tracked[0]!.recoveredNotification).toBeUndefined()
  })
})
