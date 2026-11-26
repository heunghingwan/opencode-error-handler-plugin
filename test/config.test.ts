import { describe, test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { readConfigFile, resolveConfig } from "../src/config.ts"
import type { ProviderConfig } from "../src/types.ts"

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

// A minimal registry stand-in: defaults like the real zhipuai entry.
const REGISTRY: Record<string, { defaultConfig: ProviderConfig }> = {
  "zhipuai-coding-plan": {
    defaultConfig: {
      enabled: true,
      notify: true,
      quota: { waitSegments: 7, reserve: 5, minSegmentMs: 60_000, maxSegmentMs: 3_780_000, firstSegmentMs: 600_000 },
      rateLimit: {
        baseMs: 30_000,
        maxMs: 600_000,
        decayAfterMs: 600_000,
        factor: 1.5,
        models: { "glm-5.3-flash": { baseMs: 15_000 } },
      },
    },
  },
  "other-provider": {
    defaultConfig: {
      enabled: true,
      notify: false,
      quota: { waitSegments: 4, reserve: 2, minSegmentMs: 30_000, maxSegmentMs: 600_000, firstSegmentMs: 300_000 },
      rateLimit: { baseMs: 10_000, maxMs: 120_000, decayAfterMs: 300_000, factor: 2 },
    },
  },
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ehp-config-"))

describe("readConfigFile", () => {
  test("returns null when the file does not exist", () => {
    expect(readConfigFile(silentLogger, path.join(tmp(), "error-handler.json"))).toBeNull()
  })

  test("reads and parses a JSON file", () => {
    const dir = tmp()
    const file = path.join(dir, "error-handler.json")
    fs.writeFileSync(file, JSON.stringify({ providers: { "zhipuai-coding-plan": { notify: false } } }))
    expect(readConfigFile(silentLogger, file)).toEqual({
      providers: { "zhipuai-coding-plan": { notify: false } },
    })
  })

  test("returns null (logged) for invalid JSON", () => {
    const dir = tmp()
    const file = path.join(dir, "error-handler.json")
    fs.writeFileSync(file, "{ nope")
    expect(readConfigFile(silentLogger, file)).toBeNull()
  })

  test("reads from ~/.config/opencode/error-handler.json by default", () => {
    const home = tmp()
    const dir = path.join(home, ".config", "opencode")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "error-handler.json"), JSON.stringify({ providers: {} }))
    const prev = process.env.HOME
    process.env.HOME = home
    try {
      expect(readConfigFile(silentLogger)).toEqual({ providers: {} })
    } finally {
      process.env.HOME = prev
    }
  })
})

