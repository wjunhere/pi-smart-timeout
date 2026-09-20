/**
 * Level 2 — end-to-end kill test.
 *
 * Drives the REAL pi bash tool plus the REAL extension handler, so this
 * exercises the production spawn -> timeout -> killProcessTree path with
 * genuinely blocking commands, and verifies no orphaned grandchildren survive.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The extension reads these once at load time, so set them BEFORE importing.
const CAP = 6;
// Keep the decision log out of the repo so a `tail -f` scenario cannot read the
// log this test is writing.
const workDir = join(tmpdir(), `pi-smart-timeout-e2e-${process.pid}`);
mkdirSync(workDir, { recursive: true });
process.env.PI_BASH_TIMEOUT_SEC = String(CAP);
process.env.PI_BASH_TIMEOUT_MODE = "short";
process.env.PI_BASH_TIMEOUT_LONG_SEC = String(CAP);
process.env.PI_BASH_TIMEOUT_LOG = join(workDir, "decisions.log");

// Resolve the SDK from this package's own node_modules rather than a hardcoded
// absolute path, so the suite runs on any machine and in CI.
const pkgEntry = fileURLToPath(
	import.meta.resolve("@earendil-works/pi-coding-agent"),
);
const { createBashTool } = await import(pathToFileURL(pkgEntry).href);
// Shell commands need a POSIX-style path; Git Bash on Windows understands /tmp.
const shTmp = process.platform === "win32" ? "/tmp" : tmpdir();

const handlers: Record<string, Function[]> = {};
let commandHandler: Function | undefined;
const pi: any = {
	registerCommand: (_n: string, opts: any) => {
		commandHandler = opts.handler;
	},
	on: (e: string, h: Function) => {
		(handlers[e] ||= []).push(h);
	},
};
const { default: ext } = await import("../extensions/smart-timeout.ts");
ext(pi);
const toolCall = handlers.tool_call[0];
const sessionStart = handlers.session_start[0];

const cwd = process.cwd();
const tool = createBashTool(cwd);
const ctx: any = {
	cwd,
	sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined },
	model: undefined,
	thinkingLevel: undefined,
};

const cmdCtx: any = {
	cwd: process.cwd(),
	hasUI: false,
	isProjectTrusted: () => true,
	ui: { notify: () => {} },
};

async function setMode(mode: string) {
	await commandHandler!(mode, cmdCtx);
}

// Load configuration the way pi does at the start of a session.
await sessionStart({ reason: "startup" }, cmdCtx);

/**
 * Count live processes still carrying `marker` in their command line.
 * Powershell/WMI helper processes are excluded because the query itself
 * contains the marker string.
 */
function markerAlive(marker: string): number {
	const script =
		`$m='${marker}'; ` +
		`@(Get-CimInstance Win32_Process | ` +
		`Where-Object { $_.CommandLine -and $_.CommandLine.Contains($m) -and ` +
		`$_.Name -notin @('powershell.exe','pwsh.exe','WmiPrvSE.exe') }).Count`;
	try {
		const out = execFileSync("powershell", ["-NoProfile", "-Command", script], {
			encoding: "utf-8",
			timeout: 25000,
			windowsHide: true,
		});
		return Number(out.trim()) || 0;
	} catch {
		return -1;
	}
}

type Scenario = {
	name: string;
	command: (marker: string) => string;
	expectTimeout: boolean;
	expectOutput?: string;
	checkOrphan?: boolean;
	/** model-supplied timeout for this scenario */
	requestedTimeout?: number;
	/** exact expected applied cap when it differs from CAP */
	expectedCap?: number;
	/** upper bound on wall-clock seconds */
	maxSeconds: number;
};

