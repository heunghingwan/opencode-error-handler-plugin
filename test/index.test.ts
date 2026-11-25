import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import pluginDefault, { createHookHandler, createRecoveryTracker } from "../src/index.ts"
import { providerRegistry } from "../src/registry.ts"
import { resetRateLimitBackoffs } from "../src/ratelimit.ts"
import type { Notification } from "../src/notify.ts"
import type { ProviderConfig, RetryEvent } from "../src/types.ts"

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

// Fixed clock: 2026-11-25 10:00:00 UTC.
const NOW = Date.UTC(2026, 10, 25, 10, 0, 0)
const RESET_A = "2026-11-25 20:10:12"

const body = (code: string, message: string) => JSON.stringify({ error: { code, message } })
const body1308 = body("1308", `已达到 5 小时的使用上限。您的限额将在 ${RESET_A} 重置。`)

function ev(providerID: string, b: string | undefined, opts: Partial<RetryEvent> = {}): RetryEvent {
  return {
    sessionID: "ses_1",
    agent: "build",
    model: { providerID, id: "glm-5.3" },
    error: {
      type: "provider.rate-limit",
      message: "provider rate limited",
      status: 429,
      ...(b === undefined ? {} : { response: { body: b } }),
    },
    attempt: 2,
    decision: { retry: true, delay: 4000 },
    ...opts,
  }
}

const ZHIPUAI: ProviderConfig = providerRegistry["zhipuai-coding-plan"]!.defaultConfig

describe("createHookHandler", () => {
  // The rate-limit backoff is a process-global keyed by providerID — reset
  // it between tests so each sees a fresh sequence.
  beforeEach(() => resetRateLimitBackoffs())

  test("dispatches by providerID and applies the provider decision", () => {
    const sent: Notification[] = []
    const handler = createHookHandler({
      config: { providers: { "zhipuai-coding-plan": ZHIPUAI } },
      now: () => NOW,
      send: (n) => { sent.push(n); return true },
      logger: silentLogger,
    })
    const event = ev("zhipuai-coding-plan", body("1302", "您的账户已达到速率限制"))
    handler(event)
    expect(event.decision).toEqual({ retry: true, delay: 30_000 })
  })

  test("unknown provider → decision untouched, no notification", () => {
    const sent: Notification[] = []
    const handler = createHookHandler({
      config: { providers: { "zhipuai-coding-plan": ZHIPUAI } },
      now: () => NOW,
      send: (n) => { sent.push(n); return true },
      logger: silentLogger,
    })
    const event = ev("anthropic", body("1302", "rate limited"))
    const original = event.decision
    handler(event)
    expect(event.decision).toBe(original)
    expect(sent).toBeEmpty()
  })

  test("provider disabled in config → decision untouched", () => {
    const handler = createHookHandler({
      config: { providers: {} },
      now: () => NOW,
      send: () => false,
      logger: silentLogger,
    })
    const event = ev("zhipuai-coding-plan", body1308)
    const original = event.decision
    handler(event)
    expect(event.decision).toBe(original)
  })

  test("handler exception is contained: decision untouched, hook never throws", () => {
    // Corrupt an entry's handler factory; the wrapper must protect the wiring.
    const sent: Notification[] = []
    const saved = providerRegistry["zhipuai-coding-plan"]
    providerRegistry["zhipuai-coding-plan"] = {
      ...saved!,
      createHandler: () => {
        throw new Error("provider bug")
      },
    }
    try {
      const handler = createHookHandler({
        config: { providers: { "zhipuai-coding-plan": ZHIPUAI } },
        now: () => NOW,
        send: (n) => { sent.push(n); return true },
        logger: silentLogger,
      })
      const event = ev("zhipuai-coding-plan", body1308)
      const original = event.decision
      expect(() => handler(event)).not.toThrow()
      expect(event.decision).toBe(original)
    } finally {
      providerRegistry["zhipuai-coding-plan"] = saved!
    }
  })

  test("per-event handler exception is contained: decision untouched", () => {
    const sent: Notification[] = []
    const saved = providerRegistry["zhipuai-coding-plan"]
    providerRegistry["zhipuai-coding-plan"] = {
      ...saved!,
      createHandler: () => {
        return () => {
          throw new Error("provider bug mid-flight")
        }
      },
    }
    try {
      const handler = createHookHandler({
        config: { providers: { "zhipuai-coding-plan": ZHIPUAI } },
        now: () => NOW,
        send: (n) => { sent.push(n); return true },
        logger: silentLogger,
      })
      const event = ev("zhipuai-coding-plan", body1308)
      const original = event.decision
      expect(() => handler(event)).not.toThrow()
      expect(event.decision).toBe(original)
    } finally {
      providerRegistry["zhipuai-coding-plan"] = saved!
    }
  })
})

