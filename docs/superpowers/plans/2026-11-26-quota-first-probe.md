# Quota First-Probe (Reset-Card Fast Recovery) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A session's first quota wait is a short probe (10 min), so a user who plays the zhipuai reset card right after the ⚠️ notification gets auto-recovery within 10 minutes — while the 5-segment wait still spans the 5-hour window.

**Architecture:** The pacing arithmetic in `src/budget.ts` gains a first-segment cap and a first-aware span, plus a bounded `FirstWaitRegistry` (my call: it lives in budget.ts with the rest of the wait-pacing concern). The provider handler wires the registry per (session × reset window) and rebalances `maxSegmentMs` 63→78 min so 10 min + 4 segments still spans the window.

**Tech Stack:** TypeScript, bun test, `tsc --noEmit`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-26-quota-first-probe-design.md`

## Global Constraints

- `bun test` and `bun run typecheck` green at every commit.
- Code comments in English; user-facing notification copy in Traditional Chinese (repo convention).
- Exact values (verbatim): `firstSegmentMs: 600_000`, `maxSegmentMs: 4_680_000` (78 min), `waitSegments: 7`, `reserve: 5`, `minSegmentMs: 60_000`, landing slack 60_000 ms (unchanged), FirstWaitRegistry cap 256, stale-prune threshold 3_600_000 ms past the reset epoch.
- Unchanged: reserve probes, landing slack, dedup keys, `WaitScheduled` shape, rate-limit backoff.
- Release: version 0.7.0 on the final commit, push to origin, then refresh the global OpenCode git-plugin install (user request: 完成後更新opencode插件).

## Review Focus

1. First probe must not oversleep a short window — remaining ≤ `firstSegmentMs` → the proportional share wins the `min`. Test: Task 1.
2. `segments === 1` is exempt — the landing segment keeps its +1 min slack and is never split. Tests: Task 1 and Task 2 (existing attempt-6 test stays 2_460_000).
3. Registry is per session — a second session in the same window still gets its own first probe. Test: Task 2.
4. Old config files without `firstSegmentMs` merge to the default 600_000. Test: Task 3.
5. Long-lived server: the registry stays bounded (stale prune an hour past reset + FIFO cap). Test: Task 1.

---

### Task 1: budget.ts — first-probe arithmetic + FirstWaitRegistry

**Files:**
- Modify: `src/types.ts` (QuotaConfig gains one field)
- Modify: `src/budget.ts`
- Test: `test/budget.test.ts`

**Interfaces:**
- Produces: `QuotaConfig.firstSegmentMs: number` (doc comment: delay cap for a session's first wait in one quota window)
- Produces: `segmentDelay(remainingMs: number, segments: number, quota: QuotaConfig, first?: boolean): number` (default `false`; existing 3-arg call sites compile unchanged)
- Produces: `maxSpanMs(segments: number, quota: QuotaConfig, first?: boolean): number`
- Produces: `class FirstWaitRegistry { constructor(cap?: number); isFirst(key: string, expiresAt: number, now: number): boolean }` — true the first time a key is seen; prunes entries whose `expiresAt < now − 3_600_000` on insert; FIFO-evicts oldest past the cap (mirror `NotifyGate` in `src/notify.ts`).

- [ ] **Step 1: Write the failing tests**

The QUOTA fixture in `test/budget.test.ts` is `{ waitSegments: 7, reserve: 3, minSegmentMs: 60_000, maxSegmentMs: 2_700_000 }` — add `firstSegmentMs: 600_000` to it (typecheck forces this anyway), then add:

```ts
describe("segmentDelay first probe", () => {
  test("first wait of a window is capped at firstSegmentMs", () => {
    // share = ceil(18_000_000 / 5) = 3_600_000 → capped to 600_000
    expect(segmentDelay(18_000_000, 5, QUOTA, true)).toBe(600_000)
  })
  test("short window: proportional share beats the cap", () => {
    // share = ceil(1_800_000 / 5) = 360_000 < 600_000
    expect(segmentDelay(1_800_000, 5, QUOTA, true)).toBe(360_000)
  })
  test("segments === 1 is exempt (landing segment never split)", () => {
    // 20 min + 1 min landing slack, NOT 600_000
    expect(segmentDelay(1_200_000, 1, QUOTA, true)).toBe(1_260_000)
  })
  test("non-first waits stay proportional", () => {
    expect(segmentDelay(9_000_000, 5, QUOTA, false)).toBe(1_800_000)
  })
})

