# Quota first-probe (reset card fast recovery) — design

Date: 2026-11-26
Status: approved

## Intent and why

The zhipuai coding plan has a **reset card**: quota exhaustion is actionable
immediately — the user resets on the website and the quota recovers at once.
Today the segmented wait is purely proportional, so a 5-hour window (1308 and
friends) hit at entry sleeps ~60 min before its first probe; a user who plays
the reset card right after the ⚠️ notification still waits up to an hour for
the session to notice.

Goal: **if the card is played within the first 10 minutes, the session
auto-recovers at the 10-minute first probe.**

## Goals / non-goals

- Goal: a fixed short first wait segment (10 min) for a session's first wait
  in a quota window, then proportional pacing as today.
- Goal: still span the 5-hour window within OpenCode's 10-retry budget, with
  the same class of slow-clock margin as now.
- Non-goal: detecting a mid-window card reset faster than the next segment
  wake-up (accepted trade-off — the ⚠️ notification lands at t=0, so a user
  who acts on it acts within minutes).
- Non-goal: changes to rate-limit backoff, fatal handling, reserve probes, or
  the recovery-notification mechanics.

## Approaches considered

1. **Steal a decision from the reserve** (reserve 5→4 ⇒ 6 usable segments,
   10 + 5×63 = 325 min span). Rejected: spends the five one-minute skew
   probes that guard clock skew / late flush after the claimed reset.
2. **Keep 5 segments, lengthen the per-segment span** (maxSegmentMs 63→78 min,
   10 + 4×78 = 322 min span). **Picked** (user decision): reserve stays
   intact; the four subsequent segments lengthen to ~72–73 min for the 5-hour
   window.
3. Cap every segment at 10 min — cannot span 5 h with 10 decisions; dropped
   early.

## Design

- `QuotaConfig` gains **`firstSegmentMs`** (default `600_000` = 10 min),
   merged through the existing range-checked `numInRangeOr` pattern.
- First-segment delay = `min(firstSegmentMs, ceil(remaining / segments))`,
  clamped to `[minSegmentMs, maxSegmentMs]`; applied **only when
  `segments ≥ 2`** — the `segments === 1` landing segment keeps its +1 min
  landing slack and must not be split (splitting it can fail-fast before the
  reset lands).
- **`maxSegmentMs` 3_780_000 → 4_680_000 (78 min)**: 10 + 4×78 = 322 min
  ≥ 5 h + 15-min slow-clock margin-class tolerance (was 5×63 = 315). 78 is
  the smallest clean value satisfying 10 + 4×max ≥ 315 (max ≥ 76.25).
- `maxSpanMs` becomes first-aware: `firstSegmentMs + (segments−1)×max` for the
  window-entry check, `segments×max` otherwise.
- The pacing is stateless today, so "is this the window's first wait" needs a
  small per-**(session × reset window)** registry in the provider handler,
  FIFO-bounded like `NotifyGate`; first sighting of a `sessionID:resetRaw`
  key gets the cap, subsequent waits stay proportional. Independent sessions
  each get their own first probe.
- The ⚠️ window notification gains one sentence: a card reset within the
  first segment auto-recovers at the first probe (copy uses the configured
  `firstSegmentMs`, not a hardcoded 10).
- Unchanged: `waitSegments: 7`, `reserve: 5`, 1-min landing slack, the five
  1-min reserve probes once the reset is due, all dedup keys.

### 5-hour window pacing after the change (entry at attempt 2)

10 (first probe) → 73 → 73 → 72 → 73 (+1 landing slack) ≈ 301 min, landing
1 min past the claimed reset — same landing behavior as today.

## Constraints

- OpenCode's hard 10-retry ceiling (a plugin cannot raise it).
- Config backward compatibility: existing `error-handler.json` files without
  `firstSegmentMs` merge to the new default.
- `firstSegmentMs` outside sane bounds degrades harmlessly (clamped by
  `[minSegmentMs, maxSegmentMs]`), per the config file's fallback philosophy.

## Tests

- `budget.test.ts`: first-probe cap (`min` vs. proportional), segments ≥ 2
  guard, first-aware `maxSpanMs`.
- `zhipuai-handler.test.ts`: first event waits 10 min, second waits
  proportional with the raised max, per-session registry isolation,
  segments=1 not capped, fail-fast span math first-aware.
- `config.test.ts`: `firstSegmentMs` merge and fallback.

README: quota section numbers, config example, and the reset-card sentence.
