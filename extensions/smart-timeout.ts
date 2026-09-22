/**
 * smart-timeout — timeouts that fit the command, not a single blunt number.
 *
 * Pi's bash tool has no default timeout: `timeout` is an optional parameter the
 * model must supply, and it frequently does not. A hung command (a bare REPL,
 * `tail -f`, a stalled network call, an interactive prompt) then stalls the
 * agent until the user interrupts by hand.
 *
 * This extension caps every shell command so pi's own process-tree kill fires
 * and the tool reports `Command timed out after N seconds`, letting the model
 * recover on its own.
 *
 * Decision order (first match wins):
 *  1. mode "off"                       -> no cap at all
 *  2. model supplied `timeout`         -> used as-is, but clamped to maxSeconds
 *  3. command contains `timeout N ...` -> min(N + graceSeconds, maxSeconds) so the inner
 *                                        guard fires first, but never past the ceiling
 *  4. command looks long-running       -> longSeconds
 *  5. everything else                  -> defaultSeconds
 *
 * What is distinctive here:
 *  - The cap is content-aware. A 200ms `git status` and a 20-minute `cargo
 *    build` do not share one number, so aggressive caps stop killing real work.
 *  - A command's own `timeout N` wrapper is detected and given room, instead of
 *    racing it. Option values are tokenized properly, so `timeout -s KILL 90`
 *    and `timeout --kill-after=5s 25` are read correctly, and `timeout 0`
 *    (coreutils: no limit) is not mistaken for a guard.
 *  - The policy is explained to the model in the system prompt, so it asks for
 *    more time instead of being silently killed.
 *
 * Configuration, highest priority first:
 *  1. <cwd>/.pi/settings.json     -> { "smartTimeout": { ... } }  (trusted projects)
 *  2. ~/.pi/agent/settings.json   -> { "smartTimeout": { ... } }
 *  3. environment variables (below)
 *  4. built-in defaults
 *
 * Settings keys (all optional):
 *  - mode           "short" | "long" | "off"   default "long"
 *  - defaultSeconds number  default 120
 *  - longSeconds    number  default 1800
 *  - maxSeconds     number  default 3600, 0 = no ceiling
 *  - graceSeconds   number  default 30
 *  - longPatterns   string[]  extra regexes marking a command as long-running
 *
 * Environment variable equivalents:
 *  - PI_BASH_TIMEOUT_SEC, PI_BASH_TIMEOUT_LONG_SEC, PI_BASH_TIMEOUT_MAX_SEC,
 *    PI_BASH_TIMEOUT_MODE, PI_BASH_TIMEOUT_LOG
 *
 * Runtime: /bash-timeout [off|short|long|reload] to inspect or change mode.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

const GRACE_FALLBACK = 30;
const LOG_PATH = process.env.PI_BASH_TIMEOUT_LOG;
const SHELL_TOOLS = new Set(["bash", "powershell"]);

type Mode = "short" | "long" | "off";

interface Config {
	mode: Mode;
	defaultSeconds: number;
	longSeconds: number;
	maxSeconds: number;
	graceSeconds: number;
	longPatterns: RegExp[];
}

function envNumber(name: string, fallback: number, allowZero = false): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) return fallback;
	if (value === 0 && !allowZero) return fallback;
	return value;
}

function normalizeMode(raw: unknown): Mode | undefined {
	if (typeof raw !== "string") return undefined;
	const value = raw.trim().toLowerCase();
	return value === "short" || value === "off" || value === "long" ? value : undefined;
}

/** Built-in long-running heuristics. */
const LONG_RUNNING: RegExp[] = [
	// package managers / task runners
	/\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|ci|add|update|upgrade|dedupe|build|test|publish|run\s+\S+)\b/,
	/\b(?:pip|pip3|uv|conda|mamba|poetry|pipenv)\s+(?:install|sync|update|add|lock|create|run)\b/,
	/\b(?:apt|apt-get|dpkg|brew|choco|winget|pacman|dnf|yum|apk|snap)\s+\S/,
	/\bnpx\s+\S/,
	// compilers / build systems. `go` and `make` are also ordinary English words
	// ("make sure", `*.go`, `grep go`) and file names, so they only count when
	// they appear as the command word: start of command, after a separator, or
	// after a common prefix like sudo/time.
	/(?:^|[;&|(]\s*|\b(?:sudo|time|nohup|env)\s+)go\s+(?:build|test|run|vet|fmt|generate|mod|get|install|work|tool)\b/,
	/(?:^|[;&|(]\s*|\b(?:sudo|time|nohup|env)\s+)make(?:\s|$)/,
	/\b(?:cargo|rustc|dotnet|mvn|mvnw|gradle|gradlew|cmake|ninja|meson|bazel|buck)\b/,
	/\btsc\s+(?:--build|-b)\b|\bwebpack\b|\bvite\s+build\b|\bnext\s+build\b|\brollup\b|\besbuild\b/,
	// containers / infra / cloud CLIs
	/\b(?:docker|podman|nerdctl)\s+(?:build|compose|pull|run|up|push|logs\s+-f)\b/,
	/\b(?:vagrant|terraform|ansible-playbook|helm|kubectl|aws|gcloud|az)\s+\S/,
	/\bsystemctl\s+\S/,
	// VCS network ops / remote copy
	// VCS network ops / remote copy. Bare `ssh` and `ssh-keygen` are deliberately
	// absent: ssh hangs on password / host-key prompts and unreachable hosts --
	// exactly the failure the low default cap exists to catch -- and ssh-keygen
	// is instant. Pass an explicit timeout for long remote sessions.
	/\bgit\s+(?:clone|fetch|pull|push|submodule|lfs)\b/,
	/\b(?:scp|sftp|rsync)\b/,
	// tests / benchmarks
	/\b(?:pytest|py\.test|tox|nox|vitest|jest|mocha|playwright|cypress|rspec|phpunit|ctest)\b/,
	// Bounded wait/poll loops (`for x in ...; do sleep N; done`) whose sleep
	// terms are individually small but add up past the default cap. An
	// unconditioned `while true` loop is NOT promoted: it is a hang by
	// definition and the default cap should kill it quickly.
	/\b(?:for|until|while)\b(?![^\n|;&]*\b(?:true|:)\b)[^\n]*\bdo\b[^\n]*\bsleep\s+\S/,
	// downloads / long scans / waits / media. `curl`/`wget` are deliberately
	// absent: they hang on unreachable hosts far more often than they transfer
	// something big, so they stay in the fast default bucket (pass an explicit
	// `timeout` for a large download).
	/\b(?:watch|tail\s+-f|tail\s+-F|journalctl\s+-f|nvidia-smi\s+-l)\b/,
	/\b(?:python|python3|node|deno|ruby|php)\s+-m\s+(?:http\.server|json\.tool|timeit)\b/,
	/\bsleep\s+(?:[2-9]\d|\d{3,})\b/,
	// `convert` (ImageMagick's legacy name) is far more often an English word
	// than a command; ImageMagick 7 uses `magick`, which is unambiguous. `tar`
	// and `zip` must be the command word so `*.tar` / `*.zip` file names do not
	// match.
	/(?:^|[;&|(]\s*|\b(?:sudo|time|nohup|env)\s+)(?:ffmpeg|magick|7z|tar|zip)\b/,
	/\b(?:jupyter|pytest|sphinx|mkdocs)\b/,
];

function defaultConfig(): Config {
	const defaultSeconds = envNumber("PI_BASH_TIMEOUT_SEC", 120);
	const longSeconds = Math.max(envNumber("PI_BASH_TIMEOUT_LONG_SEC", 1800), defaultSeconds);
	return {
		mode: normalizeMode(process.env.PI_BASH_TIMEOUT_MODE) ?? "long",
		defaultSeconds,
		longSeconds,
		// 0 disables the ceiling; PI_BASH_TIMEOUT_MAX_SEC=0 is the documented way to ask for that.
		maxSeconds: envNumber("PI_BASH_TIMEOUT_MAX_SEC", 3600, true),
		graceSeconds: GRACE_FALLBACK,
		longPatterns: [],
	};
}

function readPositive(source: Record<string, unknown>, key: string, warnings: string[]): number | undefined {
	if (!(key in source)) return undefined;
	const value = source[key];
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	warnings.push(`smartTimeout.${key} must be a non-negative finite number`);
	return undefined;
}

/** Parse one settings.json file. Returns undefined when the key is absent. */
function readSettingsFile(path: string, label: string, warnings: string[]): Partial<Config> | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code !== "ENOENT") warnings.push(`could not read ${label}; ignoring it`);
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		warnings.push(`could not parse ${label}; ignoring it`);
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		warnings.push(`${label} is not a JSON object; ignoring it`);
		return undefined;
	}

	const section = (parsed as Record<string, unknown>).smartTimeout;
	if (section === undefined) return undefined;
	if (typeof section !== "object" || section === null || Array.isArray(section)) {
		warnings.push(`${label}.smartTimeout must be a JSON object; ignoring it`);
		return undefined;
	}

	const source = section as Record<string, unknown>;
	const out: Partial<Config> = {};

	const mode = normalizeMode(source.mode);
	if (mode !== undefined) out.mode = mode;
	else if ("mode" in source) warnings.push(`${label}.smartTimeout.mode must be "short", "long" or "off"`);

	const defaultSeconds = readPositive(source, "defaultSeconds", warnings);
	if (defaultSeconds !== undefined && defaultSeconds > 0) out.defaultSeconds = defaultSeconds;
	const longSeconds = readPositive(source, "longSeconds", warnings);
	if (longSeconds !== undefined && longSeconds > 0) out.longSeconds = longSeconds;
	// 0 is meaningful for maxSeconds: it disables the ceiling.
	const maxSeconds = readPositive(source, "maxSeconds", warnings);
	if (maxSeconds !== undefined) out.maxSeconds = maxSeconds;
	const graceSeconds = readPositive(source, "graceSeconds", warnings);
	if (graceSeconds !== undefined) out.graceSeconds = graceSeconds;

	if ("longPatterns" in source) {
		const patterns = source.longPatterns;
		if (Array.isArray(patterns)) {
			const compiled: RegExp[] = [];
			for (const pattern of patterns) {
				if (typeof pattern !== "string") {
					warnings.push(`${label}.smartTimeout.longPatterns entries must be strings`);
					continue;
				}
				try {
					compiled.push(new RegExp(pattern));
				} catch {
					warnings.push(`${label}.smartTimeout.longPatterns has an invalid regex: ${pattern}`);
				}
			}
			out.longPatterns = compiled;
		} else {
			warnings.push(`${label}.smartTimeout.longPatterns must be an array of regex strings`);
		}
	}

	return out;
}

