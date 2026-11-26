import { describe, test, expect } from "bun:test"
import { MAX_RETRIES, decisionsRemaining, maxSpanMs, segmentDelay, segmentsAvailable } from "../src/budget.ts"
import type { QuotaConfig } from "../src/types.ts"

// OpenCode's built-in retry policy (core model-retry.ts): Schedule.recurs(10)
// — at most 10 retries after the initial attempt. Hook events carry the
// upcoming attempt number, so attempt spans 2..11 and "12 - attempt" is the
// number of retry decisions still schedulable, including the current one.
const QUOTA: QuotaConfig = { waitSegments: 7, reserve: 3, minSegmentMs: 60_000, maxSegmentMs: 2_700_000 }

describe("segmentsAvailable", () => {
  test("matches OpenCode's 10-retry budget arithmetic on default config", () => {
    // attempt 2 (first failure): 12-2-3 = 7 segments, capped at waitSegments=7
    expect(segmentsAvailable(2, QUOTA)).toBe(7)
    expect(segmentsAvailable(5, QUOTA)).toBe(4)
    // attempt 8 is the last attempt allowed to schedule a waiting segment
    expect(segmentsAvailable(8, QUOTA)).toBe(1)
    // attempt 9+ would eat the reserve → no waiting allowed
    expect(segmentsAvailable(9, QUOTA)).toBe(0)
    expect(segmentsAvailable(11, QUOTA)).toBe(0)
  })

  test("stays defensive outside the real attempt range", () => {
    expect(segmentsAvailable(1, QUOTA)).toBe(7)
    expect(segmentsAvailable(12, QUOTA)).toBe(0)
    expect(segmentsAvailable(-1, QUOTA)).toBe(7)
  })

  test("honours custom waitSegments/reserve", () => {
    const cfg = { ...QUOTA, waitSegments: 3, reserve: 5 }
    expect(segmentsAvailable(2, cfg)).toBe(3)
    expect(segmentsAvailable(6, cfg)).toBe(1)
    expect(segmentsAvailable(7, cfg)).toBe(0)
  })
})

describe("decisionsRemaining", () => {
  test("counts schedulable decisions including the current one (attempt 2..11)", () => {
    // First failure → attempt 2 → all 10 decisions remain.
    expect(decisionsRemaining(2)).toBe(10)
    // attempt 11 is the final schedulable decision (the last probe).
    expect(decisionsRemaining(11)).toBe(1)
  })
})

describe("segmentDelay", () => {
  test("proportional pacing: remaining time split evenly over segments", () => {
    // 5h window (1308's quota period), 7 segments → 18000000/7
    expect(segmentDelay(18_000_000, 7, QUOTA)).toBe(2_571_429)
  })

  test("keeps the same delay as the window shrinks (stateless recompute)", () => {
    // After one 5h/7 segment, 6 segments remain for 6/7 of the window
    expect(segmentDelay(18_000_000 * 6 / 7, 6, QUOTA)).toBe(2_571_429)
  })

  test("clamps to minimum when the reset time has passed", () => {
    expect(segmentDelay(0, 7, QUOTA)).toBe(60_000)
    expect(segmentDelay(-3_600_000, 7, QUOTA)).toBe(60_000)
  })

  test("clamps to minimum when the proportional delay is tiny", () => {
    expect(segmentDelay(100_000, 7, QUOTA)).toBe(60_000)
  })

  test("clamps to maximum when a single segment would exceed the cap", () => {
    expect(segmentDelay(36_000_000, 7, QUOTA)).toBe(2_700_000)
    // The final segment rides the landing slack on top of the clamp.
    expect(segmentDelay(2_700_001, 1, QUOTA)).toBe(2_760_000)
  })

  test("the final wait segment (segments === 1) lands one minute past the reset", () => {
    // 40 minutes left, one segment (within the test's 45-min cap):
    // 40 min + 1 min landing slack — seconds-level clock skew then still
    // recovers on the first probe.
    expect(segmentDelay(40 * 60_000, 1, QUOTA)).toBe(41 * 60_000)
  })

  test("an already-past reset takes no landing slack", () => {
    expect(segmentDelay(0, 1, QUOTA)).toBe(60_000)
    expect(segmentDelay(-3_600_000, 1, QUOTA)).toBe(60_000)
  })

  test("non-final segments carry no landing slack", () => {
    // 2 minutes over two segments: 1 minute each — no slack anywhere.
    expect(segmentDelay(120_000, 2, QUOTA)).toBe(60_000)
  })

  test("returns 0 when no segments are available (caller must not call)", () => {
    expect(segmentDelay(1_000_000, 0, QUOTA)).toBe(0)
  })
})

describe("maxSpanMs", () => {
  test("is the longest window the waiting budget can cover", () => {
    expect(maxSpanMs(7, QUOTA)).toBe(18_900_000)
    expect(maxSpanMs(1, QUOTA)).toBe(2_700_000)
    expect(maxSpanMs(0, QUOTA)).toBe(0)
  })
})

test("MAX_RETRIES pins OpenCode's built-in retry budget", () => {
  expect(MAX_RETRIES).toBe(10)
})
