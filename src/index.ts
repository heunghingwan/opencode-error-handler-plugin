// OpenCode v2 plugin: per-provider retry-error handling.
//
// Registers one unfiltered session.retry hook and dispatches by
// event.model.providerID through the provider registry. Providers own their
// error classification, retry decisions, and notifications (via the
// remote-notifier plugin's RPC, called loosely and silently degrading until
// that RPC ships).
//
// Decisions and recoveries are logged to the plugin's own JSONL file next to
// opencode.log: OpenCode exposes no plugin log API and discards plugin
// console output under the background service, while recovered retries leave
// no database trace — the file is the only audit record.

import { Plugin } from "@opencode/plugin"
import { readConfigFile, resolveConfig } from "./config.ts"
import { createFileLogger, type Logger } from "./logger.ts"
import { createRpcSender, type Notification, type NotifySender } from "./notify.ts"
import { providerRegistry } from "./registry.ts"
import type { ProviderConfig, ProviderHandler, RetryEvent, WaitScheduled } from "./types.ts"

export interface HookDeps {
  config: { readonly providers: Record<string, ProviderConfig> }
  now(): number
  send: (n: Notification) => Promise<boolean> | boolean
  logger: Logger
  /** Threaded into provider deps: reports scheduled quota waits. */
  track?: (sessionID: string, wait: WaitScheduled) => void
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
      handlers.set(
        id,
        entry.createHandler(
          { now: deps.now, send: deps.send, logger: deps.logger, providerID: id, track: deps.track },
          cfg,
        ),
      )
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

// ---- Quota-wait recovery tracking ----
// The retry hook only fires on failures: a wait that ends with a successful
// retry is invisible afterwards (OpenCode keeps no record of recovered
// retries). So the plugin watches the event stream for the session's next
// successful turn end and logs the recovery itself.

interface PendingWait {
  readonly code: string
  readonly resetRaw: string
  readonly since: number
  readonly recoveredNotification?: Notification
}

export interface RecoveryTracker {
  /** Records a scheduled wait (called from the retry hook via deps.track). */
  track(sessionID: string, wait: WaitScheduled): void
  /** Feeds one event-stream event; logs, notifies and clears on recovery. */
  handleEvent(event: unknown): void
}

const PENDING_CAP = 128

export function createRecoveryTracker(
  now: () => number,
  logger: Logger,
  send?: NotifySender,
): RecoveryTracker {
  const pending = new Map<string, PendingWait>()

  const track = (sessionID: string, wait: WaitScheduled) => {
    if (pending.size >= PENDING_CAP && !pending.has(sessionID)) {
      const oldest = pending.keys().next().value
      if (oldest !== undefined) pending.delete(oldest)
    }
    // Keep the FIRST wait's `since` on re-tracking: one window tracks once
    // per segment (and once per probe), and the recovery log/notification
    // want the total wait, not the time since the last segment.
    const since = pending.get(sessionID)?.since ?? now()
    pending.set(sessionID, {
      code: wait.code,
      resetRaw: wait.resetRaw,
      since,
      recoveredNotification: wait.recoveredNotification,
    })
  }

  // Fire-and-forget like the provider handlers' sends: a lost recovery
  // notification is low-stakes (the session visibly continues), so there is
  // no dedup window to roll back — a failure is only logged.
  const notifyRecovered = (sessionID: string, wait: PendingWait) => {
    if (send === undefined || wait.recoveredNotification === undefined) return
    try {
      const result = send(wait.recoveredNotification)
      Promise.resolve(result).then(
        (delivered) => {
          if (delivered !== true) {
            logger.debug("recovery notification not delivered", { session: sessionID })
          }
        },
        (err) => {
          logger.debug("recovery notification failed", { session: sessionID, error: String(err) })
        },
      )
    } catch (err) {
      logger.debug("recovery notification failed", { session: sessionID, error: String(err) })
    }
  }

  const handleEvent = (event: unknown) => {
    const e = event as { type?: string; data?: { sessionID?: string } }
    const type = e?.type
    const sessionID = e?.data?.sessionID
    if (typeof sessionID !== "string" || !pending.has(sessionID)) return
    const wait = pending.get(sessionID)!

    if (type === "session.execution.succeeded") {
      pending.delete(sessionID)
      logger.info("quota recovered — session resumed", {
        session: sessionID,
        code: wait.code,
        resetAt: wait.resetRaw,
        waitedMs: now() - wait.since,
      })
      notifyRecovered(sessionID, wait)
    } else if (type === "session.execution.failed") {
      // Quota may be back while something else failed; keep watching — the
      // next successful turn still counts as recovery.
      logger.info("turn still failing after quota wait", { session: sessionID, code: wait.code })
    } else if (type === "session.deleted") {
      pending.delete(sessionID)
    }
  }

  return { track, handleEvent }
}

export default Plugin.define({
  id: "error-handler",
  setup(ctx) {
    const logger = createFileLogger()
    const file = readConfigFile(logger)
    const config = resolveConfig(providerRegistry, file, logger)
    const enabled = Object.entries(config.providers)
      .filter(([, cfg]) => cfg.enabled)
      .map(([id]) => id)
    logger.info("plugin initialized", {
      version: "0.6.0",
      enabledProviders: enabled,
      configLoaded: file !== null,
      location: ctx.location.directory,
    })

    const tracker = createRecoveryTracker(() => Date.now(), logger, createRpcSender(ctx.rpc, logger))
    const hook = createHookHandler({
      config,
      now: () => Date.now(),
      send: createRpcSender(ctx.rpc, logger),
      logger,
      track: (sessionID, wait) => tracker.track(sessionID, wait),
    })

    const registration = ctx.session.hook("retry", hook)

    // Event subscription for recovery logging. The stream can drop (bus
    // error, server-side stream end); resubscribe with backoff — the
    // tracker's state survives gaps and a missed recovery log only costs a
    // log line.
    const controller = new AbortController()
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), ms)
        controller.signal.addEventListener("abort", () => {
          clearTimeout(timer)
          resolve()
        }, { once: true })
      })
    const consume = async () => {
      let delayMs = 1_000
      while (!controller.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            tracker.handleEvent(event)
            delayMs = 1_000 // stream is healthy
          }
          if (controller.signal.aborted) return
          logger.warn("event stream ended — resubscribing")
        } catch (err) {
          if (controller.signal.aborted) return
          logger.warn("event stream failed — resubscribing", { error: String(err) })
        }
        await sleep(delayMs)
        delayMs = Math.min(delayMs * 2, 30_000)
      }
    }
    if (typeof ctx.event?.subscribe === "function") {
      void consume()
    } else {
      logger.warn("event subscription unavailable on this host — recovery logging disabled")
    }

    return async () => {
      controller.abort()
      const reg = await registration
      await reg.dispose()
    }
  },
})
