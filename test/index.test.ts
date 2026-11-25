import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import pluginDefault, { createHookHandler } from "../src/index.ts"
import { providerRegistry } from "../src/registry.ts"
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
  test("dispatches by providerID and applies the provider decision", () => {
    const sent: Notification[] = []
    const handler = createHookHandler({
      config: { providers: { "zhipuai-coding-plan": ZHIPUAI } },
      now: () => NOW,
      send: (n) => void sent.push(n),
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
      send: (n) => void sent.push(n),
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
      send: () => {},
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
        send: (n) => void sent.push(n),
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
        send: (n) => void sent.push(n),
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

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ehp-index-"))
    fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true })
    prevHome = process.env.HOME
    process.env.HOME = home
  })

  afterEach(() => {
    process.env.HOME = prevHome
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
