import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PantheonAgentExplorer, type PantheonWorkflowSnapshot } from "../src/workflow/index.ts";

const base = 1_700_000_000_000;

function snapshots(): PantheonWorkflowSnapshot[] {
	const dir = mkdtempSync(path.join(tmpdir(), "pantheon-explorer-"));
	const outputPath = path.join(dir, "output.md");
	const stderrPath = path.join(dir, "stderr.log");
	const metadataPath = path.join(dir, "metadata.json");
	const promptPath = path.join(dir, "prompt.md");
	writeFileSync(outputPath, "FULL OUTPUT\nline two");
	writeFileSync(stderrPath, "");
	writeFileSync(metadataPath, JSON.stringify({ ok: true }));
	writeFileSync(promptPath, "prompt");
	return [
		{
			id: "wf",
			mode: "single",
			status: "running",
			createdAt: base,
			updatedAt: base,
			runs: [
				{
					id: "run-a",
					workflowId: "wf",
					agent: "codebase-locator",
					status: "running",
					runType: "session",
					model: "claude-sonnet-4-5",
					acpxSessionName: "pantheon-codebase-locator",
					cwd: "/repo",
					startedAt: base,
					updatedAt: base,
					currentActivity: "tool: rg (running)",
					turnCount: 3,
					toolCount: 7,
					stdoutPreview: ["LIVE PREVIEW LINE"],
					artifacts: {
						dir,
						outputPath,
						stderrPath,
						metadataPath,
						promptPath,
						telemetryPath: path.join(dir, "telemetry.json"),
					},
				},
			],
		},
	];
}