const scenarios: Scenario[] = [
	{
		name: "plain hang (sleep 300)",
		command: (m) => `echo BEFORE_${m}; sleep 300; echo AFTER_${m}`,
		expectTimeout: true,
		expectOutput: "BEFORE_",
		maxSeconds: 15,
	},
	{
		name: "streaming block (tail -f)",
		command: (m) => `echo START_${m} > ${shTmp}/bt-${m}.log; tail -f ${shTmp}/bt-${m}.log`,
		expectTimeout: true,
		maxSeconds: 15,
	},
	{
		name: "infinite loop emitting output",
		command: (m) => `i=0; while true; do i=$((i+1)); echo tick-$i-${m}; sleep 1; done`,
		expectTimeout: true,
		expectOutput: "tick-",
		maxSeconds: 18,
	},
	{
		name: "hang after a pipeline",
		command: (m) => `echo PIPE_${m} | cat; sleep 300`,
		expectTimeout: true,
		expectOutput: "PIPE_",
		maxSeconds: 15,
	},
	{
		name: "hang inside a subshell",
		command: (m) => `( sleep 300 ); echo DONE_${m}`,
		expectTimeout: true,
		maxSeconds: 15,
	},
	{
		name: "hang with stderr noise",
		command: (m) => `echo err_${m} 1>&2; sleep 300`,
		expectTimeout: true,
		expectOutput: "err_",
		maxSeconds: 15,
	},
	{
		name: "stdin read does NOT hang (pi spawns with stdin=ignore)",
		command: (m) => `echo READY_${m}; cat -; echo EOF_${m}`,
		expectTimeout: false,
		expectOutput: "EOF_",
		maxSeconds: 12,
	},
	{
		name: "orphan: node grandchild via bash",
		command: (m) => `node -e "setTimeout(()=>{},600000)" ${m}`,
		expectTimeout: true,
		checkOrphan: true,
		maxSeconds: 15,
	},
	{
		name: "orphan: nested bash -> node grandchild",
		command: (m) => `bash -c 'node -e "setTimeout(()=>{},600000)" ${m}'`,
		expectTimeout: true,
		checkOrphan: true,
		maxSeconds: 15,
	},
	{
		name: "orphan: backgrounded child killed with the tree",
		command: (m) => `bash -c 'sleep 600 # ${m}' & wait`,
		expectTimeout: true,
		checkOrphan: true,
		maxSeconds: 15,
	},
	{
		name: "no hang: fast command returns normally",
		command: (m) => `echo FAST_${m}`,
		expectTimeout: false,
		expectOutput: "FAST_",
		maxSeconds: 12,
	},
	{
		name: "no hang: 3s command under a 6s cap",
		command: (m) => `sleep 3; echo SLOWOK_${m}`,
		expectTimeout: false,
		expectOutput: "SLOWOK_",
		maxSeconds: 12,
	},
	{
		name: "inner guard beats the outer cap (timeout 2 under a 6s cap)",
		command: (m) => `timeout 2 sleep 300; echo INNER_DONE_${m}`,
		expectTimeout: false,
		expectOutput: "INNER_DONE_",
		expectedCap: 32, // inner 2s + 30s grace, so the inner guard fires first at 2s
		maxSeconds: 12,
	},
	{
		name: "model-supplied timeout wins over the cap",
		command: (m) => `sleep 3; echo EXPLICIT_${m}`,
		requestedTimeout: 20,
		expectTimeout: false,
		expectOutput: "EXPLICIT_",
		maxSeconds: 12,
	},
	{
		name: "non-zero exit is reported as an error, not a timeout",
		command: (m) => `echo BOOM_${m}; exit 3`,
		expectTimeout: false,
		expectOutput: "BOOM_",
		maxSeconds: 12,
	},
	{
		name: "large output before timeout is preserved",
		command: (m) => `seq 1 2000 | sed "s/^/L_${m}_/"; sleep 300`,
		expectTimeout: true,
		expectOutput: "L_",
		maxSeconds: 15,
	},
];

let failures = 0;
const rows: string[] = [];

await setMode("short");

