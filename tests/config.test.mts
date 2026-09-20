/**
 * Level 4 — settings.json configuration.
 *
 * Verifies that ~/.pi/agent/settings.json and <cwd>/.pi/settings.json
 * smartTimeout sections are loaded, layered (project over global), validated,
 * and that bad input degrades to defaults with a warning instead of throwing.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "smart-timeout-cfg-"));
const agentDir = join(sandbox, "agent");
const projectDir = join(sandbox, "project");
mkdirSync(agentDir, { recursive: true });
mkdirSync(join(projectDir, ".pi"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const handlers: Record<string, Function[]> = {};
const commands: Record<string, Function> = {};
const pi: any = {
	registerCommand: (name: string, opts: any) => {
		commands[name] = opts.handler;
	},
	on: (e: string, h: Function) => {
		(handlers[e] ||= []).push(h);
	},
};

const { default: ext } = await import("../extensions/smart-timeout.ts");
ext(pi);

const sessionStart = handlers.session_start[0];
const toolCall = handlers.tool_call[0];

/** A context whose notifications land in `warnings` for assertions. */
let warnings: string[] = [];
function ctx(trusted = true) {
	warnings = [];
	const c = {
		cwd: projectDir,
		hasUI: true,
		isProjectTrusted: () => trusted,
		ui: { notify: (m: string) => warnings.push(m) },
	};
	return c;
}

async function boot(globalSettings?: unknown, projectSettings?: unknown, trusted = true) {
	if (globalSettings === undefined) rmSync(join(agentDir, "settings.json"), { force: true });
	else writeFileSync(join(agentDir, "settings.json"), JSON.stringify(globalSettings));
	if (projectSettings === undefined) rmSync(join(projectDir, ".pi", "settings.json"), { force: true });
	else writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify(projectSettings));
	const c = ctx(trusted);
	await sessionStart({ reason: "startup" }, c);
	return c;
}

/** Silent context for tool calls, so it cannot disturb the warnings under test. */
const silentCtx = {
	cwd: projectDir,
	hasUI: false,
	isProjectTrusted: () => true,
	ui: { notify: () => {} },
};

async function cap(command: string, requested?: number): Promise<number | undefined> {
	const input: any = { command, ...(requested !== undefined ? { timeout: requested } : {}) };
	await toolCall({ toolName: "bash", input }, silentCtx);
	return input.timeout;
}

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
	const ok = actual === expected;
	if (!ok) failed += 1;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}: got ${actual}, want ${expected}`);
}

// --- defaults with no settings at all --------------------------------------
await boot();
check("no settings: default cap", await cap("ls -la"), 120);
check("no settings: long-running cap", await cap("npm install"), 1800);

// --- global settings --------------------------------------------------------
await boot({ smartTimeout: { defaultSeconds: 45, longSeconds: 600, mode: "long" } });
check("global defaultSeconds", await cap("ls -la"), 45);
check("global longSeconds", await cap("npm install"), 600);

// --- mode from settings -----------------------------------------------------
await boot({ smartTimeout: { mode: "short", defaultSeconds: 30 } });
check("global mode=short ignores long bucket", await cap("npm install"), 30);

await boot({ smartTimeout: { mode: "off" } });
check("global mode=off leaves timeout unset", await cap("sleep 300"), undefined);
check("global mode=off keeps explicit", await cap("sleep 300", 55), 55);

// --- project overrides global ----------------------------------------------
await boot(
	{ smartTimeout: { defaultSeconds: 45, longSeconds: 600 } },
	{ smartTimeout: { defaultSeconds: 10 } },
);
check("project overrides global defaultSeconds", await cap("ls -la"), 10);
check("global longSeconds still inherited", await cap("npm install"), 600);

// --- project ignored when untrusted ----------------------------------------
await boot(
	{ smartTimeout: { defaultSeconds: 45 } },
	{ smartTimeout: { defaultSeconds: 10 } },
	false,
);
check("untrusted project settings ignored", await cap("ls -la"), 45);

// --- maxSeconds -------------------------------------------------------------
await boot({ smartTimeout: { maxSeconds: 90 } });
check("maxSeconds clamps defaults", await cap("ls -la"), 90);
check("maxSeconds clamps long bucket", await cap("npm install"), 90);
check("maxSeconds clamps explicit model timeout", await cap("ls", 5000), 90);

await boot({ smartTimeout: { maxSeconds: 0 } });
check("maxSeconds=0 disables the ceiling", await cap("ls", 99999), 99999);

// --- graceSeconds + inner guard --------------------------------------------
await boot({ smartTimeout: { graceSeconds: 7 } });
check("custom graceSeconds applies to inner guard", await cap("timeout 20 job"), 27);

// --- longPatterns -----------------------------------------------------------
await boot({ smartTimeout: { defaultSeconds: 5, longSeconds: 500, longPatterns: ["\\bmy-slow-tool\\b"] } });
check("custom longPatterns match", await cap("my-slow-tool --go"), 500);
check("custom longPatterns do not over-match", await cap("echo hi"), 5);

// --- invalid input degrades safely -----------------------------------------
await boot({ smartTimeout: { defaultSeconds: "nope", longSeconds: -5, mode: "banana", longPatterns: ["["] } });
check("invalid values fall back to defaults", await cap("ls -la"), 120);
check("invalid mode falls back to long", await cap("npm install"), 1800);
// All four problems are reported (joined into one notification).
const joined = warnings.join(" ");
for (const [label, needle] of [
	["bad number rejected", "defaultSeconds must be a non-negative"],
	["bad mode rejected", 'mode must be "short", "long" or "off"'],
	["bad regex rejected", "longPatterns has an invalid regex"],
] as const) {
	const ok = joined.includes(needle);
	if (!ok) failed += 1;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}

// longSeconds below defaultSeconds must be repaired, not invert the buckets
await boot({ smartTimeout: { defaultSeconds: 300, longSeconds: 60 } });
check("longSeconds < defaultSeconds is raised", await cap("npm install"), 300);
check("  ... and defaultSeconds still holds", await cap("ls -la"), 300);

// malformed JSON must not throw
writeFileSync(join(agentDir, "settings.json"), "{ this is not json");
await sessionStart({ reason: "startup" }, ctx());
check("malformed JSON falls back to defaults", await cap("ls -la"), 120);
assert.ok(warnings.some((w) => /parse/i.test(w)), "malformed JSON must warn");
console.log("PASS  malformed JSON warned and recovered");
// --- /bash-timeout reload picks up edits -----------------------------------
await boot({ smartTimeout: { defaultSeconds: 11 } });
check("before reload", await cap("ls -la"), 11);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ smartTimeout: { defaultSeconds: 22 } }));
await commands["bash-timeout"]("reload", ctx());
check("after /bash-timeout reload", await cap("ls -la"), 22);

rmSync(sandbox, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} FAILED`}`);
if (failed) process.exit(1);