describe("Plugin.define wiring", () => {
  let home: string
  let prevHome: string | undefined
  let prevLog: string | undefined

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ehp-index-"))
    fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true })
    prevHome = process.env.HOME
    process.env.HOME = home
    // Keep test runs out of the real plugin log.
    prevLog = process.env.ERROR_HANDLER_LOG
    process.env.ERROR_HANDLER_LOG = path.join(home, "error-handler.log")
    resetRateLimitBackoffs()
  })

  afterEach(() => {
    process.env.HOME = prevHome
    if (prevLog === undefined) delete process.env.ERROR_HANDLER_LOG
    else process.env.ERROR_HANDLER_LOG = prevLog
    fs.rmSync(home, { recursive: true, force: true })
  })

  interface Registered {
    name: string
    callback: (event: RetryEvent) => Promise<void> | void
    options?: { providerID?: string }
  }

  function fakeCtx(rpcNotify: (n: Notification) => void) {
    const registrations: Registered[] = []
    return {
      ctx: {
        session: {
          hook: async (name: string, callback: (event: RetryEvent) => Promise<void> | void, options?: { providerID?: string }) => {
            registrations.push({ name, callback, options })
            return { dispose: () => {} }
          },
        },
        rpc: () => ({ notify: (n: Notification) => rpcNotify(n) }),
        location: { directory: home },
      },
      registrations,
    }
  }

  test("setup registers exactly one unfiltered retry hook", async () => {
    const { ctx, registrations } = fakeCtx(() => {})
    await pluginDefault.setup(ctx as never)
    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.name).toBe("retry")
    expect(registrations[0]?.options?.providerID).toBeUndefined()
  })

  test("end-to-end through setup: zhipuai 1302 decision + notification flow intact", async () => {
    const sent: Notification[] = []
    const { ctx, registrations } = fakeCtx((n) => void sent.push(n))
    // No config file → defaults → zhipuai enabled, notify on.
    await pluginDefault.setup(ctx as never)
    const hook = registrations[0]!.callback

    const event = ev("zhipuai-coding-plan", body("1302", "您的账户已达到速率限制"))
    await hook(event)
    expect(event.decision).toEqual({ retry: true, delay: 30_000 })

    const untouched = ev("anthropic", body1308)
    await hook(untouched)
    expect(untouched.decision).toEqual({ retry: true, delay: 4000 })
  })

  test("config file can disable the provider", async () => {
    fs.writeFileSync(
      path.join(home, ".config", "opencode", "error-handler.json"),
      JSON.stringify({ providers: {} }),
    )
    const { ctx, registrations } = fakeCtx(() => {})
    await pluginDefault.setup(ctx as never)
    const hook = registrations[0]!.callback
    const event = ev("zhipuai-coding-plan", body1308)
    const original = event.decision
    await hook(event)
    expect(event.decision).toBe(original)
  })
})

describe("createRecoveryTracker", () => {
  const NOW = Date.UTC(2026, 10, 26, 2, 0, 0)
  const wait = { code: "1308", resetAt: NOW + 3_600_000, resetRaw: "2026-11-26 11:00:00", delayMs: 600_000, segments: 6 }
  const logs: Array<{ level: string; msg: string; extra?: Record<string, unknown> }> = []
  const logger = {
    debug: (msg: string, extra?: Record<string, unknown>) => logs.push({ level: "debug", msg, extra }),
    info: (msg: string, extra?: Record<string, unknown>) => logs.push({ level: "info", msg, extra }),
    warn: (msg: string, extra?: Record<string, unknown>) => logs.push({ level: "warn", msg, extra }),
    error: (msg: string, extra?: Record<string, unknown>) => logs.push({ level: "error", msg, extra }),
  }
  let now = NOW
  const tracker = createRecoveryTracker(() => now, logger)

  beforeEach(() => {
    logs.length = 0
    now = NOW
  })

  test("logs recovery when the session's next turn succeeds", () => {
    tracker.track("ses_1", wait)
    tracker.handleEvent({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } })
    expect(logs.some((l) => l.msg === "quota recovered — session resumed")).toBe(true)
    // tracked once: a later succeeded event does not re-log
    logs.length = 0
    tracker.handleEvent({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } })
    expect(logs).toHaveLength(0)
  })

  test("a failed turn keeps watching; a later success still counts", () => {
    tracker.track("ses_2", wait)
    now += 60_000
    tracker.handleEvent({ type: "session.execution.failed", data: { sessionID: "ses_2" } })
    expect(logs.some((l) => l.msg === "turn still failing after quota wait")).toBe(true)
    now += 60_000
    tracker.handleEvent({ type: "session.execution.succeeded", data: { sessionID: "ses_2" } })
    expect(logs.some((l) => l.msg === "quota recovered — session resumed")).toBe(true)
  })

  test("waits include the elapsed time since the first 1308", () => {
    tracker.track("ses_3", wait)
    now += 7_200_000
    tracker.handleEvent({ type: "session.execution.succeeded", data: { sessionID: "ses_3" } })
    const entry = logs.find((l) => l.msg === "quota recovered — session resumed")
    expect(entry?.extra?.waitedMs).toBe(7_200_000)
  })

  test("session.deleted clears the wait silently", () => {
    tracker.track("ses_4", wait)
    tracker.handleEvent({ type: "session.deleted", data: { sessionID: "ses_4" } })
    tracker.handleEvent({ type: "session.execution.succeeded", data: { sessionID: "ses_4" } })
    expect(logs).toHaveLength(0)
  })

  test("untracked sessions are ignored", () => {
    tracker.handleEvent({ type: "session.execution.succeeded", data: { sessionID: "ses_unknown" } })
    expect(logs).toHaveLength(0)
  })
})

describe("createHookHandler threads track into provider deps", () => {
  test("a scheduled wait is reported through HookDeps.track", () => {
    const tracked: string[] = []
    const body1308 = JSON.stringify({
      error: { code: "1308", message: "已达到 5 小时的使用上限。您的限额将在 2026-11-25 20:10:12 重置。" },
    })
    const handler = createHookHandler({
      config: { providers: { "zhipuai-coding-plan": ZHIPUAI } },
      now: () => Date.UTC(2026, 10, 25, 10, 0, 0),
      send: () => true,
      logger: silentLogger,
      track: (sessionID) => tracked.push(sessionID),
    })
    handler(ev("zhipuai-coding-plan", body1308))
    expect(tracked).toEqual(["ses_1"])
  })
})
