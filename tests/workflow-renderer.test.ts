import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type PantheonWorkflowSnapshot, renderPantheonWorkflows } from "../src/workflow/index.ts";

const base = 1_700_000_000_000;

function workflow(): PantheonWorkflowSnapshot {
	return {
		id: "wf",
		mode: "parallel",
		status: "running",
		createdAt: base,
		updatedAt: base + 2_000,
		runs: [
			{
				id: "run-a",
				workflowId: "wf",
				agent: "codebase-locator",
				status: "running",
				runType: "session",
				cwd: "/repo",
				startedAt: base,
				updatedAt: base + 2_000,
				currentTool: "rg",
				currentActivity: "tool: rg (running)",
				turnCount: 1,
				toolCount: 0,
				activitySeed: 3,
				acpxSessionName: "pantheon-codebase-locator",
				traceId: "trace-1",
				artifacts: {
					dir: "/tmp/artifacts/wf/run-a",
					promptPath: "/tmp/artifacts/wf/run-a/prompt.md",
					outputPath: "/tmp/artifacts/wf/run-a/output.md",
					stderrPath: "/tmp/artifacts/wf/run-a/stderr.log",
					metadataPath: "/tmp/artifacts/wf/run-a/metadata.json",
					telemetryPath: "/tmp/artifacts/wf/run-a/telemetry.json",
				},
			},
			{
				id: "run-b",
				workflowId: "wf",
				agent: "codebase-analyzer",
				status: "failed",
				runType: "exec",
				cwd: "/repo",
				startedAt: base,
				updatedAt: base + 1_000,
				completedAt: base + 1_000,
				stderrPreview: ["Error: boom with a very long explanation that should be truncated cleanly"],
				activitySeed: 1,
			},
		],
	};
}

describe("Pantheon workflow renderer", () => {
	test("renders compact multi-agent status from snapshots", () => {
		const lines = renderPantheonWorkflows([workflow()], { width: 80, expanded: false, now: base + 5_000 });
		expect(lines).toHaveLength(4);
		expect(lines.join("\n")).toContain("/acpx-monitor");
		expect(lines.join("\n")).toContain("codebase-locator");
		expect(lines.join("\n")).toContain("codebase-analyzer");
		expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
		expect(lines.join("\n")).not.toContain("\x1b");
	});

	test("collapses when every subagent run is terminal", () => {
		const snapshot = workflow();
		snapshot.runs = snapshot.runs.map((run) => ({
			...run,
			status: run.status === "running" ? "completed" : run.status,
			completedAt: run.completedAt ?? base + 3_000,
		}));
		expect(renderPantheonWorkflows([snapshot], { width: 80, expanded: false, now: base + 5_000 })).toEqual([]);
		expect(renderPantheonWorkflows([snapshot], { width: 80, expanded: true, now: base + 5_000 })).toEqual([]);
	});

	test("renders expanded tool, artifact, trace, and failure details", () => {
		const lines = renderPantheonWorkflows([workflow()], { width: 100, expanded: true, now: base + 5_000 });
		const text = lines.join("\n");
		expect(text).toContain("tool: rg");
		expect(text).toContain("artifact: /tmp/artifacts/wf/run-a/output.md");
		expect(text).toContain("trace: trace-1");
		expect(text).toContain("Error: boom");
		expect(text).not.toContain("\x1b");
	});

	test("reports accurate hidden run count when expanded line budget is exhausted", () => {
		const snapshot = workflow();
		snapshot.runs = Array.from({ length: 10 }, (_, index) => ({
			id: `run-${index}`,
			workflowId: "wf",
			agent: "codebase-locator",
			status: "running",
			runType: "exec",
			cwd: "/repo",
			startedAt: base,
			updatedAt: base,
			currentTool: "rg",
			currentActivity: "tool: rg (running)",
		}));
		const lines = renderPantheonWorkflows([snapshot], { width: 80, expanded: true, maxLines: 6, now: base + 5_000 });
		expect(lines.join("\n")).toContain("/acpx-monitor");
		expect(lines.at(-1)).toContain("+9 runs hidden");
	});

	test("counts and preserves active nested child runs in compact summary", () => {
		const snapshot = workflow();
		snapshot.runs = [
			{
				id: "parent",
				workflowId: "wf",
				agent: "athena",
				status: "completed",
				runType: "session",
				cwd: "/repo",
				startedAt: base,
				updatedAt: base,
				completedAt: base + 1000,
				children: [
					{
						id: "child",
						workflowId: "wf",
						agent: "oracle",
						status: "running",
						runType: "session",
						cwd: "/repo",
						startedAt: base,
						updatedAt: base,
						currentActivity: "reviewing",
					},
				],
			},
		];
		const text = renderPantheonWorkflows([snapshot], { width: 100, expanded: false, now: base + 5_000 }).join("\n");
		expect(text).toContain("1 active");
		expect(text).toContain("oracle");
	});

	test("activity glyph is stable for unchanged snapshots and changes when activity seed changes", () => {
		const snapshot = workflow();
		const first = renderPantheonWorkflows([snapshot], { width: 80, expanded: false, now: base + 5_000 })[2];
		const second = renderPantheonWorkflows([snapshot], { width: 80, expanded: false, now: base + 6_000 })[2];
		expect(first[0]).toBe(second[0]);
		snapshot.runs[0].activitySeed = 4;
		const changed = renderPantheonWorkflows([snapshot], { width: 80, expanded: false, now: base + 6_000 })[2];
		expect(changed[0]).not.toBe(first[0]);
	});
});
