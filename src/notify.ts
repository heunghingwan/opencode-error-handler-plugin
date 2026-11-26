// Notification delivery: a dedup gate plus the RPC call into the
// remote-notifier plugin.
//
// OpenCode instantiates the plugin once per LOCATION (project directory) —
// the hooks registry is per-location — while the module loads once per
// server process (plain dynamic import; same reasoning as src/ratelimit.ts).
// Per-instance gates therefore deduplicate nothing ACROSS locations, and
// parallel sessions in different projects share one account quota window:
// each location's instance re-announced it (2026-11-27: three locations →
// three ⚠️ and two ✅ for one window). The gate lives in module scope —
// process scope — keyed by provider, so every location's instance shares
// it. A process restart mid-window re-fires once per restart: bounded, and
// strictly better than the per-location multiplication it replaces.
//
// The remote-notifier plugin owns all notification transport; this plugin
// never builds its own. The call goes through OpenCode's plugin RPC:
//   ctx.rpc(definition).notify(input)     with input { title, message, priority? }
//
// REMOTE_NOTIFIER_RPC below must be a COMPLETE Rpc definition — OpenCode's
// RPC client compiles it eagerly: Object.entries(definition.events) runs on
// every ctx.rpc(definition) call, and the method's output is validated
// against the CALLER-side method.output schema. A definition without
// events: {} or without the per-method input/output schemas makes every
// rpc() construction throw and silently drops every notification (that was
// a real production bug: the account-quota notification never reached ntfy
// while the error-handler log showed "Object.entries requires that input
// parameter not be null or undefined").
//
// It mirrors, field by field, the server-side definition in
// opencode-remote-notifier-plugin's src/rpc.ts (id, method name, JSON
// Schemas, empty events). Kept as a local copy on purpose: a hard dependency
// on the notifier package would let its install failures break this plugin's
// retry handling, while a schema drift here degrades exactly one
// notification and is retried on the next event (see fireGated's rollback).
// When the call fails, the sender reports not-delivered and the caller
// releases its dedup key, so the next retry event re-attempts the send.

import type { Logger } from "./logger.ts"

export interface Notification {
  title: string
  message: string
  priority?: number
}

/**
 * Delivers one notification. Returns whether it was actually delivered
 * (or accepted by the transport): `false`/throw means dropped, which lets
 * callers undo their dedup key so the next event re-attempts the send.
 */
export type NotifySender = (n: Notification) => Promise<boolean> | boolean

/**
 * The remote-notifier plugin's RPC surface, as seen by this caller.
 * MUST stay in sync with opencode-remote-notifier-plugin src/rpc.ts
 * (id "remote-notifier", method notify, input/output schemas, no events).
 */
export const REMOTE_NOTIFIER_RPC = {
  id: "remote-notifier",
  methods: {
    notify: {
      input: {
        type: "object",
        properties: {
          title: { type: "string" },
          message: { type: "string" },
          priority: { type: "number" },
        },
        required: ["title", "message"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          sent: { type: "boolean" },
        },
        required: ["sent"],
        additionalProperties: false,
      },
    },
  },
  events: {},
} as const

/**
 * Notification dedup gate. Keys are caller-chosen identities (quota reset
 * window strings, error codes); `windowMs` of Infinity means the key fires
 * exactly once for its lifetime (a reset window never re-notifies), finite
 * windows re-fire after elapsing. Bounded by FIFO eviction so a long-lived
 * server never grows the map without limit.
 */
export class NotifyGate {
  readonly #sent = new Map<string, number>()
  readonly #cap: number

  constructor(cap = 256) {
    this.#cap = Math.max(1, cap)
  }

  /**
   * Records a send for `key` if it has not fired within its window.
   * Returns true when the notification should be sent.
   */
  allow(key: string, windowMs: number = Infinity, now: number = Date.now()): boolean {
    const sentAt = this.#sent.get(key)
    if (sentAt !== undefined && now - sentAt < windowMs) return false
    this.#sent.set(key, now)
    if (this.#sent.size > this.#cap) {
      const overflow = this.#sent.size - this.#cap
      let evicted = 0
      for (const oldest of this.#sent.keys()) {
        if (evicted >= overflow) break
        this.#sent.delete(oldest)
        evicted++
      }
    }
    return true
  }

  /**
   * Undoes a recent `allow` for `key`: the next `allow` with the same key
   * sends again. Used when a delivery failed — a dropped notification must
   * not consume the window's only send (e.g. the notifier RPC was
   * unavailable during a plugin install/update timing gap).
   */
  release(key: string): void {
    this.#sent.delete(key)
  }
}

const sharedGates = new Map<string, NotifyGate>()

/**
 * The process-global dedup gate for one provider, shared by that provider's
 * plugin instances — one per OpenCode location. The providerID keying keeps
 * one provider's keys (`quota:…`, `recovered:…`) from ever colliding with
 * another's.
 */
export function sharedNotifyGate(providerID: string, cap = 256): NotifyGate {
  let gate = sharedGates.get(providerID)
  if (gate === undefined) {
    gate = new NotifyGate(cap)
    sharedGates.set(providerID, gate)
  }
  return gate
}

/** Test hook: clears the shared gate registry. Production code never resets. */
export function resetSharedNotifyGates(): void {
  sharedGates.clear()
}

/**
 * Fire-and-forget send behind a dedup gate, with rollback: a send that
 * reports not-delivered (or throws) releases its key, so the next event
 * re-attempts instead of losing the window's only notification. Never
 * throws; notification trouble must never reach the retry path.
 */
export function fireGated(
  gate: NotifyGate,
  key: string,
  windowMs: number,
  now: number,
  send: NotifySender,
  logger: Logger,
  n: Notification,
): void {
  if (!gate.allow(key, windowMs, now)) return
  const release = (reason: unknown) => {
    gate.release(key)
    logger.debug("notification not delivered — dedup key released for the next retry event", {
      key,
      reason: String(reason),
    })
  }
  try {
    const result = send(n)
    Promise.resolve(result).then(
      (delivered) => {
        if (delivered !== true) release("sender reported not delivered")
      },
      (err) => release(err),
    )
  } catch (err) {
    release(err)
  }
}

/** Fire-and-forget RPC sender; never throws; reports delivery as boolean. */
export function createRpcSender(rpc: unknown, logger: Logger): NotifySender {
  return async (input) => {
    try {
      const client = (rpc as
        | ((definition: unknown) => { notify: (input: Notification) => Promise<unknown> })
        | undefined
      )?.(REMOTE_NOTIFIER_RPC)
      const result = await client?.notify(input)
      // The remote-notifier RPC answers { sent: boolean }: a false means it
      // dropped the notification (disabled or rate limited) — treat that as
      // not delivered so the caller re-attempts on the next event.
      const sent = (result as { sent?: boolean } | undefined)?.sent
      return sent === undefined ? true : sent !== false
    } catch (err) {
      logger.debug("remote-notifier RPC unavailable, notification dropped", { error: String(err) })
      return false
    }
  }
}