/** Merge global then project settings over the env/default baseline. */
function loadConfig(cwd: string, projectTrusted: boolean): { config: Config; warnings: string[] } {
	const warnings: string[] = [];
	const base = defaultConfig();

	const globalSettings = readSettingsFile(join(getAgentDir(), "settings.json"), "global settings.json", warnings);
	const projectSettings = projectTrusted
		? readSettingsFile(join(cwd, CONFIG_DIR_NAME, "settings.json"), "project settings.json", warnings)
		: undefined;

	const merged: Config = { ...base };
	for (const layer of [globalSettings, projectSettings]) {
		if (!layer) continue;
		if (layer.mode !== undefined) merged.mode = layer.mode;
		if (layer.defaultSeconds !== undefined) merged.defaultSeconds = layer.defaultSeconds;
		if (layer.longSeconds !== undefined) merged.longSeconds = layer.longSeconds;
		if (layer.maxSeconds !== undefined) merged.maxSeconds = layer.maxSeconds;
		if (layer.graceSeconds !== undefined) merged.graceSeconds = layer.graceSeconds;
		if (layer.longPatterns !== undefined) merged.longPatterns = layer.longPatterns;
	}

	// longSeconds must never be below defaultSeconds, or the two buckets invert.
	if (merged.longSeconds < merged.defaultSeconds) {
		warnings.push("smartTimeout.longSeconds is below defaultSeconds; raising it to defaultSeconds");
		merged.longSeconds = merged.defaultSeconds;
	}

	return { config: merged, warnings };
}

