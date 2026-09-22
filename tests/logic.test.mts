/**
 * Level 1 — decision-table test for bash-timeout.ts
 * Loads the extension, captures the tool_call handler, and asserts what
 * timeout value ends up in event.input for a wide matrix of commands.
 */
import { strict as assert } from "node:assert";

const cases: Array<[string, number | undefined, number]> = [
	// [command, requested, expected]
	["ls -la", undefined, 120],
	["rg foo src/", undefined, 120],
	["git status", undefined, 120],
	["echo hi", undefined, 120],
	["python -c \"print(1)\"", undefined, 120],

	// long-running set
	["npm install", undefined, 1800],
	["npm run build", undefined, 1800],
	["pnpm add lodash", undefined, 1800],
	["pip install -r requirements.txt", undefined, 1800],
	["uv sync", undefined, 1800],
	["apt-get install -y curl", undefined, 1800],
	["cargo build --release", undefined, 1800],
	["go test ./...", undefined, 1800],
	["make -j8", undefined, 1800],
	["docker build -t app .", undefined, 1800],
	["docker compose up -d", undefined, 1800],
	["kubectl get pods", undefined, 1800],
	["terraform apply", undefined, 1800],
	["git clone https://github.com/a/b.git", undefined, 1800],
	["git push origin main", undefined, 1800],
	["pytest tests/", undefined, 1800],
	["npx playwright test", undefined, 1800],
	["tail -f app.log", undefined, 1800],
	["ffmpeg -i in.mp4 out.mp4", undefined, 1800],
	["sleep 300", undefined, 1800],

	// inner guard wins
	["timeout 10 ping 8.8.8.8", undefined, 40],
	["timeout 2m cargo build", undefined, 150],
	["timeout -k 5 30 some-cmd", undefined, 60],
	["timeout 1h backup.sh", undefined, 3600], // 3600 + 30 grace clamped to the ceiling
	["timeout 2h huge-job", undefined, 3600], // inner guard clamped to the ceiling
	["/usr/bin/timeout 45 job", undefined, 75],
	["timeout -s KILL 90 job", undefined, 120],
	["timeout --signal=TERM 15 job", undefined, 45],
	["timeout --kill-after=5s 25 job", undefined, 55],
	["timeout 2d long-job", undefined, 3600], // inner guard clamped to the ceiling
	["echo hi; timeout 20 curl x", undefined, 50],

	// quoted `timeout` is NOT a guard
	["echo \"timeout 5\"", undefined, 120],
	["rg 'timeout 10' .", undefined, 120],
	// bare `timeout` with no duration is not a guard either
	["timeout --version", undefined, 120],

	// `timeout 0` means "no timeout" in coreutils -> not a guard
	["timeout 0 npm install", undefined, 1800],

	// model-specified always wins
	["ls", 900, 900],
	["npm install", 60, 60],
	["sleep 5", 5, 5],
	["ls", 7200, 3600], // clamped to ceiling
	["ls", 100000, 3600], // clamped to ceiling

	// false positives from the issue review must stay in the default bucket
	["grep -rn 'make sure' src/", undefined, 120],
	["rg -n 'convert' --glob '*.md'", undefined, 120],
	["echo 'go' > /tmp/x", undefined, 120],
	["ls | grep go", undefined, 120],
	["cd /b/project && find . -name '*.go'", undefined, 120],
	["echo 'sleep 300'", undefined, 120],
	["grep -n 'sleep 30' script.sh", undefined, 120],

	// ssh hangs on prompts/unreachable hosts; ssh-keygen is instant: default bucket
	["ssh user@10.0.0.1 ls", undefined, 120],
	["ssh-keygen -t ed25519", undefined, 120],

	// curl/wget hang more often than they transfer: default bucket even with -o
	["curl -s http://10.0.0.1/api", undefined, 120],
	["curl -o out.zip https://example.com/f.zip", undefined, 120],

	// bounded poll loops get the long bucket; `while true` loops do not
	["for i in $(seq 1 60); do sleep 5; done", undefined, 1800],
	["until ping -c1 host; do sleep 10; done", undefined, 1800],
	["while true; do sleep 1; done", undefined, 120],

	// inner guard found inside nested quotes
	["sh -c 'echo \"a\"; timeout 7 sleep 9'", undefined, 37],
	["timeout 99999 cat", undefined, 3600], // inner guard clamped to the ceiling
	["echo \"it's\" ; timeout 5 sleep 9", undefined, 35],
];

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
const beforeAgentStart = handlers.before_agent_start[0];
const sessionStart = handlers.session_start[0];
assert.ok(sessionStart, "session_start handler registered");

