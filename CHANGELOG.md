# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-09-22

### Changed

- `LONG_RUNNING` heuristics no longer match bare English words. `go` and `make`
  only count as the command word (after a separator or `sudo`/`time`/`nohup`/`env`),
  so `grep -rn 'make sure' src/`, `ls | grep go`, `cd x && find . -name '*.go'`
  and friends stay in the 120s default bucket instead of being promoted to 1800s.
  The media/archival pattern was anchored the same way, and `convert`
  (ImageMagick's legacy name, more often an English word) was removed.
- Heuristics now match against the command with quoted text blanked out, so
  `echo 'sleep 300'` and `grep -n 'sleep 30' script.sh` are no longer mistaken
  for actual sleeps.
- `ssh` and `ssh-keygen` were removed from the long-running set: ssh hangs on
  password/host-key prompts and unreachable hosts — exactly the failure the
  default cap exists to catch — and ssh-keygen is instant. `curl`/`wget` also
  stay in the default bucket now (previously `-o`/`-O` promoted them): a
  stalled download is caught sooner, and a large one can pass an explicit
  `timeout`.
- Bounded poll loops (`until ping -c1 host; do sleep 10; done`) now get the
  long bucket even though each `sleep N` term is small. Unconditioned
  `while true` loops keep the default cap — they are a hang by definition.
- The inner `timeout N` guard is now clamped to `maxSeconds` like every other
  path (`timeout 99999 cat` used to apply a ~27.7h cap, bypassing the ceiling).
  The old comment claiming clamping would race the inner guard was wrong: when
  `N` exceeds the ceiling the guard could not fire before it anyway.
- Quote detection in the inner-guard parser resets at command separators
  (`;`, `|`, `&`, backtick, newline) and rescans only the current segment, so
  `sh -c 'echo "a"; timeout 7 sleep 9'` finds its guard again.
- The system-prompt policy now asks the model to pass `timeout` whenever a
  command *might* outlast the default cap, and frames the long bucket as what
  commands known to run long receive — not as a blanket allowance.
- CI: the Windows e2e job also runs on pushes to `main`, not only on PRs and
  tag pushes.

### Added

- `npm run typecheck` (`tsc --noEmit` over the extension and tests, with a
  `tsconfig.json`), run as part of `npm test`.

### Fixed

- `tests/ui.test.mts` is isolated from the developer's real global
  `settings.json` via a temporary `PI_CODING_AGENT_DIR` (settings files
  outrank env vars, so the test was failing on machines with their own
  `smartTimeout` config).

## [0.1.1] - 2026-09-20

### Fixed

- Corrected the declared Node requirement to `>=22.19.0`. The package claimed
  `>=20`, but the Pi SDK it loads uses `fs.globSync`, which does not exist before
  Node 22, so installing on Node 20 produced a `SyntaxError` at import time
  rather than a clear unsupported-runtime error. Found by the new CI workflow.

[0.1.2]: https://github.com/wjunhere/pi-smart-timeout/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/wjunhere/pi-smart-timeout/compare/v0.1.0...v0.1.1

## [0.1.0] - 2026-09-20

Initial release.

### Added

- Content-aware command timeout capping via the `tool_call` event, for both `bash`
  and `powershell`. Commands are sorted into a default bucket (`defaultSeconds`,
  120s) and a long-running bucket (`longSeconds`, 1800s), so a low cap catches hangs
  without killing builds.
- Detection of a command's own `timeout N` guard, which is given `graceSeconds` of
  headroom so the inner guard fires first instead of racing the outer cap. Option
  values are tokenized, so `-s KILL` and `--kill-after=5s` are not misread as the
  duration, and `timeout 0` (coreutils: no limit) is not treated as a guard.
- Configurable hard ceiling (`maxSeconds`, 3600s) applied even to model-supplied
  timeouts. `0` disables it.
- System-prompt policy injection so the model asks for more time instead of being
  silently killed, and learns not to re-run a timed-out command unchanged.
- `smartTimeout` configuration in global (`~/.pi/agent/settings.json`) and project
  (`<cwd>/.pi/settings.json`) settings, layered with project taking precedence.
  Project settings apply only to trusted projects. Invalid values warn and fall back
  to defaults; malformed JSON never breaks startup.
- Environment variable configuration: `PI_BASH_TIMEOUT_SEC`,
  `PI_BASH_TIMEOUT_LONG_SEC`, `PI_BASH_TIMEOUT_MAX_SEC`, `PI_BASH_TIMEOUT_MODE`,
  and `PI_BASH_TIMEOUT_LOG` for decision logging.
- `/bash-timeout` command to show configuration and switch mode at runtime
  (`off`, `short`, `long`, `reload`).
- Test suites: a 55-case decision table, settings layering and validation tests,
  UI and malformed-input robustness tests, and an end-to-end suite that drives Pi's
  real bash tool to confirm blocking commands are killed with no orphaned
  grandchildren while legitimate work is left alone.

[0.1.0]: https://github.com/wjunhere/pi-smart-timeout/releases/tag/v0.1.0