describe("maxSpanMs first-aware", () => {
  test("window entry: firstSegmentMs + (segments−1) × maxSegmentMs", () => {
    expect(maxSpanMs(5, QUOTA, true)).toBe(600_000 + 4 * 2_700_000) // 11_400_000
  })
  test("mid-window and single-segment spans unchanged", () => {
    expect(maxSpanMs(5, QUOTA, false)).toBe(13_500_000)
    expect(maxSpanMs(1, QUOTA, true)).toBe(2_700_000)
  })
})

describe("FirstWaitRegistry", () => {
  test("marks a key once", () => {
    const reg = new FirstWaitRegistry()
    expect(reg.isFirst("s1:w", NOW, NOW)).toBe(true)
    expect(reg.isFirst("s1:w", NOW, NOW)).toBe(false)
    expect(reg.isFirst("s2:w", NOW, NOW)).toBe(true)
  })
  test("entries stale an hour past their reset are pruned on insert", () => {
    const reg = new FirstWaitRegistry()
    reg.isFirst("s3:stale", NOW - 3_600_001, NOW)
    reg.isFirst("s4:fresh", NOW, NOW) // insert triggers the prune
    expect(reg.isFirst("s3:stale", NOW, NOW)).toBe(true)
  })
  test("FIFO cap evicts the oldest", () => {
    const capped = new FirstWaitRegistry(2)
    capped.isFirst("a", NOW, NOW); capped.isFirst("b", NOW, NOW)
    capped.isFirst("c", NOW, NOW)
    expect(capped.isFirst("a", NOW, NOW)).toBe(true)
  })
})
```

(`NOW` = any fixed epoch; define locally if the file lacks one.)

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/budget.test.ts`
Expected: FAIL — `firstSegmentMs` missing from the fixture type, 4th argument ignored / `FirstWaitRegistry` not exported.

- [ ] **Step 3: Implement in `src/budget.ts` and `src/types.ts`**

`types.ts`: add the field with its doc comment. `budget.ts`:
- `segmentDelay`: after `raw = Math.ceil(remainingMs / segments)`, insert `if (first && segments >= 2) raw = Math.min(quota.firstSegmentMs, raw)`; clamps and the landing-slack line unchanged.
- `maxSpanMs`: `first && segments >= 2 ? quota.firstSegmentMs + (segments - 1) * quota.maxSegmentMs : segments * quota.maxSegmentMs`.
- `FirstWaitRegistry`: `#seen: Map<string, number>` key→expiresAt; `isFirst` returns false if present, else sets, prunes stale, FIFO-evicts past the cap, returns true.

- [ ] **Step 4: Run to verify pass**

Run: `bun test test/budget.test.ts`
Expected: PASS — existing tests untouched (they never pass `first`).

- [ ] **Step 5: Commit**

```bash
git add src/budget.ts src/types.ts test/budget.test.ts docs/superpowers/
git commit -m "feat(quota): first-probe cap, first-aware span, FirstWaitRegistry"
```

(`docs/superpowers/` carries the spec and this plan.)

### Task 2: provider handler — registry wiring, new defaults, reset-card copy

**Files:**
- Modify: `src/providers/zhipuai-coding-plan.ts`
- Test: `test/zhipuai-handler.test.ts`

**Interfaces:**
- Consumes: Task 1's `segmentDelay(…, first)`, `maxSpanMs(…, first)`, `FirstWaitRegistry`.
- Produces: first event of a (session, window) waits `min(firstSegmentMs, share)`; the copy changes below.