let config: Config = defaultConfig();

function log(line: string): void {
	if (!LOG_PATH) return;
	try {
		appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
	} catch {
		// never let logging break a tool call
	}
}

function looksLongRunning(command: string): boolean {
	// Match the built-in heuristics against the command with quoted text
	// blanked out, so `grep -n 'sleep 30' script.sh` or `echo "make sure"`
	// cannot trip a pattern that is meant for the actual command words.
	const bare = stripQuotedText(command);
	if (LONG_RUNNING.some((re) => re.test(bare))) return true;
	// User-supplied patterns are explicit; run them against the raw command.
	return config.longPatterns.some((re) => re.test(command));
}

/**
 * Replace the contents of single- and double-quoted spans (and the quotes
 * themselves) with spaces, preserving offsets. Cheap and approximate, which
 * is fine: it only feeds the long-running heuristics, never the inner-guard
 * parser (which has its own quote handling).
 */
function stripQuotedText(command: string): string {
	const out = command.split("");
	let single = false;
	let double = false;
	for (let i = 0; i < out.length; i += 1) {
		const ch = out[i];
		if (ch === "\\" && (single || double)) {
			out[i] = " ";
			if (i + 1 < out.length) out[i + 1] = " ";
			i += 1;
			continue;
		}
		if (ch === "'" && !double) {
			single = !single;
			out[i] = " ";
		} else if (ch === '"' && !single) {
			double = !double;
			out[i] = " ";
		} else if (single || double) {
			out[i] = " ";
		}
	}
	return out.join("");
}

