import { describe, test, expect } from "bun:test"
import { NotifyGate, createRpcSender, type Notification } from "../src/notify.ts"

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

describe("NotifyGate", () => {
  test("identity dedup: the same key never fires twice", () => {
    const gate = new NotifyGate()
    expect(gate.allow("quota:2026-11-25 20:10:12", Infinity, 1_000)).toBe(true)
    expect(gate.allow("quota:2026-11-25 20:10:12", Infinity, 999_999)).toBe(false)
  })

  test("distinct keys (distinct reset windows) each fire", () => {
    const gate = new NotifyGate()
    expect(gate.allow("quota:2026-11-25 20:10:12", Infinity, 1_000)).toBe(true)
    expect(gate.allow("quota:2026-11-25 22:10:12", Infinity, 1_000)).toBe(true)
  })

  test("finite window: the same key re-fires after it elapses", () => {
    const gate = new NotifyGate()
    expect(gate.allow("fatal:1309", 3_600_000, 1_000)).toBe(true)
    expect(gate.allow("fatal:1309", 3_600_000, 1_000 + 3_599_999)).toBe(false)
    expect(gate.allow("fatal:1309", 3_600_000, 1_000 + 3_600_000)).toBe(true)
  })

  test("evicts the oldest entries beyond the cap", () => {
    const gate = new NotifyGate(2)
    gate.allow("a", Infinity, 0)
    gate.allow("b", Infinity, 0)
    gate.allow("c", Infinity, 0) // insertion-order eviction drops "a"
    expect(gate.allow("a", Infinity, 1)).toBe(true) // no longer tracked
    expect(gate.allow("c", Infinity, 1)).toBe(false) // survived the eviction
    expect(gate.allow("a", Infinity, 2)).toBe(false) // just re-sent at 1
  })

  test("default clock uses Date.now", () => {
    const gate = new NotifyGate()
    expect(gate.allow("k", Infinity)).toBe(true)
    expect(gate.allow("k", Infinity)).toBe(false)
  })
})

describe("createRpcSender", () => {
  test("passes the payload to the remote-notifier notify method", async () => {
    const sent: Notification[] = []
    const rpc = () => ({
      notify: async (input: Notification) => {
        sent.push(input)
      },
    })
    const send = createRpcSender(rpc, silentLogger)
    await send({ title: "t", message: "m", priority: 4 })
    expect(sent).toEqual([{ title: "t", message: "m", priority: 4 }])
  })

  test("stays silent when rpc() throws synchronously", async () => {
    const rpc = () => {
      throw new Error("definition not registered")
    }
    const send = createRpcSender(rpc, silentLogger)
    await send({ title: "t", message: "m" })
  })

  test("stays silent when notify() rejects", async () => {
    const rpc = () => ({
      notify: async () => {
        throw new Error("method not found")
      },
    })
    const send = createRpcSender(rpc, silentLogger)
    await send({ title: "t", message: "m" })
  })

  test("stays silent when rpc is missing entirely", async () => {
    const send = createRpcSender(undefined, silentLogger)
    await send({ title: "t", message: "m" })
  })
})
