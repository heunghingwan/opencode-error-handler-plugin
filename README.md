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
  slow down or break the retry decision path.

## Zhipu GLM Coding Plan (`zhipuai-coding-plan`)

Zhipu errors are two-layered: HTTP status outside, business error code inside
the body as `{"error":{"code":"...","message":"..."}}`. OpenCode maps every
429 to `provider.rate-limit`, so this plugin parses the body's `error.code`
(classification from the
[official error-code table](https://docs.bigmodel.cn/cn/api/api-code)):

| Codes | Meaning | Behavior |
|---|---|---|
| `1302` | account rate limit | retry after 30 s |
| `1305` | model overloaded | OpenCode built-in backoff |
| `1308`, `1310`, `1316`–`1321` | quota window exhausted; the message carries a reset time (`next_flush_time`, Beijing time UTC+8) | segmented waiting (below) |
| `1113`, `1309`, `1311`, `1313`, `1314`, `1315` | fatal — a human must act (recharge, renew, change key/model, lift a fair-use limit) | fail fast + notification with the actionable hint |
| anything else | | OpenCode built-in (decision untouched) |

### Quota segmented waiting

OpenCode allows at most 10 retries, so waiting must be budgeted. The hook
sees the upcoming attempt number `A` (first failure → `A=2`), leaving `12-A`
schedulable retries.

- Waiting segments may only be scheduled while `A ≤ 8`
  (`waitSegments=7` waiting decisions, keeping `reserve=3` real retries for
  trouble *after* the reset, e.g. network problems).
- Proportional pacing: each segment sleeps
  `time-until-reset / segments-still-available`, clamped to
  `[minSegmentMs, maxSegmentMs]` (60 s … 45 min by default). Every wake-up
  makes a real API call, so recovery is detected immediately.
- A 5-hour window (1308 and friends) fits the 7 × 45 min span and is waited
  out fully. Weekly/monthly windows (1310, 1317, …) exceed it: the session
  fails fast and the notification says when the quota resets.
- A reset time already in the past clamps to the minimum segment (probe).
- Still quota-limited after the waiting budget is spent → fail fast, with one
  "quota did not recover after reset" notification.

### Notifications

| Event | Copy | Priority | Dedup |
|---|---|---|---|
| quota window entered (waiting scheduled) | reset time + auto-recovery scheduled | 4 | once per reset window (key: the parsed reset timestamp) |
| still quota-limited after budget spent | quota did not recover | 5 | once per reset window |
| quota window unreachable (weekly/monthly) | too far to wait, reset time | 5 | once per reset window |
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
      "quota": { "waitSegments": 7, "reserve": 3, "minSegmentMs": 60000, "maxSegmentMs": 2700000 }
    }
  }
}
```

- File missing or unparsable → every registered provider runs on its own
  defaults (zhipuai enabled, notify on).
- File present, provider unlisted → that provider is disabled.
- Listed providers merge field-by-field over their defaults; bogus or
  out-of-range values fall back (e.g. `maxSegmentMs < minSegmentMs` reverts
  both).
- `quota.waitSegments + quota.reserve` must stay within OpenCode's 10-retry
  budget to mean anything; the defaults (7+3) saturate it exactly.

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
bun test        # 71 tests
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
