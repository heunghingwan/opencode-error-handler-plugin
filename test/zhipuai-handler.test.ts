import { describe, test, expect } from "bun:test"
import { DEFAULT_CONFIG, zhipuaiCodingPlan } from "../src/providers/zhipuai-coding-plan.ts"
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

  test("1305 → untouched, no notification", () => {
    const h = harness()
    const event = ev(JSON.stringify({ error: { code: "1305", message: "该模型当前访问量过大，请您稍后再试" } }))
    const original = event.decision
    h.handle(event)
    expect(event.decision).toBe(original)
    expect(h.sent).toBeEmpty()
  })

  test("1305 preset non-retryable stays non-retryable", () => {
    const h = harness()
    const event = ev(JSON.stringify({ error: { code: "1305", message: "该模型当前访问量过大" } }), {
      decision: { retry: false },
    })
    h.handle(event)
    expect(event.decision).toEqual({ retry: false })
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
  test("consecutive events double the delay from the base, capped", () => {
    const h = harness()
    const delays: number[] = []
    let attempt = 2
    for (let i = 0; i < 7; i++) {
      const event = ev(body1302(), { attempt })
      h.handle(event)
      delays.push((event.decision as { retry: true; delay: number }).delay)
      attempt++
    }
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000])
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
    expect(second.decision).toEqual({ retry: true, delay: 60_000 })
    const third = ev(body1302(), { sessionID: "ses_3" })
    a.handle(third)
    expect(third.decision).toEqual({ retry: true, delay: 120_000 })
  })

  test("the level decays back to the base after a quiet period", () => {
    let now = NOW
    const h = harness({}, now)
    let event = ev(body1302())
    h.handle(event)
    expect(event.decision).toEqual({ retry: true, delay: 30_000 })
    event = ev(body1302())
    h.handle(event)
    expect(event.decision).toEqual({ retry: true, delay: 60_000 })
    // 10 quiet minutes (decayAfterMs): the next 1302 restarts from the base.
    now += DEFAULT_CONFIG.rateLimit.decayAfterMs
    event = ev(body1302())
    const h2 = harness({}, now, h.providerID)
    h2.handle(event)
    expect(event.decision).toEqual({ retry: true, delay: 30_000 })
  })

  test("rateLimit config overrides the sequence (base and cap)", () => {
    const h = harness({ rateLimit: { baseMs: 5_000, maxMs: 20_000, decayAfterMs: 600_000 } })
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
  test("1308 at attempt 2: proportional delay, one notification", () => {
    const h = harness()
    const event = ev(body1308(RESET_A))
    h.handle(event)
    // 7,812,000 ms over 7 segments = 1,116,000 ms
    expect(event.decision).toEqual({ retry: true, delay: 1_116_000 })
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.title).toContain("1308")
    expect(h.sent[0]?.message).toContain(RESET_A)
    expect(h.sent[0]?.message).toContain("自動恢復")
    expect(h.sent[0]?.priority).toBe(4)
  })

  test("each event recomputes segments from its own attempt", () => {
    const h = harness()
    const event = ev(body1308(RESET_A), { attempt: 3 })
    h.handle(event)
    // 7,812,000 ms over 6 segments = 1,302,000 ms
    expect(event.decision).toEqual({ retry: true, delay: 1_302_000 })
  })

  test("other quota codes with reset times follow the same path", () => {
    const h = harness()
    const event = ev(body1316(RESET_A))
    h.handle(event)
    expect(event.decision).toEqual({ retry: true, delay: 1_116_000 })
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

  test("attempt 8 with a reachable reset still schedules the last segment", () => {
    const h = harness()
    // 40 minutes ahead, one segment left, span capacity 45 minutes
    const event = ev(body1308("2026-11-25 18:40:00"), { attempt: 8 })
    h.handle(event)
    expect(event.decision).toEqual({ retry: true, delay: 2_400_000 })
  })

  test("reset too far to span (weekly/monthly window): fail fast + terminal notify", () => {
    const h = harness()
    const event = ev(body1308("2099-06-01 12:00:00"))
    h.handle(event)
    expect(event.decision).toEqual({ retry: false })
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.message).toContain("2099-06-01 12:00:00")
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

describe("notification dedup", () => {
  test("one notification per reset window, decisions keep flowing", () => {
    const h = harness()
    h.handle(ev(body1308(RESET_A)))
    h.handle(ev(body1308(RESET_A), { attempt: 3 }))
    h.handle(ev(body1308(RESET_A), { attempt: 4 }))
    expect(h.sent).toHaveLength(1)
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
    expect(event.decision).toEqual({ retry: true, delay: 1_116_000 })
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
    expect(event.decision).toEqual({ retry: true, delay: 1_116_000 })
  })
})

test("DEFAULT_CONFIG ships zhipuai enabled with notifications", () => {
  expect(DEFAULT_CONFIG).toEqual({
    enabled: true,
    notify: true,
    quota: { waitSegments: 7, reserve: 3, minSegmentMs: 60_000, maxSegmentMs: 2_700_000 },
    rateLimit: { baseMs: 30_000, maxMs: 600_000, decayAfterMs: 600_000 },
  })
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
    const tracked: Array<[string, { code: string; resetRaw: string; delayMs: number }]> = []
    const handler = zhipuaiCodingPlan.createHandler(
      {
        now: () => NOW,
        send: () => true,
        logger: silentLogger,
        providerID: freshProviderID(),
        track: (sessionID, wait) => tracked.push([sessionID, wait]),
      },
      DEFAULT_CONFIG,
    )
    handler(ev(body1308(RESET_A)))
    expect(tracked).toHaveLength(1)
    expect(tracked[0]![0]).toBe("ses_1")
    expect(tracked[0]![1].code).toBe("1308")
    expect(tracked[0]![1].resetRaw).toBe(RESET_A)
    expect(tracked[0]![1].delayMs).toBeGreaterThan(0)
  })
})
