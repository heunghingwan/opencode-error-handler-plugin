# opencode-error-handler-plugin v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OpenCode v2 plugin that hooks `session.retry`, classifies provider API errors per provider, customizes retry decisions (quota-window segmented waiting), and pushes important errors via remote-notifier's RPC (to-be-published, loose-typed for now).

**Architecture:** One `session.retry` hook registered unfiltered; a provider registry dispatches by `event.model.providerID`. Each provider lives in `src/providers/<providerID>.ts` and owns its error-code classification, decision logic, and notifications. Pure modules (parse, budget arithmetic, dedup gate, config) are provider-agnostic and fully unit-tested; the zhipuai handler is a pure function of (event, config, clock, sender) for deterministic tests.

**Tech Stack:** TypeScript, Bun (`bun test`), `@opencode/plugin` ^2.3.2 (sole runtime dep).

**Spec:** The task brief in the 2026-11-26 session (verbatim requirements quoted below) + AGENTS.md (structure red lines). The design phase already happened with the human partner; this plan is the execution breakdown.

## Global Constraints

- Plugin source NEVER under `.opencode/` (AGENTS.md red line). Layout: `src/`, `test/`, root configs.
- Pure TypeScript; no runtime deps besides `@opencode/plugin` ^2.3.2.
- `bun test` all green before completion; `tsc --noEmit` clean.
- OpenCode facts (verified against core source, do not re-derive):
  - Hook events carry the *upcoming* attempt number: first failure → `attempt=2`; events span attempt 2..11; after seeing attempt A, `12 - A` retry decisions remain (incl. this one). Budget exhausted → no more hook events.
  - Built-in policy: exponential 2s→10s, jitter, `Schedule.recurs(10)` hard cap.
  - Non-retryable errors also fire the hook with `decision = {retry:false}` already set.
  - NaN/negative/infinite delay falls back to built-in; large delays legal.
  - `PluginHooks` is per-location: one instance per location writes the decision once.
- Zhipu reset times are Beijing (UTC+8), format `YYYY-MM-DD HH:mm:ss`, regex `/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/`.
- Notification interface (agreed, RPC definition ships later from `opencode-remote-notifier-plugin/rpc`): `notify({ title, message, priority? })`, loose-typed, try/catch silent, fire-and-forget (never block the decision path).
- Config: `~/.config/opencode/error-handler.json` (strict JSON), template `config.example.json` in repo. File missing → defaults (zhipuai enabled). File present but provider unlisted → provider disabled. Listed → merged over provider defaults.
- Commit frequently; never push.

## Review Focus

1. **Malformed/missing response body** (body not JSON, `response` absent, code not a string/number) → handler must leave `decision` untouched, never throw.
2. **Reset time already past** → wait path still runs, delay clamps to `minSegmentMs` (probing, not fail-fast).
3. **Reset time too far to span** (e.g. 7-day weekly window vs 7×45min capacity) → `retry:false` + terminal notify with reset time, not an unbounded wait.
4. **Handler exceptions** must never break OpenCode's retry path (try/catch in the hook callback, decision untouched).
5. **Notification dedup correctness**: same reset window never re-notifies; distinct windows do; fatal codes dedup on a time window, not forever.

---

### Task 0: Scaffold

**Files:** Create `package.json`, `tsconfig.json`; keep `.gitignore` (add `bun.lock`? no — commit it).

- package.json: name `opencode-error-handler-plugin`, `main: src/index.ts`, `type: module`, deps `@opencode/plugin ^2.3.2`, devDeps `@types/bun`, `@types/node`, scripts `test: bun test`, `typecheck: tsc --noEmit`.
- tsconfig mirrors remote-notifier's (ESNext, bundler resolution, strict, `allowImportingTsExtensions`, `noUncheckedIndexedAccess`), includes `src/**/*.ts` and `test/**/*.ts`.
- `bun install`; verify `bun test` runs (0 tests).

### Task 1: `src/budget.ts` — retry-budget arithmetic (pure)

**Files:** Create `src/budget.ts`, `test/budget.test.ts`.

**Interfaces:**
- `export interface QuotaConfig { waitSegments: number; reserve: number; minSegmentMs: number; maxSegmentMs: number }` (lives in `src/types.ts`; budget imports it)
- `export const MAX_RETRIES = 10`
- `export function segmentsAvailable(attempt: number, quota: QuotaConfig): number` — `clamp(12 - attempt - reserve, 0, waitSegments)`
- `export function segmentDelay(remainingMs: number, segments: number, quota: QuotaConfig): number` — `clamp(ceil(remainingMs / segments), minSegmentMs, maxSegmentMs)`
- `export function maxSpanMs(segments: number, quota: QuotaConfig): number` — `segments * maxSegmentMs`

Tests: attempt boundaries (2→7, 8→1, 9→0, 11→0, default cfg), proportional delay in-range, clamp to min (remaining ≤ 0 / tiny), clamp to max, `segments<=0` guard.

### Task 2: zhipuai parsing (pure, in provider file)

**Files:** Create `src/providers/zhipuai-coding-plan.ts` (parse exports only for now), `test/zhipuai-parse.test.ts`.

**Interfaces:**
- `export function parseBody(body: string | undefined): { code: string; message: string } | null`
- `export function parseResetTime(message: string): { raw: string; epoch: number } | null` (UTC+8, `Date.UTC(y, mo-1, d, h-8, mi, s)`)