/**
 * True when `index` sits inside a single- or double-quoted span of the command.
 * Cheap heuristic that keeps `echo "timeout 5"` from being read as a guard.
 * Quote state resets at command separators (`;`, `|`, `&`, backtick, newline)
 * so a quote imbalance in one segment cannot mask a real guard in the next.
 */
const QUOTE_RESET_RE = /[;&|`\n]/g;
function isInsideQuotes(command: string, index: number): boolean {
	// Only the segment containing `index` matters; find where it starts.
	let segmentStart = 0;
	QUOTE_RESET_RE.lastIndex = 0;
	let sep: RegExpExecArray | null;
	while ((sep = QUOTE_RESET_RE.exec(command)) !== null && sep.index < index) {
		segmentStart = sep.index + 1;
	}

	let single = false;
	let double = false;
	for (let i = segmentStart; i < index; i += 1) {
		const ch = command[i];
		if (ch === "\\") {
			i += 1;
			continue;
		}
		if (ch === "'" && !double) single = !single;
		else if (ch === '"' && !single) double = !double;
	}
	return single || double;
}

const TIMEOUT_CMD_RE = /(?:^|[;&|(`\s])(?:\S*\/)?timeout\s+/g;
const DURATION_RE = /^(\d+(?:\.\d+)?)([smhd]?)$/;

/**
 * Extract `timeout 30 ...` / `timeout -k 5 2m ...` / `timeout -s KILL 5 ...`
 * from an already wrapped command so the inner guard gets room to fire first.
 *
 * Walks the argument list properly instead of using a single regex, so options
 * that take a value (`-k`, `-s`) cannot be mistaken for the duration.
 */
function parseInnerTimeout(command: string): number | undefined {
	TIMEOUT_CMD_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = TIMEOUT_CMD_RE.exec(command)) !== null) {
		const wordAt = match.index + match[0].lastIndexOf("timeout");
		if (isInsideQuotes(command, wordAt)) continue;

		const tokens = command.slice(match.index + match[0].length).split(/\s+/);
		let i = 0;
		while (i < tokens.length) {
			const token = tokens[i];
			if (!token) {
				i += 1;
				continue;
			}
			if (token.startsWith("-")) {
				// `-k DUR` / `-s SIG` take a separate value; `--kill-after=X` does not.
				const takesValue = /^(-k|--kill-after|-s|--signal)$/.test(token);
				i += takesValue ? 2 : 1;
				continue;
			}
			break;
		}

		const durationToken = tokens[i];
		if (!durationToken) continue;
		const duration = durationToken.match(DURATION_RE);
		if (!duration) continue;
		const value = Number(duration[1]);
		const unit = duration[2] || "s";
		const seconds =
			unit === "m" ? value * 60 : unit === "h" ? value * 3600 : unit === "d" ? value * 86400 : value;
		// `timeout 0 cmd` means "no timeout" in coreutils, so it is not a guard.
		if (Number.isFinite(seconds) && seconds > 0) return seconds;
	}
	return undefined;
}

type Plan = {
	timeout: number | undefined;
	reason: "off" | "model-specified" | "model-clamped" | "inner-guard" | "long-running" | "default";
};

