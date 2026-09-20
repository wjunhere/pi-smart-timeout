// Verify the hasUI notification path (clamp + long-running) doesn't throw and fires correctly.
process.env.PI_BASH_TIMEOUT_SEC = "120";
process.env.PI_BASH_TIMEOUT_LONG_SEC = "1800";
process.env.PI_BASH_TIMEOUT_MAX_SEC = "600";
const handlers: Record<string, Function[]> = {};
const pi: any = { registerCommand: () => {}, on: (e: string, h: Function) => { (handlers[e] ||= []).push(h); } };
const { default: ext } = await import("../extensions/smart-timeout.ts");
ext(pi);
const toolCall = handlers.tool_call[0];
const sessionStart = handlers.session_start[0];
const baseCtx = {
	cwd: process.cwd(),
	hasUI: false,
	isProjectTrusted: () => true,
	ui: { notify: () => {} },
};
await sessionStart({ reason: "startup" }, baseCtx);
const notes: string[] = [];
const ctxUI = { ...baseCtx, hasUI: true, ui: { notify: (m: string) => notes.push(m) } };

const clampInput: any = { command: "ls", timeout: 5000 };
await toolCall({ toolName: "bash", input: clampInput }, ctxUI);
console.log("clamp ->", clampInput.timeout, "notes:", JSON.stringify(notes));
if (clampInput.timeout !== 600) throw new Error("ceiling not applied");
if (!notes.some(n => n.includes("clamped to hard ceiling 600"))) throw new Error("clamp notify missing");

notes.length = 0;
const longInput: any = { command: "npm run build" };
await toolCall({ toolName: "bash", input: longInput }, ctxUI);
console.log("long  ->", longInput.timeout, "notes:", JSON.stringify(notes));

// hasUI:false must not throw even if ui is undefined
const noUI: any = { command: "npm run build" };
await toolCall({ toolName: "bash", input: noUI }, baseCtx);
console.log("hasUI=false ok ->", noUI.timeout);

// malformed inputs must be ignored, not crash
for (const bad of [undefined, {}, { command: 123 }, { command: "" }]) {
  await toolCall({ toolName: "bash", input: bad }, baseCtx);
}
console.log("malformed inputs tolerated");
console.log("UI PATHS PASS");
