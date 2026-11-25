# opencode-error-handler-plugin

Per-provider error handling for [OpenCode](https://opencode.ai) v2.

Reads provider API errors (HTTP status + raw response body), decides whether and
how long to retry, and pushes important failures to your phone via the
[remote-notifier plugin](https://github.com/heunghingwan/opencode-remote-notifier-plugin).

## Status

Early development — see [HANDOFF.md](./HANDOFF.md) for the verified design brief.

## Planned behavior (v1)

| Error | Behavior |
|---|---|
| Quota exhausted (e.g. Zhipu code `1308`) | Parse the reset time, wait in probing segments, auto-resume at reset, notify once per quota window |
| Rate limited (e.g. Zhipu code `1302`) | Retry with an extended backoff |
| Everything else | Leave OpenCode's built-in retry policy untouched |

Rules are organized per provider, so new providers get their own table without
touching the core.
