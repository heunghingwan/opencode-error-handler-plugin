import { describe, test, expect } from "bun:test"
import { DEFAULT_CONFIG, zhipuaiCodingPlan } from "../src/providers/zhipuai-coding-plan.ts"
import type { Notification, NotifySender } from "../src/notify.ts"
import type { ProviderConfig, RetryEvent } from "../src/types.ts"

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
}

function harness(config: Partial<ProviderConfig> = {}, now: number = NOW): Harness {
  const sent: Notification[] = []
  const send: NotifySender = (n) => {
    sent.push(n)
  }
  const cfg: ProviderConfig = {
    enabled: config.enabled ?? DEFAULT_CONFIG.enabled,
    notify: config.notify ?? DEFAULT_CONFIG.notify,
    quota: { ...DEFAULT_CONFIG.quota, ...config.quota },
  }
  const handler = zhipuaiCodingPlan.createHandler(
    { now: () => now, send, logger: silentLogger },
    cfg,
  )
  return { sent, handle: handler, now }
}

describe("decision table", () => {
  test("1302 → retry after 30s, at any attempt", () => {
    for (const attempt of [2, 5, 11]) {
      const h = harness()
      const event = ev(JSON.stringify({ error: { code: "1302", message: "您的账户已达到速率限制，请您控制请求频率" } }), { attempt })
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
      { now: () => now, send: (n) => void sent.push(n), logger: silentLogger },
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
  })
})
