import { describe, test, expect } from "bun:test"
import { RateLimitBackoff, sharedRateLimitBackoff } from "../src/ratelimit.ts"
import type { RateLimitConfig } from "../src/types.ts"

const CFG: RateLimitConfig = { baseMs: 30_000, maxMs: 600_000, decayAfterMs: 600_000 }
const NOW = Date.UTC(2026, 10, 25, 10, 0, 0)

describe("RateLimitBackoff", () => {
  test("doubles from the base on every consecutive rate limit", () => {
    const backoff = new RateLimitBackoff(CFG)
    let now = NOW
    expect(backoff.next(now).delayMs).toBe(30_000)
    now += 1_000
    expect(backoff.next(now).delayMs).toBe(60_000)
    now += 1_000
    expect(backoff.next(now).delayMs).toBe(120_000)
    now += 1_000
    expect(backoff.next(now).delayMs).toBe(240_000)
  })

  test("caps the delay at maxMs", () => {
    const backoff = new RateLimitBackoff(CFG)
    let now = NOW
    const seen: number[] = []
    for (let i = 0; i < 10; i++) {
      seen.push(backoff.next(now).delayMs)
      now += 1_000
    }
    expect(seen).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000, 600_000, 600_000])
  })

  test("a quiet period longer than decayAfterMs resets to the base", () => {
    const backoff = new RateLimitBackoff(CFG)
    let now = NOW
    expect(backoff.next(now).delayMs).toBe(30_000)
    expect(backoff.next(now + 1_000).delayMs).toBe(60_000)
    expect(backoff.next(now + 2_000).delayMs).toBe(120_000)
    // 10 minutes of silence (>= decayAfterMs): the provider is no longer
    // limiting — restart from the base.
    expect(backoff.next(now + 2_000 + 600_000).delayMs).toBe(30_000)
  })

  test("a gap shorter than decayAfterMs keeps growing", () => {
    const backoff = new RateLimitBackoff(CFG)
    let now = NOW
    expect(backoff.next(now).delayMs).toBe(30_000)
    expect(backoff.next(now + 599_999).delayMs).toBe(60_000)
  })

  test("reports the backoff level alongside the delay", () => {
    const backoff = new RateLimitBackoff(CFG)
    let now = NOW
    expect(backoff.next(now)).toEqual({ delayMs: 30_000, level: 0 })
    expect(backoff.next(now + 1_000)).toEqual({ delayMs: 60_000, level: 1 })
  })

  test("the level keeps counting while the delay stays capped", () => {
    const backoff = new RateLimitBackoff({ baseMs: 30_000, maxMs: 60_000, decayAfterMs: 600_000 })
    let now = NOW
    const results: Array<{ delayMs: number; level: number }> = []
    for (let i = 0; i < 8; i++) {
      results.push(backoff.next(now))
      now += 1_000
    }
    expect(results.map((r) => r.delayMs)).toEqual([30_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000])
    expect(results.map((r) => r.level)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })
})

describe("sharedRateLimitBackoff", () => {
  test("the same providerID shares one backoff across handler instances", () => {
    // Simulates two plugin handler instances (one per location) serving
    // different sessions of the same provider: the level must be shared.
    const a = sharedRateLimitBackoff("test-shared-provider", CFG)
    const b = sharedRateLimitBackoff("test-shared-provider", CFG)
    expect(a).toBe(b)
    let now = NOW
    expect(a.next(now).delayMs).toBe(30_000)
    expect(b.next(now + 1_000).delayMs).toBe(60_000)
    expect(a.next(now + 2_000).delayMs).toBe(120_000)
  })

  test("different providers keep independent backoffs", () => {
    const a = sharedRateLimitBackoff("test-shared-provider-a", CFG)
    const b = sharedRateLimitBackoff("test-shared-provider-b", CFG)
    expect(a).not.toBe(b)
    let now = NOW
    expect(a.next(now).delayMs).toBe(30_000)
    expect(b.next(now + 1_000).delayMs).toBe(30_000)
  })
})
