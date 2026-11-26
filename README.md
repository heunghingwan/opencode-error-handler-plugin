# opencode-error-handler-plugin

Per-provider error handling for [OpenCode](https://opencode.ai) v2.

Hooks `session.retry`, parses provider API errors (HTTP status + raw response
body), and customizes the retry decision per provider: quota errors wait in
probing segments until the quota resets and then auto-resume; important
failures are pushed through the
[remote-notifier plugin](https://github.com/heunghingwan/opencode-remote-notifier-plugin)'s
RPC (switchable per provider).

## How it works

- One unfiltered `session.retry` hook; a registry dispatches by
  `event.model.providerID`. Providers the registry does not know (or that are
  disabled in the config) are never touched — OpenCode's built-in retry
  policy (exponential backoff, at most 10 retries) applies.
- Every rule lives in `src/providers/<providerID>.ts`. Adding a provider =
  adding one file + one line in `src/registry.ts`.
- Notifications go through remote-notifier's RPC and degrade silently when it
  is unavailable. Calls are fire-and-forget: notification trouble can never
  slow down or break the retry decision path. The RPC definition handed to
  OpenCode must be complete (`events: {}` + per-method JSON Schemas) —
  OpenCode compiles it eagerly, and an incomplete one throws inside
  `ctx.rpc(...)` and silently drops every notification.

## Zhipu GLM Coding Plan (`zhipuai-coding-plan`)

Zhipu errors are two-layered: HTTP status outside, business error code inside
the body as `{"error":{"code":"...","message":"..."}}`. OpenCode maps every
429 to `provider.rate-limit`, so this plugin parses the body's `error.code`
(classification from the
[official error-code table](https://docs.bigmodel.cn/cn/api/api-code)):

| Codes | Meaning | Behavior |
|---|---|---|
| `1302`, `1305` | rate-limit family: account per-model concurrency cap / platform overload of the model (the [rate-limit docs](https://docs.bigmodel.cn/cn/api/rate-limit) advise spacing out requests for both) | provider+model-wide exponential backoff (below) |
| `1308`, `1310`, `1316`–`1321` | quota window exhausted; the message carries a reset time (`next_flush_time`, Beijing time UTC+8) | segmented waiting (below) |
| `1113`, `1309`, `1311`, `1313`, `1314`, `1315` | fatal — a human must act (recharge, renew, change key/model, lift a fair-use limit) | fail fast + notification with the actionable hint |
| anything else | | OpenCode built-in (decision untouched) |

### Rate-limit backoff (`1302` / `1305`, per provider × model)

1302 means the account's concurrency cap **for that model** was hit
("当前模型的并发请求数已达到账户上限" —
[rate-limit docs](https://docs.bigmodel.cn/cn/api/rate-limit)); 1305 means the
model is overloaded **platform-wide** ("该模型当前访问量过大"). The official
advice for both is the same — space out requests to that model — so the
backoff is **exponential and shared process-wide per provider+model** and both
codes grow the same sequence: every 1302 or 1305 from any session (any
project, any worktree) calling the same model grows one curve, while a
limited `glm-5.3` never slows `glm-5.3-flash`:

- 30 s ×1.5 per consecutive rate limit: 30 s, 45 s, 68 s, 101 s, 152 s,
  228 s, 342 s, 513 s, then capped at 10 min
  (`baseMs=30_000`, `factor=1.5`, `maxMs=600_000`).
- `glm-5.3-flash` ships with a more lenient base (15 s — flash models have
  far higher concurrency caps); its sequence grows 15 s, 23 s, 34 s, …
  Any model can be retuned via `rateLimit.models`.
- The curve is gentle on purpose: agents spend most of their wall-clock
  running tools, which already spaces requests apart — so five sessions
  hitting the limit in the same burst stagger to 30/45/68/101/152 s, and
  only *sustained* limiting (a hammering loop with no tool time) climbs to
  the cap. `factor: 2` restores classic doubling if you want it harsher.
- Ten quiet minutes without a 1302/1305 on that model (`decayAfterMs`) reset
  the sequence to the base — that model was demonstrably no longer limited.
- The level lives in a module-scope registry keyed by `providerID/modelID`:
  OpenCode loads a plugin module once per server process, so all
  per-location instances share it. It never notifies (transient — it
  recovers alone) and is logged at info with the model, delay, and backoff
  level.

### Quota segmented waiting

OpenCode allows at most 10 retries, so waiting must be budgeted. The hook
sees the upcoming attempt number `A` (first failure → `A=2`), leaving `12-A`
schedulable retries. With the defaults, 5 decisions wait out the window and
5 are held in reserve.

- A session's **first wait in a window is a short probe** capped at
  `firstSegmentMs` (10 min by default): the coding plan's quota reset card
  recovers the quota at once, so a user who plays it right after the ⚠️
  notification gets auto-recovery at the first probe. The ⚠️ copy says so.
- Waiting segments: `12 − A − reserve`, capped at `waitSegments` (default:
  5 usable segments with `reserve=5`). Proportional pacing: each segment
  sleeps `time-until-reset / segments-still-available`, clamped to
  `[minSegmentMs, maxSegmentMs]` (60 s … 78 min by default; a 5-hour window
  hit at entry paces 10 → ~73 → ~73 → ~72 → 73 min). Every wake-up
  makes a real API call, so recovery is detected immediately.
- The **last** wait segment lands one minute past the claimed reset
  (landing slack): with only seconds of clock skew the first probe meets an
  already-reset quota — the fast recovery path.
- Reset due but still quota-limited (local clock ahead of the server, or a
  late flush): the held-back reserve becomes **one-minute probes** — an
  aggregate ~6 minutes of skew tolerance (1 min slack + 5 probes). The final
  probe carries the "quota did not recover" notification; if it fails,
  retrying stops.
- When the session's next turn succeeds, a ✅ **recovery notification**
  (priority 3) closes the loop — on the ⚠️ window announcement, and on the
  ❌ final-probe one when that probe succeeds.
- A 5-hour window (1308 and friends) fits the 10 min first probe +
  4 × 78 min = 322 min span — the window plus a slow-clock margin.
  Weekly/monthly windows (1310, 1317, …) exceed it: the session fails fast
  and the notification says when the quota resets.
- A reset time already in the past clamps to the minimum segment (probe).
- Still quota-limited with the reset still ahead of one probe and the
  budget spent (a moved reset) → fail fast, with one "quota did not
  recover" notification.

### Notifications

| Event | Copy | Priority | Dedup |
|---|---|---|---|
| quota window entered (waiting scheduled) | reset time + auto-recovery scheduled + reset-card hint | 4 | once per reset window (key: the parsed reset timestamp) |
| quota still limited once the reset is due (final reserve probe scheduled) | quota did not recover | 5 | once per reset window |
| quota window unreachable (weekly/monthly, or reset moved ahead) | too far to wait, reset time | 5 | once per reset window |
| quota recovered (the session's next turn succeeds after a wait) | recovered, auto-resumed | 3 | once per tracked wait |
| fatal code | provider message + actionable hint | 5 | once per hour per code |

`notify: false` per provider turns all of this off — for providers whose
errors have no remedy (no reset card, no renewal), a notification has no
action value. Zhipu defaults to `notify: true` because its coding plan has a
quota reset card.

## Configuration

`~/.config/opencode/error-handler.json` (strict JSON; template:
[`config.example.json`](./config.example.json)):

```json
{
  "providers": {
    "zhipuai-coding-plan": {
      "enabled": true,
      "notify": true,
      "quota": { "waitSegments": 7, "reserve": 5, "minSegmentMs": 60000, "maxSegmentMs": 4680000, "firstSegmentMs": 600000 },
      "rateLimit": { "baseMs": 30000, "factor": 1.5, "maxMs": 600000, "decayAfterMs": 600000 }
    }
  }
}
```

- File missing or unparsable → every registered provider runs on its own
  defaults (zhipuai enabled, notify on).
- File present, provider unlisted → that provider is disabled.
- Listed providers merge field-by-field over their defaults; bogus or
  out-of-range values fall back (e.g. `maxSegmentMs < minSegmentMs` or
  `rateLimit.maxMs < baseMs` revert both).
- `quota.waitSegments` caps the waiting segments; the usable count is
  `min(waitSegments, 10 − reserve)`. The defaults (5 usable + 5 reserve)
  saturate OpenCode's 10-retry budget exactly.
- `quota.firstSegmentMs` caps a session's first wait in one window (the
  reset-card recovery probe); the four later segments each carry at most
  `maxSegmentMs`, so the two together must still span the windows you care
  about.
- `rateLimit` tunes the per-model 1302 backoff (shared per provider+model):
  first delay `baseMs`, multiplied by `factor` (≥ 1, default 1.5) per
  consecutive rate limit up to `maxMs`, resetting to the base after
  `decayAfterMs` without a rate limit.
- `rateLimit.models` overrides any subset of those fields per model id,
  merged over the provider-level values (and over the shipped
  `glm-5.3-flash` base of 15 s):

  ```json
  "rateLimit": {
    "baseMs": 30000,
    "factor": 1.5,
    "maxMs": 600000,
    "decayAfterMs": 600000,
    "models": { "glm-5.3-flash": { "baseMs": 15000 }, "glm-5.3": { "factor": 2 } }
  }
  ```

## Loading (three stages)

**⚠️ Plugin source never lives under `.opencode/`** — OpenCode auto-loads
every `.ts`/`.js` in a config directory's `plugin(s)/` subdirectory, and a
work-in-progress retry plugin must never take effect by accident.

1. **Development (no auto-loading):** this repo contains no config pointing
   at itself.
2. **Live testing:** in a *disposable test directory* (outside this repo),
   put an `opencode.jsonc` with
   `"plugins": ["file:///path/to/opencode-error-handler-plugin"]`
   and open a session there to trigger/simulate errors. Source edits hot-reload.
3. **Production:** in the global `~/.config/opencode/opencode.jsonc`, add
   `"opencode-error-handler-plugin@git+https://github.com/heunghingwan/opencode-error-handler-plugin.git"`.

## Development

```bash
bun install
bun test        # 144 tests
bun run typecheck
```

Pure TypeScript; the only runtime dependency is `@opencode/plugin`.
Structure: `src/` (index + providers + modules), `test/` (bun test).

## Logging

OpenCode plugins have no server-log API and plugin console output is discarded
under the background service, while **recovered retries leave no trace in
OpenCode's database** — so the plugin keeps its own JSONL audit log:

- **Path**: `~/.local/share/opencode/log/error-handler.log` (override with the
  `ERROR_HANDLER_LOG` environment variable; rotates at 2 MiB to `.log.1`)
- **Every decision**: each `session.retry` event with the parsed code, attempt,
  decision (wait segment count + delay, extended backoff, fail-fast, or
  "built-in"), and the parsed reset time
- **Quota recovery**: the session's next successful turn after a scheduled wait
  is logged as `quota recovered — session resumed` with the total wait
- **Notification outcomes**: delivered / not delivered, and dedup-window
  rollback when the remote-notifier RPC was unavailable (a failed delivery
  re-attempts on the next retry event instead of losing the window's only
  notification — covers plugin install/update timing gaps)
