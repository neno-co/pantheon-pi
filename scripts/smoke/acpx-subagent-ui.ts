#!/usr/bin/env bun
import { existsSync } from "node:fs";
import {
	PantheonAgentExplorer,
	PantheonWorkflowRegistry,
	renderPantheonWorkflows,
	runPantheonParallelWorkflow,
} from "../../src/workflow/index.ts";

const width = Number(process.env.PANTHEON_SMOKE_WIDTH ?? 120);
const timestamp = Date.now();
const registry = new PantheonWorkflowRegistry();

function assertSmoke(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`smoke assertion failed: ${message}`);
}

function printSection(title: string, lines: string[]) {
	console.log(`\n=== ${title} ===`);
	for (const line of lines) console.log(line);
	return lines.join("\n");
}

const results = await runPantheonParallelWorkflow(
	[
		{
			agent: "codebase-locator",
			prompt: "Reply with exactly: UI_SMOKE_LOCATOR",
			runType: "session",
			sessionId: `pantheon-ui-tmux-locator-${timestamp}`,
			permissions: "approve-reads",
			timeoutSeconds: 180,
			maxTurns: 3,
		},
		{
			agent: "codebase-analyzer",
			prompt: "Reply with exactly: UI_SMOKE_ANALYZER",
			runType: "session",
			sessionId: `pantheon-ui-tmux-analyzer-${timestamp}`,
			permissions: "approve-reads",
			timeoutSeconds: 180,
			maxTurns: 3,
		},
	],
	{ registry, cwd: process.cwd(), concurrency: 2 },
);

assertSmoke(results.length === 2, "expected two live ACPX results");
for (const result of results) {
	assertSmoke(result.result.success, `${result.run.agent} did not succeed`);
	assertSmoke(
		result.run.acpxSessionFile && existsSync(result.run.acpxSessionFile),
		`${result.run.agent} missing ACPX session file`,
	);
	const marker = result.run.agent === "codebase-locator" ? "UI_SMOKE_LOCATOR" : "UI_SMOKE_ANALYZER";
	assertSmoke(result.result.finalAnswer.includes(marker), `${result.run.agent} final answer missing ${marker}`);
}

console.log("LIVE_RESULTS");
for (const result of results) {
	console.log(
		JSON.stringify({
			agent: result.run.agent,
			success: result.result.success,
			finalAnswer: result.result.finalAnswer,
			artifact: result.artifactsDir,
			acpxSessionFile: result.run.acpxSessionFile,
		}),
	);
}

const snapshots = registry.snapshots();
const compact = printSection("COMPACT_WIDGET", renderPantheonWorkflows(snapshots, { width, expanded: false }));
const expanded = printSection(
	"EXPANDED_WIDGET",
	renderPantheonWorkflows(snapshots, { width, expanded: true, maxLines: 30 }),
);
assertSmoke(compact === "", "compact widget should collapse after all subagents complete");
assertSmoke(expanded === "", "expanded widget should collapse after all subagents complete");

let closed = false;
const explorer = new PantheonAgentExplorer(() => registry.snapshots(), {
	onClose: () => {
		closed = true;
	},
});
const root = printSection("EXPLORER_ROOT", explorer.render(width));
assertSmoke(
	root.includes("╭─ Pantheon Agent Explorer") && root.includes("Agent"),
	"explorer root missing boxed table layout",
);
assertSmoke(root.includes("codebase-locator") && root.includes("codebase-analyzer"), "explorer root missing agents");
explorer.handleInput("\r");
const runDetail = printSection("EXPLORER_RUN_DETAIL", explorer.render(width));
assertSmoke(
	runDetail.includes("Artifacts") && runDetail.includes("ACPX"),
	"run detail missing navigation/session metadata",
);
explorer.handleInput("o");
const outputArtifact = printSection("EXPLORER_OUTPUT_ARTIFACT", explorer.render(width));
assertSmoke(outputArtifact.includes("UI_SMOKE_LOCATOR"), "output artifact missing locator marker");
explorer.handleInput("\x1b");
explorer.handleInput("s");
const sessionDetail = printSection("EXPLORER_ACPX_SESSION", explorer.render(width));
assertSmoke(
	sessionDetail.includes("ACPX Session") && sessionDetail.includes("Backend"),
	"session detail missing ACPX metadata",
);
explorer.handleInput("\x1b");
explorer.handleInput("\x1b");
explorer.handleInput("\x1b");
assertSmoke(closed, "explorer did not close after escape navigation");
console.log(`EXPLORER_CLOSED=${closed}`);
