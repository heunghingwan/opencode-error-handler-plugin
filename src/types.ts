// Shared types across the plugin. The retry-event shape mirrors
// @opencode/plugin's SessionRetry (promise layer) structurally, but stays
// loose (unbranded strings) so the pure logic and tests never import the
// plugin package.

import type { Logger } from "./logger.ts"
import type { NotifySender } from "./notify.ts"

export interface RetryError {
  readonly type: string
  readonly message: string
  readonly status?: number
  readonly response?: { readonly body: string }
  readonly retryAfterMs?: number
}

export type RetryDecision = { retry: false } | { retry: true; delay: number }

export interface RetryEvent {
  readonly sessionID: string
  readonly agent: string
  readonly model: { readonly providerID: string; readonly id: string; readonly variant?: string }
  readonly error: RetryError
  readonly attempt: number
  decision: RetryDecision
}

/** Per-provider quota-wait tuning. */
export interface QuotaConfig {
  /** How many retry decisions may be spent on waiting segments. */
  waitSegments: number
  /** Retry decisions kept back for real retries after the reset. */
  reserve: number
  /** Lower bound for one waiting segment. */
  minSegmentMs: number
  /** Upper bound for one waiting segment. */
  maxSegmentMs: number
}

/** Per-provider rate-limit ("too many requests") exponential backoff tuning. */
export interface RateLimitConfig {
  /** Delay for the first rate-limited request (level 0). */
  baseMs: number
  /** Ceiling of the exponential sequence. */
  maxMs: number
  /** Quiet period (no rate limits at all) after which the sequence resets to baseMs. */
  decayAfterMs: number
  /**
   * Multiplier per consecutive rate-limited request (>= 1). Agents spend
   * most of their time running tools — a natural spacing — so the default
   * (1.5) escalates gently and only sustained hammering climbs to maxMs.
   * 2 restores classic doubling.
   */
  factor: number
}

/** Per-provider resolved configuration. */
export interface ProviderConfig {
  enabled: boolean
  /** Push notifications for this provider's actionable errors. */
  notify: boolean
  quota: QuotaConfig
  rateLimit: RateLimitConfig
}

// The provider contract: one file per provider under src/providers/, exported
// through src/registry.ts. Adding a provider = adding one file + one registry
// line; nothing else changes.

/** Details of a quota wait scheduled for a session, reported to the host. */
export interface WaitScheduled {
  readonly code: string
  /** Parsed reset time as epoch ms. */
  readonly resetAt: number
  /** Verbatim reset timestamp — the window's identity. */
  readonly resetRaw: string
  readonly delayMs: number
  readonly segments: number
}

/** Dependencies a provider handler runs against (injected for tests). */
export interface HandlerDeps {
  now(): number
  send: NotifySender
  logger: Logger
  /**
   * The providerID this handler was registered under. Rate-limit backoff
   * state is shared process-wide per provider (see src/ratelimit.ts), and
   * this key is what makes instances for different locations of the same
   * provider share one sequence.
   */
  providerID: string
  /** Called when the provider schedules a quota wait for a session. The
   *  host uses it to log and to watch for recovery (retries that succeed
   *  leave no trace in OpenCode's database, so the plugin tracks them). */
  track?(sessionID: string, wait: WaitScheduled): void
}

/** A registered provider: its defaults plus its handler factory. */
export interface ProviderEntry {
  defaultConfig: ProviderConfig
  createHandler(deps: HandlerDeps, config: ProviderConfig): ProviderHandler
}

/**
 * Handles one session.retry event: may rewrite `event.decision`; must never
 * throw (the hook wrapper guards anyway) and must leave `decision` untouched
 * whenever it has no provider-specific opinion.
 */
export type ProviderHandler = (event: RetryEvent) => void
