# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