describe("resolveConfig", () => {
  test("file null (missing/invalid) → every registry provider at its defaults", () => {
    const resolved = resolveConfig(REGISTRY, null, silentLogger)
    expect(resolved.providers["zhipuai-coding-plan"]).toEqual(REGISTRY["zhipuai-coding-plan"]!.defaultConfig)
    expect(resolved.providers["other-provider"]).toEqual(REGISTRY["other-provider"]!.defaultConfig)
  })

  test("file present but provider unlisted → provider disabled (absent)", () => {
    const resolved = resolveConfig(REGISTRY, { providers: { "other-provider": { enabled: true } } }, silentLogger)
    expect(resolved.providers["zhipuai-coding-plan"]).toBeUndefined()
    expect(resolved.providers["other-provider"]).toEqual({
      enabled: true,
      notify: false,
      quota: { waitSegments: 4, reserve: 2, minSegmentMs: 30_000, maxSegmentMs: 600_000, firstSegmentMs: 300_000 },
      rateLimit: { baseMs: 10_000, maxMs: 120_000, decayAfterMs: 300_000, factor: 2 },
    })
  })

  test("partial entry merges field-by-field over the provider defaults", () => {
    const resolved = resolveConfig(
      REGISTRY,
      { providers: { "zhipuai-coding-plan": { notify: false } } },
      silentLogger,
    )
    expect(resolved.providers["zhipuai-coding-plan"]).toEqual({
      enabled: true,
      notify: false,
      quota: { waitSegments: 7, reserve: 5, minSegmentMs: 60_000, maxSegmentMs: 3_780_000, firstSegmentMs: 600_000 },
      rateLimit: {
        baseMs: 30_000,
        maxMs: 600_000,
        decayAfterMs: 600_000,
        factor: 1.5,
        models: { "glm-5.3-flash": { baseMs: 15_000 } },
      },
    })
  })

  test("quota merges per-field", () => {
    const resolved = resolveConfig(
      REGISTRY,
      { providers: { "zhipuai-coding-plan": { quota: { maxSegmentMs: 900_000 } } } },
      silentLogger,
    )
    expect(resolved.providers["zhipuai-coding-plan"]?.quota).toEqual({
      waitSegments: 7,
      reserve: 5,
      minSegmentMs: 60_000,
      maxSegmentMs: 900_000,
      firstSegmentMs: 600_000,
    })
  })

  test("quota.firstSegmentMs merges with a range-checked fallback", () => {
    const resolved = resolveConfig(
      REGISTRY,
      { providers: { "zhipuai-coding-plan": { quota: { firstSegmentMs: 300_000 } } } },
      silentLogger,
    )
    expect(resolved.providers["zhipuai-coding-plan"]?.quota.firstSegmentMs).toBe(300_000)
  })

  test("bogus firstSegmentMs falls back; absent keeps the default", () => {
    const resolved = resolveConfig(
      REGISTRY,
      { providers: { "zhipuai-coding-plan": { quota: { firstSegmentMs: -1 } } } },
      silentLogger,
    )
    expect(resolved.providers["zhipuai-coding-plan"]?.quota.firstSegmentMs).toBe(600_000)
    const resolved2 = resolveConfig(
      REGISTRY,
      { providers: { "zhipuai-coding-plan": { quota: { firstSegmentMs: "x" } } } },
      silentLogger,
    )
    expect(resolved2.providers["zhipuai-coding-plan"]?.quota.firstSegmentMs).toBe(600_000)
    const resolved3 = resolveConfig(
      REGISTRY,
      { providers: { "zhipuai-coding-plan": { quota: { waitSegments: 6 } } } },
      silentLogger,
    )
    expect(resolved3.providers["zhipuai-coding-plan"]?.quota.firstSegmentMs).toBe(600_000)
  })

  test("rateLimit merges per-field", () => {
    const resolved = resolveConfig(
      REGISTRY,
      { providers: { "zhipuai-coding-plan": { rateLimit: { baseMs: 15_000, maxMs: 300_000, factor: 2 } } } },
      silentLogger,
    )
    expect(resolved.providers["zhipuai-coding-plan"]?.rateLimit).toEqual({
      baseMs: 15_000,
      maxMs: 300_000,
      decayAfterMs: 600_000,
      factor: 2,
      models: { "glm-5.3-flash": { baseMs: 15_000 } },
    })
  })

  test("rateLimit.models merges per-model over the shipped overrides", () => {
    const resolved = resolveConfig(
      REGISTRY,
      {
        providers: {
          "zhipuai-coding-plan": {
            rateLimit: {
              models: {
                "glm-5.3-flash": { factor: 2 },
                "glm-5.3": { baseMs: 20_000 },
              },
            },
          },
        },
      },
      silentLogger,
    )
    expect(resolved.providers["zhipuai-coding-plan"]?.rateLimit.models).toEqual({
      // existing override keeps unset fields (baseMs) and takes the new factor
      "glm-5.3-flash": { baseMs: 15_000, factor: 2 },
      // a brand-new model entry appears alongside the shipped one
      "glm-5.3": { baseMs: 20_000 },
    })
  })

  test("bogus per-model override values keep the shipped fields", () => {
    const resolved = resolveConfig(
      REGISTRY,
      {
        providers: {
          "zhipuai-coding-plan": {
            rateLimit: { models: { "glm-5.3-flash": { baseMs: "fast", factor: 0.5 } } },
          },
        },
      },
      silentLogger,
    )
    expect(resolved.providers["zhipuai-coding-plan"]?.rateLimit.models).toEqual({
      "glm-5.3-flash": { baseMs: 15_000 },
    })
  })

  test("a bogus models map is ignored", () => {
    const resolved = resolveConfig(
      REGISTRY,
      { providers: { "zhipuai-coding-plan": { rateLimit: { models: "nope" } } } },
      silentLogger,
    )
    expect(resolved.providers["zhipuai-coding-plan"]?.rateLimit.models).toEqual({
      "glm-5.3-flash": { baseMs: 15_000 },
    })
  })

  test("rateLimit.maxMs below baseMs reverts both to defaults", () => {
    const resolved = resolveConfig(
      REGISTRY,
      { providers: { "zhipuai-coding-plan": { rateLimit: { baseMs: 500_000, maxMs: 100_000 } } } },
      silentLogger,
    )
    expect(resolved.providers["zhipuai-coding-plan"]?.rateLimit).toEqual({
      baseMs: 30_000,
      maxMs: 600_000,
      decayAfterMs: 600_000,
      factor: 1.5,
      models: { "glm-5.3-flash": { baseMs: 15_000 } },
    })
  })

  test("non-numeric or bogus-typed values fall back to defaults", () => {
    const resolved = resolveConfig(
      REGISTRY,
      {
        providers: {
          "zhipuai-coding-plan": {
            enabled: "yes",
            notify: 0,
            quota: { waitSegments: -5, reserve: "3", minSegmentMs: Number.NaN, maxSegmentMs: 10 },
            rateLimit: { baseMs: -1, maxMs: "600", decayAfterMs: Number.NaN, factor: 0.5 },
          },
        },
      },
      silentLogger,
    )
    expect(resolved.providers["zhipuai-coding-plan"]).toEqual({
      enabled: true,
      notify: true,
      quota: { waitSegments: 7, reserve: 5, minSegmentMs: 60_000, maxSegmentMs: 3_780_000, firstSegmentMs: 600_000 },
      rateLimit: {
        baseMs: 30_000,
        maxMs: 600_000,
        decayAfterMs: 600_000,
        factor: 1.5,
        models: { "glm-5.3-flash": { baseMs: 15_000 } },
      },
    })
  })

  test("tolerates a file without a providers object", () => {
    const resolved = resolveConfig(REGISTRY, { providers: "nope" }, silentLogger)
    expect(resolved.providers["zhipuai-coding-plan"]).toBeUndefined()
    const resolved2 = resolveConfig(REGISTRY, {}, silentLogger)
    expect(resolved2.providers["zhipuai-coding-plan"]).toBeUndefined()
  })
})