- [ ] **Step 1: Write the failing tests; update stale assertions**

RESET_A is 7,812,000 ms ahead; `harness()` builds a fresh handler (fresh registry, fixed clock `NOW`). New tests in `describe("quota segmented waiting")`:

```ts
test("first wait of a window: 10-minute probe (reset-card fast recovery)", () => {
  const h = harness()
  const event = ev(body1308(RESET_A))
  h.handle(event)
  expect(event.decision).toEqual({ retry: true, delay: 600_000 })
  expect(h.sent[0]?.message).toContain("若使用重置卡提前重置，將於首段探測（10 分）自動恢復。")
})

test("second wait in the same window: proportional with the raised cap", () => {
  let now = NOW
  const handler = zhipuaiCodingPlan.createHandler(
    { now: () => now, send: () => true, logger: silentLogger, providerID: freshProviderID() },
    DEFAULT_CONFIG,
  )
  const first = ev(body1308(RESET_A))
  handler(first)
  expect(first.decision).toEqual({ retry: true, delay: 600_000 })
  now += 600_000
  const second = ev(body1308(RESET_A), { attempt: 3 })
  handler(second)
  // ceil((7_812_000 − 600_000) / 4) = 1_803_000
  expect(second.decision).toEqual({ retry: true, delay: 1_803_000 })
})

test("each session gets its own first probe in the same window", () => {
  const h = harness()
  h.handle(ev(body1308(RESET_A)))                       // ses_1 first probe
  const other = ev(body1308(RESET_A), { sessionID: "ses_2" })
  h.handle(other)
  expect(other.decision).toEqual({ retry: true, delay: 600_000 })
  const again = ev(body1308(RESET_A), { attempt: 3 })   // ses_1, window seen
  h.handle(again)
  expect(again.decision).toEqual({ retry: true, delay: 1_953_000 })
})

test("fail-fast copy names the first-aware span", () => {
  const h = harness()
  const event = ev(body1308("2099-06-01 12:00:00"))
  h.handle(event)
  expect(event.decision).toEqual({ retry: false })
  expect(h.sent[0]?.message).toContain("最長約 5 小時 22 分")
})
```