Tests: 1308 real message → exact epoch (`Date.UTC(2026,10,25,12,10,12)`); hour < 8 rolls day back; body not JSON → null; `response` missing/undefined body → null; code as number → stringified; no timestamp in message → null; out-of-range timestamp fields → null; `{"error":{}}` no code → null; plain object without error envelope → null.

### Task 3: `src/notify.ts` — gate + loose RPC sender

**Files:** Create `src/notify.ts` (+ `src/logger.ts`), `test/notify.test.ts`.

**Interfaces:**
- `export interface Notification { title: string; message: string; priority?: number }`
- `export type NotifySender = (n: Notification) => Promise<void> | void`
- `export class NotifyGate { constructor(cap?: number); allow(key: string, windowMs?: number, now?: number): boolean }` — Infinity window = identity dedup; FIFO cap 256.
- `export function createRpcSender(rpc: unknown, logger: Logger): NotifySender` — loose call `(rpc as any)(LOOSE_DEF).notify(input)`, try/catch → debug log.

Tests: gate identity dedup (same key twice → false), distinct keys → true, finite window expiry, FIFO eviction; sender: rpc throws sync → resolves silently; notify rejects → resolves silently; happy path passes payload through.

### Task 4: `src/config.ts` — file loading + merge

**Files:** Create `src/config.ts` (+ `src/types.ts`), `test/config.test.ts`.

**Interfaces:**
- `export function readConfigFile(logger: Logger, filePath?: string): unknown` — reads `~/.config/opencode/error-handler.json` (HOME env), null when missing/invalid (error logged).
- `export function resolveConfig(registry: Record<string, { defaultConfig: ProviderConfig }>, file: unknown, logger: Logger): { providers: Record<string, ProviderConfig> }` — file null → all defaults; file present → only listed providers, merged field-by-field over defaults; non-numeric quota fields → defaults (warn).

Tests: missing file → zhipuai defaults enabled/notify/quota; present file unlisted provider → absent from result; partial override (notify:false) keeps other defaults; quota overrides only given fields; invalid JSON → defaults; bogus types → defaults for those fields.

### Task 5: zhipuai handler — decision table + notifications

**Files:** Modify `src/providers/zhipuai-coding-plan.ts`, create `test/zhipuai-handler.test.ts`.

**Interfaces:**
- `export const DEFAULT_CONFIG: ProviderConfig`
- `export const zhipuaiCodingPlan: ProviderEntry` (`{ defaultConfig, createHandler(deps, config) }`) with `ProviderHandler = (event: RetryEvent) => void` mutating `event.decision`.
- deps: `{ now(): number; send: NotifySender; logger: Logger }`
- Constants: `QUOTA_CODES` (1308, 1310, 1316–1321), `FATAL_HINTS` (1113, 1309, 1311, 1313, 1314, 1315), `RATE_LIMIT_DELAY_MS = 30_000`.

Behavior (v1, informed by the official error-code table):
- 1302 → `{retry:true, delay:30000}`.
- 1305, unknown codes, unparseable quota message → untouched.
- Quota class: parse reset; `segments = segmentsAvailable(attempt)`; if `segments <= 0` → `retry:false` + terminal notify (`terminal:<raw>`,「重置後仍無額度」copy); else if `remaining > segments*maxSegmentMs` → `retry:false` + terminal notify (too-far copy); else delay via `segmentDelay`, `retry:true`, once-per-window notify (`quota:<raw>`, copy contains reset time + 已排自動恢復).
- Fatal class → `retry:false` + notify deduped `fatal:<code>` (1h window), copy includes hint.
- All sends gated by `config.notify`; fire-and-forget (`void send`).

Tests: full decision table incl. attempt boundaries (A=2 wait, A=8 last segment, A=9 fail-fast), reset-in-past → min clamp, can't-span (year-2099 weekly) → fail-fast, notify dedup per window (same raw twice → 1 send; different raw → 2 sends), terminal vs quota notify distinct, notify:false config → no sends, non-notify path leaves decision untouched for unknown code, non-retryable preset `{retry:false}` stays untouched for unhandled codes, decision untouched when handler throws (via a poisoned send? — no: covered in Task 6 at hook level).

### Task 6: `src/registry.ts` + `src/index.ts` — wiring

**Files:** Create `src/registry.ts`, `src/index.ts`, `test/index.test.ts`.

**Interfaces:**
- `registry.ts`: `export const providerRegistry: Record<string, ProviderEntry>` with `"zhipuai-coding-plan": zhipuaiCodingPlan`.
- `index.ts`: `export function createHookHandler(deps: { config; now; send; logger }): (event: RetryEvent) => void` — dispatch by `event.model.providerID`, unknown/disabled → no-op, handler wrapped in try/catch (log error, leave decision).
- `export default Plugin.define({ id: "error-handler", setup(ctx) {...} })` — read config, build rpc sender, register ONE unfiltered `ctx.session.hook("retry", cb)`, cleanup disposes.

Tests: unknown provider → untouched; disabled provider → untouched; handler throws → decision untouched, no throw; `createHookHandler` end-to-end 1302/1308; `setup()` with fake ctx + HOME→temp registers exactly one `retry` hook and dispatches; enabled zhipuai works through setup (1302 path).

### Task 7: docs + final verification

**Files:** Create `config.example.json`; rewrite `README.md` (config reference, full zhipu code table, three-stage loading from AGENTS.md, notification rationale).

- Full `bun test` + `tsc --noEmit`; commit.
