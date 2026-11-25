// Notification delivery: a dedup gate plus the (loose) RPC call into the
// remote-notifier plugin.
//
// The remote-notifier plugin owns all notification transport; this plugin
// never builds its own. remote-notifier's RPC definition is not published
// yet (work in another repo), so the call below is deliberately loose-typed:
// it calls ctx.rpc(definition).notify(input) with the agreed interface
//   notify({ title, message, priority? })
// and degrades silently on any failure. When remote-notifier ships its
// definition (planned export: "opencode-remote-notifier-plugin/rpc"), replace
// LOOSE_REMOTE_NOTIFIER_RPC with the typed import.

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

/** Loose placeholder for the future remote-notifier RPC definition. */
const LOOSE_REMOTE_NOTIFIER_RPC = {
  id: "remote-notifier",
  methods: {
    notify: {},
  },
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

/** Fire-and-forget RPC sender; never throws; reports delivery as boolean. */
export function createRpcSender(rpc: unknown, logger: Logger): NotifySender {
  return async (input) => {
    try {
      const client = (rpc as
        | ((definition: unknown) => { notify: (input: Notification) => Promise<unknown> })
        | undefined
      )?.(LOOSE_REMOTE_NOTIFIER_RPC)
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
