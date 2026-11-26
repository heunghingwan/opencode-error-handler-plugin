// File-based configuration: ~/.config/opencode/error-handler.json (strict
// JSON; template in config.example.json at the repo root). Semantics:
//
//   file missing / unparsable → every registered provider runs at its own
//                               defaults (zhipuai ships enabled)
//   file present, provider unlisted → provider disabled
//   file present, provider listed   → listed fields override the provider's
//                               defaults, field by field
//
// The pattern mirrors opencode-remote-notifier-plugin's notifier.json.

import fs from "node:fs"
import path from "node:path"
import type { Logger } from "./logger.ts"
import type { ProviderConfig, QuotaConfig, RateLimitConfig, RateLimitOverride } from "./types.ts"

export interface ResolvedConfig {
  readonly providers: Record<string, ProviderConfig>
}

type Registry = Record<string, { defaultConfig: ProviderConfig }>

const configPath = (): string => {
  const homeDir = process.env.HOME || process.env.USERPROFILE || ""
  return path.join(homeDir, ".config", "opencode", "error-handler.json")
}

/**
 * Reads and JSON.parses the config file. Returns null when the file is
 * missing or invalid (invalid files are logged; both yield the defaults).
 */
export function readConfigFile(logger: Logger, filePath: string = configPath()): unknown {
  try {
    const raw = fs.readFileSync(filePath, "utf-8")
    return JSON.parse(raw)
  } catch (err: any) {
    if (err?.code !== "ENOENT") logger.error("Config parse error, using defaults", { message: err?.message ?? String(err) })
    return null
  }
}

const boolOr = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback)

// Range-checked numeric pick: bogus types AND out-of-range values both fall
// back, so a typo'd config can never produce nonsense like negative segments.
const numInRangeOr = (v: unknown, lo: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) && v >= lo ? v : fallback

function mergeQuota(user: unknown, fallback: QuotaConfig, logger: Logger): QuotaConfig {
  const merged: QuotaConfig = { ...fallback }
  if (typeof user === "object" && user !== null) {
    const q = user as Record<string, unknown>
    merged.waitSegments = numInRangeOr(q.waitSegments, 1, fallback.waitSegments)
    merged.reserve = numInRangeOr(q.reserve, 0, fallback.reserve)
    merged.minSegmentMs = numInRangeOr(q.minSegmentMs, 0, fallback.minSegmentMs)
    merged.maxSegmentMs = numInRangeOr(q.maxSegmentMs, 1, fallback.maxSegmentMs)
    merged.firstSegmentMs = numInRangeOr(q.firstSegmentMs, 0, fallback.firstSegmentMs)
  }
  if (merged.maxSegmentMs < merged.minSegmentMs) {
    logger.warn("Config quota.maxSegmentMs < minSegmentMs, reverting both to defaults", {
      minSegmentMs: merged.minSegmentMs,
      maxSegmentMs: merged.maxSegmentMs,
    })
    merged.minSegmentMs = fallback.minSegmentMs
    merged.maxSegmentMs = fallback.maxSegmentMs
  }
  return merged
}

function mergeRateLimit(user: unknown, fallback: RateLimitConfig, logger: Logger): RateLimitConfig {
  const merged: RateLimitConfig = { ...fallback }
  if (typeof user === "object" && user !== null) {
    const r = user as Record<string, unknown>
    merged.baseMs = numInRangeOr(r.baseMs, 0, fallback.baseMs)
    merged.maxMs = numInRangeOr(r.maxMs, 1, fallback.maxMs)
    merged.decayAfterMs = numInRangeOr(r.decayAfterMs, 0, fallback.decayAfterMs)
    merged.factor = numInRangeOr(r.factor, 1, fallback.factor)
    // Per-model overrides merge over the shipped ones, field by field; a
    // bogus value keeps the shipped field (same fallback philosophy).
    if (typeof r.models === "object" && r.models !== null) {
      const models: Record<string, RateLimitOverride> = { ...(fallback.models ?? {}) }
      for (const [modelID, override] of Object.entries(r.models as Record<string, unknown>)) {
        if (typeof override !== "object" || override === null) continue
        const o = override as Record<string, unknown>
        const m: RateLimitOverride = { ...(models[modelID] ?? {}) }
        const valid = (v: unknown, lo: number): v is number =>
          typeof v === "number" && Number.isFinite(v) && v >= lo
        if (valid(o.baseMs, 0)) m.baseMs = o.baseMs
        if (valid(o.maxMs, 1)) m.maxMs = o.maxMs
        if (valid(o.decayAfterMs, 0)) m.decayAfterMs = o.decayAfterMs
        if (valid(o.factor, 1)) m.factor = o.factor
        models[modelID] = m
      }
      merged.models = models
    }
  }
  if (merged.maxMs < merged.baseMs) {
    logger.warn("Config rateLimit.maxMs < baseMs, reverting both to defaults", {
      baseMs: merged.baseMs,
      maxMs: merged.maxMs,
    })
    merged.baseMs = fallback.baseMs
    merged.maxMs = fallback.maxMs
  }
  return merged
}

function mergeProvider(user: unknown, fallback: ProviderConfig, logger: Logger): ProviderConfig {
  if (typeof user !== "object" || user === null) return { ...fallback, quota: { ...fallback.quota }, rateLimit: { ...fallback.rateLimit } }
  const p = user as Record<string, unknown>
  return {
    enabled: boolOr(p.enabled, fallback.enabled),
    notify: boolOr(p.notify, fallback.notify),
    quota: mergeQuota(p.quota, fallback.quota, logger),
    rateLimit: mergeRateLimit(p.rateLimit, fallback.rateLimit, logger),
  }
}

/**
 * Resolves the effective per-provider configuration from a parsed config
 * file (`null` when absent/invalid) against the provider registry.
 */
export function resolveConfig(registry: Registry, file: unknown, logger: Logger): ResolvedConfig {
  const providers: Record<string, ProviderConfig> = {}
  if (file === null || file === undefined) {
    for (const [id, entry] of Object.entries(registry)) {
      providers[id] = { ...entry.defaultConfig, quota: { ...entry.defaultConfig.quota }, rateLimit: { ...entry.defaultConfig.rateLimit } }
    }
    return { providers }
  }
  const userProviders =
    typeof file === "object" && file !== null && typeof (file as { providers?: unknown }).providers === "object"
      ? ((file as { providers: Record<string, unknown> }).providers ?? {})
      : {}
  for (const [id, entry] of Object.entries(registry)) {
    const user = userProviders[id]
    if (user === undefined) continue // unlisted → not enabled
    providers[id] = mergeProvider(user, entry.defaultConfig, logger)
  }
  return { providers }
}