for (const s of scenarios) {
	const marker = `PIMARK${Math.random().toString(36).slice(2, 9).toUpperCase()}`;
	const input: any = { command: s.command(marker) };
	if (s.requestedTimeout !== undefined) input.timeout = s.requestedTimeout;
	await toolCall({ toolName: "bash", input }, { cwd, hasUI: false, isProjectTrusted: () => true });
	const appliedCap = input.timeout;

	const started = Date.now();
	let text = "";
	let isError = false;
	try {
		const res = await tool.execute("t1", input, undefined, undefined, ctx);
		text = res.content.map((c: any) => c.text).join("\n");
	} catch (err: any) {
		isError = true;
		text = err.message;
	}
	const elapsed = Date.now() - started;

	const timedOut = /timed out after/.test(text);
	const capOk =
		s.requestedTimeout !== undefined
			? appliedCap === s.requestedTimeout
			: s.expectedCap !== undefined
				? appliedCap === s.expectedCap
				: appliedCap === CAP;
	const timeoutOk = timedOut === s.expectTimeout;
	const outputOk = !s.expectOutput || text.includes(s.expectOutput);
	const elapsedOk = elapsed / 1000 < s.maxSeconds;

	let orphanCount = -1;
	let orphanOk = true;
	if (s.checkOrphan) {
		await new Promise((r) => setTimeout(r, 2000));
		orphanCount = markerAlive(marker);
		orphanOk = orphanCount === 0;
	}

	const ok = capOk && timeoutOk && outputOk && elapsedOk && orphanOk;
	if (!ok) failures += 1;
	rows.push(
		`${ok ? "PASS" : "FAIL"} | cap=${String(appliedCap).padStart(4)}s | took=${(elapsed / 1000)
			.toFixed(1)
			.padStart(5)}s | timeout=${String(timedOut).padEnd(5)} | isErr=${String(isError).padEnd(5)} | orphan=${
			s.checkOrphan ? String(orphanCount).padStart(2) : " n/a"
		} | ${s.name}`,
	);
	if (!ok) {
		rows.push(
			`       capOk=${capOk} timeoutOk=${timeoutOk} outputOk=${outputOk} elapsedOk=${elapsedOk} orphanOk=${orphanOk}`,
		);
		rows.push(`       text: ${text.replace(/\n/g, " | ").slice(0, 240)}`);
	}
}

// --- mode switching against the real tool ----------------------------------
await setMode("long");
{
	const input: any = { command: "sleep 300" };
	await toolCall({ toolName: "bash", input }, { cwd, hasUI: false, isProjectTrusted: () => true });
	const ok = input.timeout === CAP; // LONG_SEC == CAP in this run
	if (!ok) failures += 1;
	rows.push(`${ok ? "PASS" : "FAIL"} | /bash-timeout long -> applied ${input.timeout}s`);
}

await setMode("off");
{
	const input: any = { command: "sleep 30; echo OFF_DONE" };
	await toolCall({ toolName: "bash", input }, { cwd, hasUI: false, isProjectTrusted: () => true });
	const capApplied = input.timeout;
	// Mode off must leave the command uncapped: 30s sleep must outlive the 6s cap,
	// and the extension must not have written a timeout.
	const raceStart = Date.now();
	const settled = await Promise.race([
		tool
			.execute("t2", input, undefined, undefined, ctx)
			.then(() => "done")
			.catch(() => "error"),
		new Promise((r) => setTimeout(() => r("still-running"), 10000)),
	]);
	const elapsed = Date.now() - raceStart;
	const ok = capApplied === undefined && settled === "still-running" && elapsed >= 9000;
	if (!ok) failures += 1;
	rows.push(
		`${ok ? "PASS" : "FAIL"} | mode=off truly uncapped (timeout=${capApplied}, settled=${settled} after ${(
			elapsed / 1000
		).toFixed(1)}s)`,
	);
	// Clean up the still-running 30s sleep so later runs are not polluted.
	try {
		execFileSync(
			"powershell",
			["-NoProfile", "-Command", "Get-Process sleep -ErrorAction SilentlyContinue | Stop-Process -Force"],
			{ timeout: 15000, windowsHide: true },
		);
	} catch {}
}
await setMode("short");

console.log(rows.join("\n"));
console.log(`\n${scenarios.length + 2 - failures}/${scenarios.length + 2} checks passed`);
// Remove the temp workdir even when a check failed, so CI runs do not leak files.
rmSync(workDir, { recursive: true, force: true });
assert.equal(failures, 0, `${failures} check(s) failed`);
