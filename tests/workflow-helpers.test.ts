import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AcpxRunRequest, AcpxRunResult } from "../src/runner/index.ts";
import {
	type PantheonWorkflowNode,
	PantheonWorkflowRegistry,
	runPantheonChainWorkflow,
	runPantheonParallelWorkflow,
} from "../src/workflow/index.ts";

function fakeResult(answer: string): AcpxRunResult {
	return {
		success: true,
		stdout: `[thinking]\n[tool] read (completed)\n${answer}\n[done]\n`,
		stderr: "",
		exitCode: 0,
		signal: null,
		timedOut: false,
		aborted: false,
		command: "acpx",
		args: ["prompt", answer],
		finalAnswer: answer,
		fullTranscript: answer,
		durationMs: 10,
	};
}

describe("Pantheon workflow helpers", () => {
	test("runs bounded parallel workflow through injected runner and registry", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "pantheon-helper-artifacts-"));
		process.env.PANTHEON_ARTIFACTS_DIR = root;
		const registry = new PantheonWorkflowRegistry();
		let active = 0;
		let maxActive = 0;
		const runner = async (request: AcpxRunRequest) => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			request.onStatus?.("starting");
			request.onOutput?.("stdout", "[thinking]\n[tool] read (completed)\n");
			await new Promise((resolve) => setTimeout(resolve, 5));
			active -= 1;
			request.onStatus?.("done");
			return fakeResult(request.agent);
		};
		const nodes: PantheonWorkflowNode[] = [
			{ agent: "codebase-locator", prompt: "locate" },
			{ agent: "codebase-analyzer", prompt: "analyze" },
			{ agent: "argus", prompt: "review" },
		];
		const results = await runPantheonParallelWorkflow(nodes, { registry, runner, concurrency: 2, cwd: "/repo" });
		expect(results).toHaveLength(3);
		expect(maxActive).toBeLessThanOrEqual(2);
		const snapshot = registry.snapshots()[0];
		expect(snapshot.mode).toBe("parallel");
		expect(snapshot.runs.every((run) => run.status === "completed")).toBe(true);
		expect(snapshot.runs.map((run) => run.model)).toEqual([
			"google/gemini-3-flash-preview",
			"claude-sonnet-4-6",
			"claude-opus-4-8",
		]);
		expect(snapshot.runs[0].artifacts?.metadataPath).toBeTruthy();
	});

	test("chain workflow passes prior artifact directory to later prompts", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "pantheon-chain-artifacts-"));
		process.env.PANTHEON_ARTIFACTS_DIR = root;
		const registry = new PantheonWorkflowRegistry();
		const prompts: string[] = [];
		const runner = async (request: AcpxRunRequest) => {
			prompts.push(request.prompt);
			request.onOutput?.("stdout", "[done]\n");
			request.onStatus?.("done");
			return fakeResult(request.prompt);
		};
		const results = await runPantheonChainWorkflow(
			[
				{ agent: "codebase-locator", prompt: "step one" },
				{ agent: "codebase-analyzer", prompt: "step two" },
			],
			{ registry, runner, cwd: "/repo" },
		);
		expect(results).toHaveLength(2);
		expect(prompts[1]).toContain("Previous step artifact directory:");
		const metadata = readFileSync(results[1].run.artifacts?.metadataPath ?? "", "utf8");
		expect(metadata).toContain("codebase-analyzer");
		expect(registry.snapshots()[0].mode).toBe("chain");
	});
});