const testCwd = process.cwd();
const baseCtx = {
	cwd: testCwd,
	hasUI: false,
	isProjectTrusted: () => true,
	ui: { notify: () => {} },
};

// Load configuration the way pi does at the start of a session.
await sessionStart({ reason: "startup" }, baseCtx);
assert.ok(toolCall, "tool_call handler registered");
assert.ok(beforeAgentStart, "before_agent_start handler registered");

let failed = 0;
for (const [command, requested, expected] of cases) {
	const input: any = { command, ...(requested !== undefined ? { timeout: requested } : {}) };
	await toolCall({ toolName: "bash", input }, baseCtx);
	const got = input.timeout;
	const ok = got === expected;
	if (!ok) failed += 1;
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${String(got).padStart(5)} (want ${String(expected).padStart(5)})  req=${String(requested ?? "-").padStart(6)}  ${JSON.stringify(command)}`,
	);
}

// non-shell tools untouched
const readInput: any = { path: "/tmp/x" };
await toolCall({ toolName: "read", input: readInput }, baseCtx);
assert.equal(readInput.timeout, undefined, "read tool must not be touched");
console.log("PASS  read tool untouched");

// powershell covered too
const psInput: any = { command: "Get-ChildItem" };
await toolCall({ toolName: "powershell", input: psInput }, baseCtx);
assert.equal(psInput.timeout, 120, "powershell should be capped");
console.log("PASS  powershell capped to 120");

// system prompt injection
const injected = await beforeAgentStart({ systemPrompt: "BASE" }, baseCtx);
assert.ok(injected?.systemPrompt?.startsWith("BASE"), "system prompt is chained, not replaced");
assert.ok(injected.systemPrompt.includes("Shell command timeouts"), "policy injected");
const notes: string[] = [];
await commandHandler!("", { ui: { notify: (m: string) => notes.push(m) } });
assert.ok(notes.some((n) => n.includes("mode=long")), "status command reports mode");
console.log("PASS  system prompt chained + policy injected + /bash-timeout status");

// --- runtime mode switching ---
const notify = { ui: { notify: () => {} } };

await commandHandler!("short", notify);
let shortInput: any = { command: "npm install" };
await toolCall({ toolName: "bash", input: shortInput }, baseCtx);
assert.equal(shortInput.timeout, 120, "short mode caps even long-running commands");
console.log("PASS  /bash-timeout short caps npm install at 120");

await commandHandler!("off", notify);
let offInput: any = { command: "sleep 300" };
await toolCall({ toolName: "bash", input: offInput }, baseCtx);
assert.equal(offInput.timeout, undefined, "off mode leaves timeout untouched");
console.log("PASS  /bash-timeout off leaves timeout unset");

let explicitInOff: any = { command: "ls", timeout: 42 };
await toolCall({ toolName: "bash", input: explicitInOff }, baseCtx);
assert.equal(explicitInOff.timeout, 42, "off mode preserves model value");
console.log("PASS  /bash-timeout off preserves explicit model timeout");

const offPrompt = await beforeAgentStart({ systemPrompt: "BASE" }, baseCtx);
assert.equal(offPrompt, undefined, "off mode injects no system prompt note");
console.log("PASS  off mode skips system prompt injection");

await commandHandler!("long", notify);
await commandHandler!("bogus", notify); // invalid arg must not change mode
let restored: any = { command: "npm install" };
await toolCall({ toolName: "bash", input: restored }, baseCtx);
assert.equal(restored.timeout, 1800, "invalid arg keeps previous mode");
console.log("PASS  invalid arg does not change mode");

console.log(`\n${cases.length + 10 - failed}/${cases.length + 10} passed`);
if (failed) process.exit(1);