describe("Pantheon Agent Explorer", () => {
	test("renders root list and drills into artifact output", () => {
		let closed = false;
		const explorer = new PantheonAgentExplorer(() => snapshots(), {
			onClose: () => {
				closed = true;
			},
			now: () => base + 5000,
		});
		let lines = explorer.render(100);
		const rootText = lines.join("\n");
		expect(rootText).toContain("╭─ Pantheon Agent Explorer");
		expect(rootText).toContain("Agent");
		expect(rootText).toContain("Status");
		expect(rootText).toContain("Turns");
		expect(rootText).toContain("Tools");
		expect(rootText).toContain("Model");
		expect(rootText).toContain("Current activity");
		expect(rootText).toContain("▶ ● codebase-locator");
		expect(rootText).toContain("claude-sonn…");
		expect(rootText).toContain("↑↓/jk Nav");
		expect(rootText).toContain("Ctrl-D/U Page");
		expect(rootText).not.toContain("s Session");
		expect(lines.every((line) => visibleWidth(line) <= 94)).toBe(true);
		expect(lines.every((line) => visibleWidth(line) === 94)).toBe(true);
		expect(rootText).not.toContain("\x1b");
		explorer.handleInput("\r");
		lines = explorer.render(80);
		expect(lines.join("\n")).toContain("Artifacts");
		explorer.handleInput("o");
		lines = explorer.render(80);
		expect(lines.join("\n")).toContain("FULL OUTPUT");
		expect(lines.join("\n")).not.toContain("\x1b");
		explorer.handleInput("\x1b");
		explorer.handleInput("\x1b");
		explorer.handleInput("\x1b");
		expect(closed).toBe(true);
	});

	test("stays under Pi overlay terminal budget when render width includes overlay gutter", () => {
		const explorer = new PantheonAgentExplorer(() => snapshots(), { now: () => base + 5000 });
		const lines = explorer.render(157);
		expect(lines.every((line) => visibleWidth(line) <= 151)).toBe(true);
		expect(lines.every((line) => visibleWidth(line) === 151)).toBe(true);
	});

	test("normalizes tabs and C1 controls in live output so source snippets cannot exceed terminal width", () => {
		const snapshot = snapshots()[0];
		const run = snapshot.runs[0];
		if (!run?.artifacts) throw new Error("expected artifacts");
		writeFileSync(run.artifacts.outputPath, "");
		run.stdoutPreview = [
			`    \t\t\t\t${String.fromCharCode(0x9b)}\`acpx exited with code RESULT plus a long continuation that must be clipped\``,
		];
		const explorer = new PantheonAgentExplorer(() => [snapshot], { now: () => base + 5000 });
		explorer.handleInput("\r");
		explorer.handleInput("o");
		const lines = explorer.render(80);
		expect(lines.join("\n")).toContain("acpx exited");
		expect(lines.every((line) => visibleWidth(line) <= 74)).toBe(true);
		expect(lines.join("\n")).not.toContain("\t");
		expect(lines.join("\n")).not.toContain(String.fromCharCode(0x9b));
	});

	test("CSI-u j/k shortcuts navigate and scroll like arrows", () => {
		const snapshot = snapshots()[0];
		const run = snapshot.runs[0];
		if (!run?.artifacts) throw new Error("expected artifacts");
		writeFileSync(run.artifacts.outputPath, "");
		run.stdoutPreview = Array.from({ length: 30 }, (_, index) => `KEY_SCROLL_LINE ${String(index).padStart(2, "0")}`);
		const explorer = new PantheonAgentExplorer(() => [snapshot], { now: () => base + 5000 });
		explorer.handleInput("\r");
		explorer.handleInput("o");
		const first = explorer.render(100).join("\n");
		expect(first).toContain("KEY_SCROLL_LINE 00");
		explorer.handleInput("\x1b[106;1u"); // j in Kitty/CSI-u
		explorer.handleInput("\x1b[106;1u");
		explorer.handleInput("\x1b[106;1u");
		explorer.handleInput("\x1b[106;1u");
		const down = explorer.render(100).join("\n");
		expect(down).not.toContain("KEY_SCROLL_LINE 00");
		expect(down).toContain("KEY_SCROLL_LINE 04");
		explorer.handleInput("\x1b[107;1u"); // k in Kitty/CSI-u
		explorer.handleInput("\x1b[107;1u");
		explorer.handleInput("\x1b[107;1u");
		explorer.handleInput("\x1b[107;1u");
		const up = explorer.render(100).join("\n");
		expect(up).toContain("KEY_SCROLL_LINE 00");
	});

	test("Ctrl-D and Ctrl-U page through detail output", () => {
		const snapshot = snapshots()[0];
		const run = snapshot.runs[0];
		if (!run?.artifacts) throw new Error("expected artifacts");
		writeFileSync(run.artifacts.outputPath, "");
		run.stdoutPreview = Array.from({ length: 60 }, (_, index) => `PAGE_SCROLL_LINE ${String(index).padStart(2, "0")}`);
		const explorer = new PantheonAgentExplorer(() => [snapshot], { now: () => base + 5000, viewportLines: 18 });
		explorer.handleInput("\r");
		explorer.handleInput("o");
		const first = explorer.render(100).join("\n");
		expect(first).toContain("PAGE_SCROLL_LINE 00");
		explorer.handleInput("\x1b[100;5u"); // Ctrl-D in Kitty/CSI-u
		let down = explorer.render(100).join("\n");
		expect(down).not.toContain("PAGE_SCROLL_LINE 00");
		expect(down).toContain("PAGE_SCROLL_LINE 09");
		explorer.handleInput("\x15"); // Ctrl-U
		let up = explorer.render(100).join("\n");
		expect(up).toContain("PAGE_SCROLL_LINE 00");
		explorer.handleInput("\x04"); // Ctrl-D
		down = explorer.render(100).join("\n");
		expect(down).not.toContain("PAGE_SCROLL_LINE 00");
		expect(down).toContain("PAGE_SCROLL_LINE 09");
		explorer.handleInput("\x1b[117;5u"); // Ctrl-U in Kitty/CSI-u
		up = explorer.render(100).join("\n");
		expect(up).toContain("PAGE_SCROLL_LINE 00");
	});

	test("Ctrl-D and Ctrl-U page through the root run list", () => {
		const snapshot = snapshots()[0];
		snapshot.runs = Array.from({ length: 40 }, (_, index) => ({
			id: `run-${index}`,
			workflowId: "wf",
			agent: `agent-${index}`,
			status: "running" as const,
			runType: "session" as const,
			cwd: "/repo",
			startedAt: base,
			updatedAt: base,
			currentActivity: "working",
		}));
		const explorer = new PantheonAgentExplorer(() => [snapshot], { now: () => base + 5000, viewportLines: 18 });
		let text = explorer.render(100).join("\n");
		expect(text).toContain("▶ ● agent-0");
		explorer.handleInput("\x04"); // Ctrl-D
		text = explorer.render(100).join("\n");
		expect(text).toContain("▶ ● agent-9");
		explorer.handleInput("\x15"); // Ctrl-U
		text = explorer.render(100).join("\n");
		expect(text).toContain("▶ ● agent-0");
	});

	test("session shortcut is shown only when the selected run has an ACPX session file", () => {
		const snapshot = snapshots()[0];
		const explorer = new PantheonAgentExplorer(() => [snapshot], { now: () => base + 5000 });
		let text = explorer.render(120).join("\n");
		expect(text).not.toContain("s Session");
		explorer.handleInput("s");
		text = explorer.render(120).join("\n");
		expect(text).toContain("root");
		snapshot.runs[0].acpxSessionFile = "/Users/example/.acpx/sessions/example.json";
		text = explorer.render(120).join("\n");
		expect(text).toContain("s Session");
		explorer.handleInput("s");
		text = explorer.render(120).join("\n");
		expect(text).toContain("root › session");
	});

	test("overscrolling clamps stored scroll so one k moves back immediately", () => {
		const snapshot = snapshots()[0];
		const run = snapshot.runs[0];
		if (!run?.artifacts) throw new Error("expected artifacts");
		writeFileSync(run.artifacts.outputPath, "");
		run.stdoutPreview = Array.from({ length: 30 }, (_, index) => `CLAMP_SCROLL_LINE ${String(index).padStart(2, "0")}`);
		const explorer = new PantheonAgentExplorer(() => [snapshot], { now: () => base + 5000 });
		explorer.handleInput("\r");
		explorer.handleInput("o");
		for (let index = 0; index < 100; index += 1) explorer.handleInput("j");
		const atEnd = explorer.render(100).join("\n");
		expect(atEnd).toContain("CLAMP_SCROLL_LINE 29");
		explorer.handleInput("k");
		const movedBack = explorer.render(100).join("\n");
		expect(movedBack).toContain("CLAMP_SCROLL_LINE 28");
	});

	test("scrolling keeps a stable frame height instead of shrinking the overlay", () => {
		const snapshot = snapshots()[0];
		const run = snapshot.runs[0];
		if (!run?.artifacts) throw new Error("expected artifacts");
		writeFileSync(run.artifacts.outputPath, "");
		run.stdoutPreview = Array.from({ length: 30 }, (_, index) => `LIVE SCROLL LINE ${String(index).padStart(2, "0")}`);
		const explorer = new PantheonAgentExplorer(() => [snapshot], { now: () => base + 5000 });
		explorer.handleInput("\r");
		explorer.handleInput("o");
		const first = explorer.render(100);
		for (let index = 0; index < 40; index += 1) explorer.handleInput("j");
		const scrolled = explorer.render(100);
		expect(scrolled.length).toBe(first.length);
		expect(scrolled.at(-1)).toBe(first.at(-1));
		expect(scrolled.join("\n")).toContain("LIVE SCROLL LINE 29");
		expect(scrolled.every((line) => visibleWidth(line) <= 94)).toBe(true);
	});

	test("shows live output preview before finalized artifact content", () => {
		const explorer = new PantheonAgentExplorer(() => snapshots(), { now: () => base + 5000 });
		explorer.handleInput("\r");
		explorer.handleInput("o");
		const text = explorer.render(100).join("\n");
		expect(text).toContain("Live output");
		expect(text).toContain("LIVE PREVIEW LINE");
		expect(text).toContain("Artifact file");
		expect(text).toContain("FULL OUTPUT");
	});

	test("shows live output preview when finalized artifact file is still empty", () => {
		const snapshot = snapshots()[0];
		const run = snapshot.runs[0];
		if (!run?.artifacts) throw new Error("expected artifacts");
		writeFileSync(run.artifacts.outputPath, "");
		const explorer = new PantheonAgentExplorer(() => [snapshot], { now: () => base + 5000 });
		explorer.handleInput("\r");
		explorer.handleInput("o");
		const text = explorer.render(100).join("\n");
		expect(text).toContain("Live output");
		expect(text).toContain("LIVE PREVIEW LINE");
		expect(text).not.toContain("Artifact file");
	});

	test("collapses completed agents in root table while preserving selectable active rows", () => {
		const baseSnapshot = snapshots()[0];
		baseSnapshot.runs = Array.from({ length: 6 }, (_, index) => ({
			id: `run-${index}`,
			workflowId: "wf",
			agent: `agent-${index}`,
			status: "completed" as const,
			runType: "session" as const,
			cwd: "/repo",
			startedAt: base,
			updatedAt: base,
			completedAt: base + index,
			currentActivity: "completed",
		}));
		baseSnapshot.runs.unshift({
			id: "active",
			workflowId: "wf",
			agent: "active-agent",
			status: "running",
			runType: "session",
			cwd: "/repo",
			startedAt: base,
			updatedAt: base,
			currentActivity: "still working",
		});
		const explorer = new PantheonAgentExplorer(() => [baseSnapshot], { now: () => base + 5000 });
		const text = explorer.render(100).join("\n");
		expect(text).toContain("active-agent");
		expect(text).toContain("+ 3 completed agents collapsed");
	});

	test("collapsed completed archive expands so hidden completed runs remain inspectable", () => {
		const baseSnapshot = snapshots()[0];
		baseSnapshot.runs = Array.from({ length: 6 }, (_, index) => ({
			id: `run-${index}`,
			workflowId: "wf",
			agent: `agent-${index}`,
			status: "completed" as const,
			runType: "session" as const,
			cwd: "/repo",
			startedAt: base,
			updatedAt: base,
			completedAt: base + index,
			currentActivity: "completed",
		}));
		const explorer = new PantheonAgentExplorer(() => [baseSnapshot], { now: () => base + 5000 });
		let text = explorer.render(100).join("\n");
		expect(text).toContain("agent-0");
		expect(text).not.toContain("agent-5");
		expect(text).toContain("+ 3 completed agents collapsed");
		for (let index = 0; index < 3; index += 1) explorer.handleInput("j");
		explorer.handleInput("\r");
		text = explorer.render(100).join("\n");
		expect(text).toContain("agent-5");
		for (let index = 0; index < 2; index += 1) explorer.handleInput("j");
		explorer.handleInput("\r");
		text = explorer.render(100).join("\n");
		expect(text).toContain("agent-5");
		expect(text).toContain("Run ID");
		expect(text).toContain("run-5");
	});

	test("detail shortcuts replace artifact views instead of recursively stacking", () => {
		const explorer = new PantheonAgentExplorer(() => snapshots(), { now: () => base + 5000 });
		explorer.handleInput("\r");
		explorer.handleInput("o");
		let text = explorer.render(100).join("\n");
		expect(text).toContain("root › run › artifact");
		explorer.handleInput("o");
		text = explorer.render(100).join("\n");
		expect(text).toContain("root › run › artifact");
		expect(text).not.toContain("root › run › artifact › artifact");
		explorer.handleInput("e");
		text = explorer.render(100).join("\n");
		expect(text).toContain("root › run › artifact");
		expect(text).not.toContain("root › run › artifact › artifact");
		expect(text).toContain("stderr:");
	});

	test("supports a larger viewport when the overlay gets more terminal space", () => {
		const snapshot = snapshots()[0];
		const run = snapshot.runs[0];
		if (!run?.artifacts) throw new Error("expected artifacts");
		writeFileSync(run.artifacts.outputPath, "");
		run.stdoutPreview = Array.from({ length: 60 }, (_, index) => `TALL_VIEW_LINE ${String(index).padStart(2, "0")}`);
		const compact = new PantheonAgentExplorer(() => [snapshot], { now: () => base + 5000, viewportLines: 18 });
		compact.handleInput("\r");
		compact.handleInput("o");
		const compactLines = compact.render(100);
		const tall = new PantheonAgentExplorer(() => [snapshot], { now: () => base + 5000, viewportLines: 36 });
		tall.handleInput("\r");
		tall.handleInput("o");
		const tallLines = tall.render(100);
		expect(tallLines.length).toBeGreaterThan(compactLines.length);
		expect(tallLines.join("\n")).toContain("TALL_VIEW_LINE 30");
	});

	test("root navigation scrolls selected rows into view for large completed archives", () => {
		const baseSnapshot = snapshots()[0];
		baseSnapshot.runs = Array.from({ length: 30 }, (_, index) => ({
			id: `run-${index}`,
			workflowId: "wf",
			agent: `agent-${index}`,
			status: "completed" as const,
			runType: "session" as const,
			cwd: "/repo",
			startedAt: base,
			updatedAt: base,
			completedAt: base + index,
			currentActivity: "completed",
		}));
		const explorer = new PantheonAgentExplorer(() => [baseSnapshot], { now: () => base + 5000 });
		for (let index = 0; index < 3; index += 1) explorer.handleInput("j");
		explorer.handleInput("\r");
		let text = explorer.render(100).join("\n");
		expect(text).toContain("agent-5");
		for (let index = 0; index < 15; index += 1) explorer.handleInput("j");
		text = explorer.render(100).join("\n");
		expect(text).toContain("agent-18");
		expect(text).toContain("▶");
		explorer.handleInput("\r");
		text = explorer.render(100).join("\n");
		expect(text).toContain("agent-18");
		expect(text).toContain("run-18");
	});
});