Update existing tests (grep `1_562_400`, `3_564_000`, `3_780_000` to find them all):
- "1308 at attempt 2" → delay `600_000` (was 1_562_400).
- "each event recomputes segments from its own attempt" → chain on one harness: handle an attempt-2 event first (registers the window), then the attempt-3 event still expects `1_953_000` (number unchanged).
- "other quota codes with reset times follow the same path" → `600_000`.
- "notify:false disables sends but keeps decisions" and "a throwing sender never breaks the decision" → `600_000`.
- Skew walkthrough (`let now` closure): delays become `[600_000, 4_305_000, 4_305_000, 4_305_000, 4_365_000, 60_000, 60_000]` (first probe; then ceil of remaining/4, /3, /2; landing segment +60 s; reserve probes). Update its inline comments.
- `DEFAULT_CONFIG` whole-object test → quota `{ waitSegments: 7, reserve: 5, minSegmentMs: 60_000, maxSegmentMs: 4_680_000, firstSegmentMs: 600_000 }`.
- "default quota arithmetic still spans the 5-hour window" → `maxSpanMs(usable, DEFAULT_CONFIG.quota, true)` = `19_320_000` (10 min + 4×78 min), comment updated.
- "reset time already past" (60_000) and "attempt 6 … landing slack" (2_460_000) — unchanged, they now double as the segments≤1/past-reset exemption tests.

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/zhipuai-handler.test.ts`
Expected: FAIL — new tests fail (no cap yet); old numbers stale.

- [ ] **Step 3: Implement in `src/providers/zhipuai-coding-plan.ts`**

- `DEFAULT_CONFIG.quota`: add `firstSegmentMs: 600_000`; `maxSegmentMs: 3_780_000` → `4_680_000`; rewrite the surrounding comments (first probe serves the reset card; 10 + 4×78 = 322 min spans the 5-h window with slow-clock margin).
- In `createHandler`: `const firstWaits = new FirstWaitRegistry()`; right after the `parseResetTime` guard: `const first = firstWaits.isFirst(`${event.sessionID}:${reset.raw}`, reset.epoch, deps.now())`.
- Pass `first` to `maxSpanMs` (fail-fast check) and `segmentDelay`; add `firstProbe: first` to the `quota wait scheduled` log fields.
- ⚠️ copy: `額度已用盡（錯誤碼 ${code}），將於 ${reset.raw}（UTC+8）重置。已排程分段等待與自動恢復：額度恢復後將自動繼續任務。若使用重置卡提前重置，將於首段探測（${humanizeMs(config.quota.firstSegmentMs)}）自動恢復。`
- Fail-fast copy: `距重置時間尚有 ${humanizeMs(remaining)}，超出可等待範圍（最長約 ${humanizeMs(maxSpanMs(segments, config.quota, first))}），已停止重試。重置時間：${reset.raw}。`
- Update the file header comment (pacing story: first probe 10 min, then 4 × ≤78 min proportional, landing slack, reserve probes).

- [ ] **Step 4: Run to verify pass**

Run: `bun test test/zhipuai-handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/zhipuai-coding-plan.ts test/zhipuai-handler.test.ts
git commit -m "feat(zhipuai): 10-minute first probe with reset-card recovery copy"
```

### Task 3: config merge + example

**Files:**
- Modify: `src/config.ts`
- Modify: `config.example.json`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: `QuotaConfig.firstSegmentMs` (Task 1).
- Produces: `error-handler.json` users may set `quota.firstSegmentMs`; old files merge to the default.

- [ ] **Step 1: Write the failing tests**

User config `{"providers":{"zhipuai-coding-plan":{"quota":{"firstSegmentMs": 300000}}}}` → merged `firstSegmentMs` = 300_000. Bogus values (`-1`, `"x"`) and the field absent → 600_000. Existing whole-object quota fixtures in the file gain `firstSegmentMs: 600_000` (typecheck points them out).

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/config.test.ts`
Expected: FAIL — merged config lacks the field.

- [ ] **Step 3: Implement**

`mergeQuota`: `merged.firstSegmentMs = numInRangeOr(q.firstSegmentMs, 0, fallback.firstSegmentMs)`.
`config.example.json`: add `"firstSegmentMs": 600000` to the quota object.

- [ ] **Step 4: Run to verify pass**

Run: `bun test test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts config.example.json test/config.test.ts
git commit -m "feat(config): quota.firstSegmentMs range-checked merge"
```

### Task 4: README, release, global plugin update

**Files:**
- Modify: `README.md`
- Modify: `package.json`

- [ ] **Step 1: Update README**

Quota section: the 10-min first probe (reset-card story), pacing 10 → ~73 → ~73 → ~72 → 73 min (+1 landing slack), span `10 + 4×78 = 322 min` ≥ 5 h + slow-clock margin, `firstSegmentMs` in the config JSON block and the config reference bullets; refresh the test count.

- [ ] **Step 2: Full verification**

Run: `bun test && bun run typecheck`
Expected: all tests PASS, typecheck clean.

- [ ] **Step 3: Version bump**

`package.json` `"version": "0.6.0"` → `"0.7.0"`.

- [ ] **Step 4: Commit and push**

```bash
git add README.md package.json
git commit -m "feat(quota): reset-card fast recovery via 10-minute first probe (0.7.0)"
git push origin HEAD
```

- [ ] **Step 5: Update the global OpenCode plugin install**

The plugin is installed as `opencode-error-handler-plugin@git+https://github.com/heunghingwan/opencode-error-handler-plugin.git` in `~/.config/opencode/opencode.jsonc`. Discover the refresh mechanism (check `opencode --help` for a plugin command; else locate the cached git install under `~/.cache/opencode/` and force a re-fetch) and run it. Verify: the installed copy's `package.json` shows version 0.7.0.
