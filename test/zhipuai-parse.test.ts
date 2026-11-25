import { describe, test, expect } from "bun:test"
import { parseBody, parseResetTime } from "../src/providers/zhipuai-coding-plan.ts"

// Real zhipuai 1308 body (message from the official error-code table; the
// reset time is Beijing time, UTC+8).
const BODY_1308 = JSON.stringify({
  error: {
    code: "1308",
    message: "已达到 5 小时的使用上限。您的限额将在 2026-11-25 20:10:12 重置。",
  },
})

describe("parseBody", () => {
  test("extracts code and message from the error envelope", () => {
    expect(parseBody(BODY_1308)).toEqual({
      code: "1308",
      message: "已达到 5 小时的使用上限。您的限额将在 2026-11-25 20:10:12 重置。",
    })
  })

  test("stringifies a numeric code", () => {
    expect(parseBody(JSON.stringify({ error: { code: 1302, message: "x" } }))).toEqual({
      code: "1302",
      message: "x",
    })
  })

  test("accepts an empty message", () => {
    expect(parseBody(JSON.stringify({ error: { code: "1305" } }))).toEqual({ code: "1305", message: "" })
  })

  test("returns null when body is missing or not a string", () => {
    expect(parseBody(undefined)).toBeNull()
    expect(parseBody("")).toBeNull()
  })

  test("returns null for invalid JSON", () => {
    expect(parseBody("not json {")).toBeNull()
    expect(parseBody("")).toBeNull()
  })

  test("returns null without an error envelope", () => {
    expect(parseBody(JSON.stringify({ message: "nope" }))).toBeNull()
    expect(parseBody(JSON.stringify({ error: "flat" }))).toBeNull()
    expect(parseBody(JSON.stringify({ error: {} }))).toBeNull()
    expect(parseBody(JSON.stringify({ error: { message: "codeless" } }))).toBeNull()
    expect(parseBody(JSON.stringify([1, 2]))).toBeNull()
    expect(parseBody(JSON.stringify("string root"))).toBeNull()
  })
})

describe("parseResetTime", () => {
  test("converts Beijing time (UTC+8) to an epoch", () => {
    // 2026-11-25 20:10:12 +08 == 2026-11-25 12:10:12 UTC
    const parsed = parseResetTime("您的限额将在 2026-11-25 20:10:12 重置。")
    expect(parsed).toEqual({ raw: "2026-11-25 20:10:12", epoch: Date.UTC(2026, 10, 25, 12, 10, 12) })
  })

  test("hours before 08:00 roll the UTC day back", () => {
    // 2026-11-25 05:30:00 +08 == 2026-11-24 21:30:00 UTC
    const parsed = parseResetTime("将在 2026-11-25 05:30:00 重置")
    expect(parsed?.epoch).toBe(Date.UTC(2026, 10, 24, 21, 30, 0))
  })

  test("finds the timestamp anywhere in a longer message", () => {
    const parsed = parseResetTime("已达到 7 天使用上限。您的限额将在 2026-12-31 23:59:59 重置。请联系管理员。")
    expect(parsed?.raw).toBe("2026-12-31 23:59:59")
  })

  test("returns null without a timestamp", () => {
    expect(parseResetTime("已达到使用上限，无重置时间")).toBeNull()
    expect(parseResetTime("")).toBeNull()
  })

  test("returns null for malformed timestamp fields", () => {
    expect(parseResetTime("将在 2026-13-01 00:00:00 重置")).toBeNull()
    expect(parseResetTime("将在 2026-11-31 25:61:61 重置")).toBeNull()
  })
})
