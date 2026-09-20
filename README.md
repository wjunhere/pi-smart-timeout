# pi-smart-timeout

Content-aware shell command timeouts for [Pi](https://pi.dev).

Pi's `bash` tool has **no default timeout** — `timeout` is an optional parameter the
model has to remember to pass, and it usually doesn't. When a command hangs (a bare
REPL, `tail -f`, a stalled network call, an interactive prompt), nothing kills it and
the agent sits there until you interrupt by hand.

This extension caps every `bash` and `powershell` call so Pi's own process-tree kill
fires and the tool returns `Command timed out after N seconds`. The model sees the
error and recovers on its own.

## Install

```bash
pi install npm:pi-smart-timeout
```

Or load it for a single run:

```bash
pi -e npm:pi-smart-timeout
```

## Why "smart"

A single blunt number has an obvious failure mode: low enough to catch hangs and it
kills your `cargo build`; high enough to let builds finish and it doesn't catch hangs.
So the cap is chosen per command.

Decision order — first match wins:

| # | Condition | Applied cap |
|---|-----------|-------------|
| 1 | mode is `off` | nothing injected |
| 2 | the model supplied `timeout` | used as-is, clamped to `maxSeconds` |
| 3 | the command contains `timeout N ...` | `N + graceSeconds` |
| 4 | the command looks long-running | `longSeconds` (default 1800) |
| 5 | anything else | `defaultSeconds` (default 120) |

Hangs are caught, and a 20-minute build is not.

### Case 3 in detail

If the command already guards itself, the outer cap gets out of the way so the inner
guard fires first and you get a precise error instead of an ambiguous kill:

```
timeout 2m cargo build     ->  150   (120 + 30 grace)
timeout -s KILL 90 job     ->  120
/usr/bin/timeout 45 job    ->   75
echo "timeout 5"           ->  120   (quoted, not a guard)
timeout 0 npm install      -> 1800   (coreutils: `timeout 0` means no limit)
```

Option values are tokenized properly rather than matched with one regex, so `-s KILL`
and `--kill-after=5s` are not misread as the duration.

### It also tells the model

The policy is appended to the system prompt each turn, so instead of being silently
killed the model knows to pass `timeout` for long work, and knows not to re-run a
timed-out command unchanged. This turns a hard kill into a recoverable error.

## Configuration

Settings are merged over built-in defaults. Project settings only apply to trusted
projects.

**`~/.pi/agent/settings.json`** (global) or **`<cwd>/.pi/settings.json`** (project):

```json
{
  "smartTimeout": {
    "mode": "long",
    "defaultSeconds": 120,
    "longSeconds": 1800,
    "maxSeconds": 3600,
    "graceSeconds": 30,
    "longPatterns": ["\\bmy-slow-tool\\b", "scripts/nightly\\.sh"]
  }
}
```

| Key | Default | Meaning |
|-----|---------|---------|
| `mode` | `"long"` | `"long"`, `"short"` (cap everything at `defaultSeconds`), or `"off"` (never inject) |
| `defaultSeconds` | `120` | Cap for ordinary commands |
| `longSeconds` | `1800` | Cap for long-running commands |
| `maxSeconds` | `3600` | Hard ceiling applied even to model-supplied values. `0` disables it |
| `graceSeconds` | `30` | Headroom added on top of a detected inner `timeout N` |
| `longPatterns` | `[]` | Extra regexes (matched against the raw command) marking it long-running |

Environment variables work too and sit *below* settings files:
`PI_BASH_TIMEOUT_SEC`, `PI_BASH_TIMEOUT_LONG_SEC`, `PI_BASH_TIMEOUT_MAX_SEC`,
`PI_BASH_TIMEOUT_MODE`, `PI_BASH_TIMEOUT_LOG` (append one line per decision — useful
for verifying what was applied).

Invalid values are rejected with a warning and fall back to defaults; a malformed
`settings.json` never breaks startup.

## Commands

```
/bash-timeout                   show current configuration
/bash-timeout off               disable capping for this session
/bash-timeout short             cap everything at defaultSeconds
/bash-timeout long              restore content-aware capping
/bash-timeout reload            re-read settings.json without restarting
```

## What it does not do

- **It can't make Pi have a default timeout.** Pi's `bash` schema is
  `timeout?: number` with no default; only injecting the field changes behavior.
- **It won't kill deliberately detached work.** `nohup x &` leaves a process outside
  the killed tree. That is usually what you want.
- **It doesn't stop output flooding.** It caps duration, not volume. Pi truncates
  output on its own (2000 lines / 50KB, full output saved to a temp file).
- **`timeout 0 cmd` is not treated as a guard**, because coreutils reads it as "no
  timeout" — so the outer cap still applies.

## Tests

```bash
npm install
npm test          # fast: decision table + config + notifications   (~2s)
npm run test:e2e  # slow: real kill path, spawns and kills processes (~2min)
```

| Suite | What it covers |
|-------|----------------|
| `tests/logic.test.mts` | 55-case decision table: classification, inner-guard parsing, clamping, mode switching, system-prompt injection |
| `tests/config.test.mts` | settings.json layering, project trust gating, validation, malformed input, `/bash-timeout reload` |
| `tests/ui.test.mts` | notifications, `hasUI: false`, malformed tool input |
| `tests/e2e.test.mts` | drives Pi's real `createBashTool`: verifies 15 blocking scenarios are actually killed, that no orphaned grandchildren survive, and that fast commands and 3s commands under a 6s cap are *not* killed |

The e2e suite asserts on real process state, not mocks: it reads `taskkill`ed process
tables via WMI to confirm the whole tree dies.

## License

MIT
