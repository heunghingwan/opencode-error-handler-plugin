// OpenCode v2 plugin: per-provider retry-error handling.
//
// Registers one unfiltered session.retry hook and dispatches by
// event.model.providerID through the provider registry. Providers own their
// error classification, retry decisions, and notifications (via the
// remote-notifier plugin's RPC, called loosely and silently degrading until
// that RPC ships).

import { Plugin } from "@opencode/plugin"
import { readConfigFile, resolveConfig } from "./config.ts"
import { createLogger, type Logger } from "./logger.ts"
import { createRpcSender, type Notification } from "./notify.ts"
import { providerRegistry } from "./registry.ts"
import type { ProviderConfig, ProviderHandler, RetryEvent } from "./types.ts"

export interface HookDeps {
  config: { readonly providers: Record<string, ProviderConfig> }
  now(): number
  send: (n: Notification) => Promise<void> | void
  logger: Logger
}

/**
 * Builds the retry-hook callback: per-provider dispatch, enabled-only, with
 * provider bugs contained (logged, decision left to the built-in policy).
 * A plugin exception must never break OpenCode's retry decision path.
 */
export function createHookHandler(deps: HookDeps): (event: RetryEvent) => void {
  const handlers = new Map<string, ProviderHandler>()
  for (const [id, entry] of Object.entries(providerRegistry)) {
    const cfg = deps.config.providers[id]
    if (!cfg?.enabled) continue
    try {
      handlers.set(id, entry.createHandler({ now: deps.now, send: deps.send, logger: deps.logger }, cfg))
    } catch (err) {
      deps.logger.error("provider handler construction failed, provider skipped", {
        providerID: id,
        error: String(err),
      })
    }
  }

  return (event: RetryEvent) => {
    const handler = handlers.get(event.model.providerID)
    if (!handler) return // unknown or disabled provider: never intervene
    try {
      handler(event)
    } catch (err) {
      deps.logger.error("provider handler failed, leaving decision to built-in policy", {
        providerID: event.model.providerID,
        error: String(err),
      })
    }
  }
}

export default Plugin.define({
  id: "error-handler",
  setup(ctx) {
    const logger = createLogger()
    const file = readConfigFile(logger)
    const config = resolveConfig(providerRegistry, file, logger)
    const enabled = Object.entries(config.providers)
      .filter(([, cfg]) => cfg.enabled)
      .map(([id]) => id)
    logger.info("Plugin initialized", {
      enabledProviders: enabled,
      configLoaded: file !== null,
    })

    const hook = createHookHandler({
      config,
      now: () => Date.now(),
      send: createRpcSender(ctx.rpc, logger),
      logger,
    })

    const registration = ctx.session.hook("retry", (event) => {
      hook(event)
    })

    return async () => {
      const reg = await registration
      await reg.dispose()
    }
  },
})
