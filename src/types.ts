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

/** Per-provider resolved configuration. */
export interface ProviderConfig {
  enabled: boolean
  /** Push notifications for this provider's actionable errors. */
  notify: boolean
  quota: QuotaConfig
}

// The provider contract: one file per provider under src/providers/, exported
// through src/registry.ts. Adding a provider = adding one file + one registry
// line; nothing else changes.

/** Dependencies a provider handler runs against (injected for tests). */
export interface HandlerDeps {
  now(): number
  send: NotifySender
  logger: Logger
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
