// Provider-wide rate-limit backoff, provider-agnostic.
//
// A 429 "too many requests" — zhipuai code 1302 (the account's per-model
// concurrency cap) or 1305 (platform overload; both advices at
// docs.bigmodel.cn/cn/api/rate-limit amount to "space out requests to this
// model") — is enforced against the ACCOUNT's per-MODEL request rate:
// N parallel sessions each waiting a fixed delay still send N requests per
// interval and stay limited. The backoff level therefore lives OUTSIDE the
// session — in a process-global registry keyed by provider+model — so every
// rate-limit-family code seen by any session (or any per-location handler
// instance) of the same provider AND model grows one shared sequence and
// the aggregate request rate actually slows down, while a limited glm-5.3
// never slows glm-5.3-flash.
//
// The default curve is deliberately gentle (factor 1.5): agents spend most
// of their wall-clock running tools, which already spaces requests apart,
// so escalation only needs to punish SUSTAINED limiting — a tight loop
// hammering the API with no tool time — not an unlucky burst of parallel
// sessions.
//
// OpenCode loads a plugin module once per server process (plain dynamic
// import), so module scope IS process scope; per-location plugin instances
// all reach the same registry here. A plugin reload re-evaluates the module
// and restarts the sequence at the base — harmless (a reload is rare and the
// provider state is transient).

import type { RateLimitConfig } from "./types.ts"

/** Result of one rate-limit event: the delay to schedule and the level reached. */
export interface BackoffDecision {
  readonly delayMs: number
  readonly level: number
}

/**
 * Exponential backoff for consecutive rate-limit events.
 *
 * Every `next()` call — one per rate-limited request, from any session —
 * multiplies the delay by `factor` starting from `baseMs`, clamped to
 * `maxMs`. A quiet period of at least `decayAfterMs` (no rate limits at
 * all) resets the sequence to the base: the provider was demonstrably not
 * limiting anymore.
 */
export class RateLimitBackoff {
  readonly #config: RateLimitConfig
  #level = 0
  #lastAt: number | undefined

  constructor(config: RateLimitConfig) {
    this.#config = config
  }

  next(now: number): BackoffDecision {
    if (this.#lastAt !== undefined && now - this.#lastAt >= this.#config.decayAfterMs) {
      this.#level = 0
    }
    const raw = Math.min(this.#config.baseMs * this.#config.factor ** this.#level, this.#config.maxMs)
    // Second granularity keeps schedules and logs readable; a sub-second
    // result (pathological tiny config) still waits at least one second.
    const delayMs = Math.max(1_000, Math.round(raw / 1_000) * 1_000)
    const level = this.#level
    // The level keeps counting (bounded so factor**level stays exact); the
    // delay itself is clamped by maxMs above.
    this.#level = Math.min(this.#level + 1, 53)
    this.#lastAt = now
    return { delayMs, level }
  }
}

const shared = new Map<string, RateLimitBackoff>()

/**
 * The registry key for one provider+model pair. Zhipu's 1302 is the
 * account's per-MODEL concurrency cap ("当前模型的并发请求数已达到账户上
 * 限" — docs.bigmodel.cn/cn/api/rate-limit), so the sequence is shared by
 * every session of the same model and independent per model.
 */
export function rateLimitKey(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`
}

/**
 * The process-global backoff for one provider+model. Handler instances (one
 * per active location) for the same key share a single sequence — that
 * sharing is the feature, see the module comment. The config of the first
 * creation wins; later instances read the same config file, so they agree.
 */
export function sharedRateLimitBackoff(key: string, config: RateLimitConfig): RateLimitBackoff {
  let backoff = shared.get(key)
  if (backoff === undefined) {
    backoff = new RateLimitBackoff(config)
    shared.set(key, backoff)
  }
  return backoff
}

/** Test hook: clears the shared registry. Production code never resets. */
export function resetRateLimitBackoffs(): void {
  shared.clear()
}