function planTimeout(command: string, requested: number | undefined): Plan {
	if (config.mode === "off") return { timeout: requested, reason: "off" };

	const clamp = (seconds: number): number =>
		config.maxSeconds > 0 && seconds > config.maxSeconds ? config.maxSeconds : seconds;

	if (requested !== undefined) {
		const clamped = clamp(requested);
		return {
			timeout: clamped,
			reason: clamped === requested ? "model-specified" : "model-clamped",
		};
	}

	const inner = parseInnerTimeout(command);
	if (inner !== undefined) {
		// The inner `timeout N` should fire first, so it gets graceSeconds of
		// headroom -- but the hard ceiling is absolute and applies here too. When
		// N exceeds maxSeconds the inner guard could not fire before the ceiling
		// anyway, so clamping never creates a race with the inner guard.
		return {
			timeout: clamp(Math.ceil(inner) + config.graceSeconds),
			reason: "inner-guard",
		};
	}

	if (config.mode !== "short" && looksLongRunning(command)) {
		return { timeout: clamp(config.longSeconds), reason: "long-running" };
	}

	return { timeout: clamp(config.defaultSeconds), reason: "default" };
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const loaded = loadConfig(ctx.cwd, ctx.isProjectTrusted());
		config = loaded.config;
		if (loaded.warnings.length > 0 && ctx.hasUI) {
			ctx.ui.notify(`smart-timeout: ${loaded.warnings.join("; ")}`, "warning");
		}
	});

	pi.registerCommand("bash-timeout", {
		description: "Show or set the smart-timeout mode: /bash-timeout [off|short|long|reload]",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();

			if (arg === "reload") {
				const loaded = loadConfig(ctx.cwd, ctx.isProjectTrusted());
				config = loaded.config;
				for (const warning of loaded.warnings) ctx.ui.notify(`smart-timeout: ${warning}`, "warning");
				ctx.ui.notify(`smart-timeout reloaded (mode=${config.mode})`, "info");
				return;
			}

			if (arg === "off" || arg === "short" || arg === "long") {
				config = { ...config, mode: arg };
				ctx.ui.notify(`smart-timeout mode = ${arg}`, "info");
				return;
			}

			const ceiling = config.maxSeconds > 0 ? `${config.maxSeconds}s` : "unlimited";
			ctx.ui.notify(
				`mode=${config.mode} default=${config.defaultSeconds}s long=${config.longSeconds}s ` +
					`ceiling=${ceiling} grace=${config.graceSeconds}s ` +
					`(usage: /bash-timeout off|short|long|reload)`,
				"info",
			);
		},
	});

	// Tell the model the policy so it can ask for more time instead of being killed.
	pi.on("before_agent_start", async (event) => {
		if (config.mode === "off") return;
		const modeLine =
			config.mode === "short"
				? `- Every bash/powershell command is capped at ${config.defaultSeconds}s.`
				: `- Default cap: ${config.defaultSeconds}s; commands known to run long (builds/tests/installs) get ${config.longSeconds}s.`;
		const note = [
			"",
			"## Shell command timeouts",
			modeLine,
			"- When the cap is hit the whole process tree is killed and the tool reports",
			"  `Command timed out after N seconds`.",
			"- Pass the `timeout` parameter (in seconds) whenever a command might take",
			`  longer than the default cap -- e.g. \`timeout: ${config.longSeconds}\` -- or wrap the`,
			"  command as \`timeout N <cmd>\`.",
			"- A command killed by timeout must not be retried unchanged: either give it an explicit",
			"  bigger timeout, or make it cheaper (narrow the path, add -maxdepth, exclude node_modules).",
			"- Never run blocking/streaming commands (`tail -f`, `watch`, bare `python`, a REPL, an",
			"  interactive prompt) to merely observe something; they will be killed.",
		].join("\n");
		return { systemPrompt: `${event.systemPrompt}\n${note}` };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!SHELL_TOOLS.has(event.toolName)) return;
		const input = event.input as { command?: string; timeout?: number } | undefined;
		if (!input || typeof input.command !== "string") return;

		const requested = typeof input.timeout === "number" ? input.timeout : undefined;
		const plan = planTimeout(input.command, requested);
		log(
			`tool=${event.toolName} requested=${requested ?? "-"} applied=${plan.timeout ?? "-"} ` +
				`reason=${plan.reason} cmd=${JSON.stringify(input.command.slice(0, 120))}`,
		);

		if (plan.timeout === undefined) return;
		input.timeout = plan.timeout;

		if (plan.reason === "model-clamped" && ctx.hasUI) {
			ctx.ui.notify(
				`smart-timeout: ${requested}s clamped to hard ceiling ${plan.timeout}s`,
				"info",
			);
		}
	});
}
