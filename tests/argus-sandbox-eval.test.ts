import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildArgusSandboxPrompt,
	cleanupSandbox,
	createSandboxEvidence,
	isSafeSandboxPath,
	parseCliArgs,
	seedSandboxDiff,
} from "../evals/scripts/run-argus-sandbox-eval.ts";

describe("Argus sandbox eval helpers", () => {
	test("rejects missing CLI option values before runtime path handling", () => {
		expect(() => parseCliArgs(["--results"])).toThrow("--results requires a value");
		expect(() => parseCliArgs(["--results", "--max-turns", "5"])).toThrow("--results requires a value");
		expect(() => parseCliArgs(["--timeout-seconds"])).toThrow("--timeout-seconds requires a value");
		expect(() => parseCliArgs(["--max-turns"])).toThrow("--max-turns requires a value");
	});

	test("only treats known mkdtemp sandbox paths as safe cleanup targets", () => {
		expect(isSafeSandboxPath(join(tmpdir(), "pantheon-argus-sandbox-abc123"))).toBe(true);
		expect(isSafeSandboxPath(join(tmpdir(), "pantheon-other-abc123"))).toBe(false);
		expect(isSafeSandboxPath(process.cwd())).toBe(false);
		expect(isSafeSandboxPath("/")).toBe(false);
	});

	test("seeds a tiny TypeScript diff with explicit sandbox markers", async () => {
		const sandboxPath = await mkdtemp(join(tmpdir(), "pantheon-argus-sandbox-"));
		const init = Bun.spawnSync({ cmd: ["git", "init"], cwd: sandboxPath, stdout: "pipe", stderr: "pipe" });
		expect(init.exitCode).toBe(0);
		await seedSandboxDiff(sandboxPath);

		const seeded = await readFile(join(sandboxPath, "src", "argus-sandbox-target.ts"), "utf8");
		expect(seeded).toContain("ARGUS_SANDBOX_EVAL_MARKER");
		expect(seeded).toContain("export function argusSandboxTarget");

		await cleanupSandbox(sandboxPath);
		await expect(stat(sandboxPath)).rejects.toThrow();
	});

	test("writes auditable JSON evidence with cleanup status", async () => {
		const sandboxPath = join(tmpdir(), "pantheon-argus-sandbox-test-evidence");
		const evidencePath = join(await mkdtemp(join(tmpdir(), "pantheon-evidence-")), "evidence.json");
		await createSandboxEvidence(evidencePath, {
			startedAt: "2026-05-25T00:00:00.000Z",
			finishedAt: "2026-05-25T00:00:01.000Z",
			durationMs: 1000,
			sandboxPath,
			cleanup: "removed",
			seededDiffSummary: "tiny TS diff",
			command: "bun run evals/scripts/run-argus-sandbox-eval.ts",
			argus: {
				success: true,
				exitCode: 0,
				timedOut: false,
				durationMs: 500,
				finalAnswer: "CLEAR",
				stdoutTail: "CLEAR",
				stderrTail: "",
			},
		});

		const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
		expect(evidence.sandboxPath).toBe(sandboxPath);
		expect(evidence.cleanup).toBe("removed");
		expect(evidence.argus.finalAnswer).toBe("CLEAR");
	});

	test("prompt requests full hunter-swarm behavior and forbids active-worktree cleanup", () => {
		const prompt = buildArgusSandboxPrompt();

		expect(prompt).toContain("Run adversarial review");
		expect(prompt).toContain("hunter");
		expect(prompt).toContain("Do not clean or mutate any path outside this sandbox");
		expect(prompt).toContain("git diff -- src/argus-sandbox-target.ts");
	});
});
