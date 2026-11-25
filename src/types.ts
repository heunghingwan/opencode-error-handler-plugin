// Shared types across the plugin. The retry-event shape mirrors
// @opencode/plugin's SessionRetry (promise layer) structurally, but stays
// loose (unbranded strings) so the pure logic and tests never import the
// plugin package.

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
