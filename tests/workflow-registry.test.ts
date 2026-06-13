import { describe, expect, test } from "bun:test";
import { mapAcpxStatus, PantheonWorkflowRegistry } from "../src/workflow/index.ts";

describe("Pantheon workflow registry", () => {
	test("maps runner statuses explicitly", () => {
		expect(mapAcpxStatus("starting")).toBe("running");
		expect(mapAcpxStatus("running")).toBe("running");
		expect(mapAcpxStatus("done")).toBe("completed");
		expect(mapAcpxStatus("failed")).toBe("failed");
		expect(mapAcpxStatus("timeout")).toBe("timeout");
		expect(mapAcpxStatus("aborting")).toBe("cancelled");
	});

	test("tracks cumulative activity across partial chunks and preview truncation", () => {
		const registry = new PantheonWorkflowRegistry();
		const run = registry.startRun({ agent: "codebase-locator", runType: "exec", cwd: "/repo" });
		registry.appendOutput(run.id, "stdout", "[too");
		registry.appendOutput(run.id, "stdout", "l] rg (completed)\n");
		for (let index = 0; index < 19; index += 1) registry.appendOutput(run.id, "stdout", "[tool] rg (completed)\n");
		const snapshot = registry.snapshots()[0].runs[0];
		expect(snapshot.toolCount).toBe(20);
		expect(snapshot.currentActivity).toBe("tool: rg (completed)");
	});

	test("stores model names on run snapshots", () => {
		const registry = new PantheonWorkflowRegistry();
		const run = registry.startRun({ agent: "oracle", runType: "session", cwd: "/repo", model: "claude-opus-4-8" });
		expect(registry.snapshots()[0].runs.find((snapshot) => snapshot.id === run.id)?.model).toBe("claude-opus-4-8");
	});

	test("keeps enough active stdout preview for Explorer scrolling", () => {
		const registry = new PantheonWorkflowRegistry();
		const run = registry.startRun({ agent: "codebase-locator", runType: "exec", cwd: "/repo" });
		for (let index = 0; index < 250; index += 1) registry.appendOutput(run.id, "stdout", `ACTIVE_LINE_${index}\n`);
		const snapshot = registry.snapshots()[0].runs[0];
		expect(snapshot.stdoutPreview).toHaveLength(200);
		expect(snapshot.stdoutPreview?.[0]).toBe("ACTIVE_LINE_50");
		expect(snapshot.stdoutPreview?.at(-1)).toBe("ACTIVE_LINE_249");
	});

	test("tracks two concurrent runs without clobbering shared state", () => {
		const registry = new PantheonWorkflowRegistry();
		const first = registry.startRun({
			workflowId: "wf",
			mode: "parallel",
			agent: "codebase-locator",
			runType: "session",
			cwd: "/repo",
		});
		const second = registry.startRun({
			workflowId: "wf",
			mode: "parallel",
			agent: "codebase-analyzer",
			runType: "session",
			cwd: "/repo",
		});

		registry.appendOutput(first.id, "stdout", "[client] locator (running)\n[tool] rg (running)\n");
		registry.appendOutput(second.id, "stdout", "[client] analyzer (running)\n[thinking] reading\n");
		registry.updateStatus(first.id, "done");

		const [snapshot] = registry.snapshots();
		expect(snapshot.runs).toHaveLength(2);
		expect(snapshot.runs.find((run) => run.id === first.id)?.status).toBe("completed");
		expect(snapshot.runs.find((run) => run.id === second.id)?.status).toBe("running");
		expect(snapshot.runs.map((run) => run.agent).sort()).toEqual(["codebase-analyzer", "codebase-locator"]);
	});

	test("does not overwrite terminal timeout or cancellation with trailing heartbeat statuses", () => {
		const registry = new PantheonWorkflowRegistry();
		const timedOut = registry.startRun({ agent: "oracle", runType: "exec", cwd: "/repo" });
		registry.updateStatus(timedOut.id, "timeout");
		registry.updateStatus(timedOut.id, "running");
		registry.updateStatus(timedOut.id, "failed");
		expect(registry.snapshots()[0].runs[0].status).toBe("timeout");

		const cancelled = registry.startRun({ agent: "zeus", runType: "exec", cwd: "/repo" });
		registry.updateStatus(cancelled.id, "aborting");
		registry.updateStatus(cancelled.id, "running");
		registry.updateStatus(cancelled.id, "failed");
		expect(
			registry
				.snapshots()
				.flatMap((snapshot) => snapshot.runs)
				.find((snapshot) => snapshot.id === cancelled.id)?.status,
		).toBe("cancelled");
	});

	test("defaults session-backed snapshots to stable ACPX session names", () => {
		const registry = new PantheonWorkflowRegistry();
		const run = registry.startRun({ agent: "codebase-locator", runType: "session", cwd: "/repo" });
		expect(run.acpxSessionName).toBe("pantheon-codebase-locator");
	});

	test("finishRun only accepts terminal statuses", () => {
		const registry = new PantheonWorkflowRegistry();
		const run = registry.startRun({ agent: "codebase-locator", runType: "exec", cwd: "/repo" });
		expect(() => registry.finishRun(run.id, "running")).toThrow("finishRun requires a terminal status");
		expect(registry.snapshots()[0].runs[0].completedAt).toBeUndefined();
	});

	test("projects child runs under parent snapshots", () => {
		const registry = new PantheonWorkflowRegistry();
		const parent = registry.startRun({
			workflowId: "wf",
			mode: "review-loop",
			agent: "argus",
			runType: "session",
			cwd: "/repo",
		});
		const child = registry.startRun({
			workflowId: "wf",
			parentId: parent.id,
			agent: "hunter-security",
			runType: "session",
			cwd: "/repo",
		});
		registry.updateStatus(child.id, "done");
		const snapshot = registry.snapshots()[0];
		expect(snapshot.runs).toHaveLength(1);
		expect(snapshot.runs[0].children?.[0].agent).toBe("hunter-security");
		expect(registry.hasActiveRuns()).toBe(true);
		registry.updateStatus(parent.id, "done");
		expect(registry.snapshots()[0].status).toBe("completed");
	});

	test("returns defensive snapshot copies", () => {
		const registry = new PantheonWorkflowRegistry();
		registry.startRun({
			agent: "codebase-locator",
			runType: "session",
			cwd: "/repo",
			artifacts: {
				dir: "/tmp/artifacts/run",
				promptPath: "/tmp/artifacts/run/prompt.md",
				outputPath: "/tmp/artifacts/run/output.md",
				stderrPath: "/tmp/artifacts/run/stderr.log",
				metadataPath: "/tmp/artifacts/run/metadata.json",
				telemetryPath: "/tmp/artifacts/run/telemetry.json",
			},
		});
		const snapshot = registry.snapshots()[0];
		const artifacts = snapshot.runs[0].artifacts;
		expect(artifacts).toBeDefined();
		if (!artifacts) throw new Error("expected artifacts");
		artifacts.outputPath = "/tmp/clobbered.md";
		expect(registry.snapshots()[0].runs[0].artifacts?.outputPath).toBe("/tmp/artifacts/run/output.md");
	});
});
