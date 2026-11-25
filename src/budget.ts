// Retry-budget arithmetic, provider-agnostic.
//
// OpenCode's built-in retry policy (core src/model-retry.ts) schedules at
// most MAX_RETRIES retries after the initial attempt (Schedule.recurs(10)),
// and the session retry hook fires with the *upcoming* attempt number: the
// first failure produces attempt=2, the last schedulable retry attempt=11,
// and once the budget is spent the hook no longer fires at all.
//
// Therefore, when the hook sees attempt = A, the number of retry decisions
// still schedulable — including the one being made right now — is
// (MAX_RETRIES + 2 - A).

import type { QuotaConfig } from "./types.ts"

/** OpenCode's built-in retry count (Schedule.recurs(10)); a hard ceiling a plugin cannot raise. */
export const MAX_RETRIES = 10

/** Retry decisions still schedulable when the hook sees `attempt`, including the current one. */
export function decisionsRemaining(attempt: number): number {
  return MAX_RETRIES + 2 - attempt
}

/**
 * How many waiting segments may still be scheduled for a quota error seen at
 * `attempt`: the remaining decisions minus the reserve kept for real retries
 * after the reset (guards against post-reset network trouble), capped at the
 * configured segment budget. Zero means waiting is no longer allowed.
 */
export function segmentsAvailable(attempt: number, quota: QuotaConfig): number {
  const usable = decisionsRemaining(attempt) - quota.reserve
  return Math.max(0, Math.min(quota.waitSegments, usable))
}

/**
 * Proportional segment pacing: split the time until the reset evenly over the
 * segments still available, clamped to [minSegmentMs, maxSegmentMs]. A reset
 * time already in the past clamps to the minimum so the session keeps probing.
 */
export function segmentDelay(remainingMs: number, segments: number, quota: QuotaConfig): number {
  if (segments <= 0) return 0
  const raw = Math.ceil(remainingMs / segments)
  return Math.min(quota.maxSegmentMs, Math.max(quota.minSegmentMs, raw))
}

/** The longest window the given waiting segments can cover. */
export function maxSpanMs(segments: number, quota: QuotaConfig): number {
  return segments * quota.maxSegmentMs
}
