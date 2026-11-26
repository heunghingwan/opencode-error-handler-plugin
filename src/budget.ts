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
 * Landing slack: the LAST waiting segment deliberately lands this far PAST
 * the claimed reset time. Seconds-level clock skew (local clock ahead of the
 * server) then still meets an already-reset quota on the first probe — the
 * fast recovery path — while larger skew is absorbed by the provider
 * handler's reserve probes: aggregate tolerance is this slack plus
 * `reserve × minSegmentMs` of one-minute probes.
 */
const LANDING_SLACK_MS = 60_000

/**
 * Proportional segment pacing: split the time until the reset evenly over the
 * segments still available, clamped to [minSegmentMs, maxSegmentMs]. A reset
 * time already in the past clamps to the minimum so the session keeps probing.
 * The final segment (segments === 1) lands LANDING_SLACK_MS past a still-ahead
 * reset; an already-past reset takes no slack. `first` (the session's first
 * wait in this window) caps the share at firstSegmentMs — the reset-card fast
 * recovery probe — but never the final landing segment, which must not be
 * split (splitting it can give up before the reset lands).
 */
export function segmentDelay(remainingMs: number, segments: number, quota: QuotaConfig, first = false): number {
  if (segments <= 0) return 0
  let raw = Math.ceil(remainingMs / segments)
  if (first && segments >= 2) raw = Math.min(quota.firstSegmentMs, raw)
  const clamped = Math.min(quota.maxSegmentMs, Math.max(quota.minSegmentMs, raw))
  return segments === 1 && remainingMs > 0 ? clamped + LANDING_SLACK_MS : clamped
}

/** The longest window the given waiting segments can cover (first-aware:
 * the window-entry wait starts with the short first-probe cap). */
export function maxSpanMs(segments: number, quota: QuotaConfig, first = false): number {
  return first && segments >= 2
    ? quota.firstSegmentMs + (segments - 1) * quota.maxSegmentMs
    : segments * quota.maxSegmentMs
}

/**
 * Remembers which (session × reset window) keys have already had their first
 * wait, so only the first wait of a window gets the firstSegmentMs cap.
 * Bounded like the notify gate: entries whose reset passed more than an hour
 * ago are pruned on insert, and the oldest keys are FIFO-evicted past the
 * cap, so a long-lived server never grows the map without limit.
 */
export class FirstWaitRegistry {
  readonly #seen = new Map<string, number>() // key → reset epoch
  readonly #cap: number
  /** A window is stale once its reset is this far in the past. */
  readonly #staleMs = 3_600_000

  constructor(cap = 256) {
    this.#cap = Math.max(1, cap)
  }

  /** Records `key` and returns true if this is its first sighting. */
  isFirst(key: string, expiresAt: number, now: number): boolean {
    if (this.#seen.has(key)) return false
    this.#seen.set(key, expiresAt)
    for (const [k, expires] of this.#seen) {
      if (expires < now - this.#staleMs) this.#seen.delete(k)
    }
    if (this.#seen.size > this.#cap) {
      const overflow = this.#seen.size - this.#cap
      let evicted = 0
      for (const oldest of this.#seen.keys()) {
        if (evicted >= overflow) break
        this.#seen.delete(oldest)
        evicted++
      }
    }
    return true
  }
}
