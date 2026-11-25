import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createFileLogger, DEFAULT_LOG_PATH, silentLogger } from "../src/logger.ts"

describe("createFileLogger", () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ehp-log-"))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const file = () => path.join(dir, "error-handler.log")

  test("writes JSONL entries with level, msg and extra fields", () => {
    const logger = createFileLogger(file())
    logger.info("quota wait scheduled", { code: "1308", delayMs: 42 })
    logger.warn("something", { note: "x" })
    const lines = fs.readFileSync(file(), "utf8").trim().split("\n")
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0]!)
    expect(first.level).toBe("info")
    expect(first.msg).toBe("quota wait scheduled")
    expect(first.code).toBe("1308")
    expect(first.delayMs).toBe(42)
    expect(typeof first.ts).toBe("string")
    expect(new Date(first.ts).getTime()).not.toBeNaN()
    expect(JSON.parse(lines[1]!).level).toBe("warn")
  })

  test("respects minLevel", () => {
    const logger = createFileLogger(file(), { minLevel: "warn" })
    logger.debug("nope")
    logger.info("nope")
    logger.error("yes")
    const lines = fs.readFileSync(file(), "utf8").trim().split("\n")
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!).msg).toBe("yes")
  })

  test("rotates to .1 once the file exceeds the cap", () => {
    const logger = createFileLogger(file(), { rotationBytes: 1 })
    logger.info("first")
    logger.info("second")
    const rotated = fs.readFileSync(`${file()}.1`, "utf8")
    expect(rotated).toContain("first")
    expect(fs.readFileSync(file(), "utf8")).toContain("second")
  })

  test("an unwritable path never throws", () => {
    const logger = createFileLogger("/proc/definitely/not/writable/error-handler.log")
    expect(() => logger.info("boom")).not.toThrow()
  })

  test("silentLogger discards", () => {
    expect(() => silentLogger.info("x")).not.toThrow()
  })
})

describe("DEFAULT_LOG_PATH", () => {
  test("respects ERROR_HANDLER_LOG and defaults next to opencode.log", () => {
    const prev = process.env.ERROR_HANDLER_LOG
    process.env.ERROR_HANDLER_LOG = "/tmp/custom.log"
    expect(DEFAULT_LOG_PATH()).toBe("/tmp/custom.log")
    delete process.env.ERROR_HANDLER_LOG
    if (prev !== undefined) process.env.ERROR_HANDLER_LOG = prev
    expect(DEFAULT_LOG_PATH()).toBe(path.join(os.homedir(), ".local/share/opencode/log/error-handler.log"))
  })
})
