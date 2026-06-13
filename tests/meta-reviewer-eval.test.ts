import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildMetaReviewerSandboxPrompt,
	buildPiCommand,
	cleanupSandbox,
	createSandboxEvidence,
	isSafeSandboxPath,
	parseCliArgs,
} from "../evals/scripts/run-meta-reviewer-sandbox-eval.ts";

describe("meta-reviewer sandbox eval helpers", () => {
	test("rejects missing CLI option values before runtime path handling", () => {
		expect(() => parseCliArgs(["--results"])).toThrow("--results requires a value");
		expect(() => parseCliArgs(["--results", "--max-turns", "5"])).toThrow("--results requires a value");
		expect(() => parseCliArgs(["--timeout-seconds"])).toThrow("--timeout-seconds requires a value");
		expect(() => parseCliArgs(["--max-turns"])).toThrow("--max-turns requires a value");
		expect(() => parseCliArgs(["--trace-id"])).toThrow("--trace-id requires a value");
	});

	test("rejects unknown CLI arguments", () => {
		expect(() => parseCliArgs(["--unknown-flag"])).toThrow("Unknown argument: --unknown-flag");
	});

	test("only treats known mkdtemp sandbox paths as safe cleanup targets", () => {
		expect(isSafeSandboxPath(join(tmpdir(), "pantheon-meta-reviewer-sandbox-abc123"))).toBe(true);
		expect(isSafeSandboxPath(join(tmpdir(), "pantheon-argus-sandbox-abc123"))).toBe(false);
		expect(isSafeSandboxPath(join(tmpdir(), "pantheon-other-abc123"))).toBe(false);
		expect(isSafeSandboxPath(process.cwd())).toBe(false);
		expect(isSafeSandboxPath("/")).toBe(false);
	});

	test("cleanup refuses to remove unsafe paths", async () => {
		await expect(cleanupSandbox("/tmp/safe-non-sandbox")).rejects.toThrow("Refusing to clean unsafe sandbox path");
		await expect(cleanupSandbox("/")).rejects.toThrow("Refusing to clean unsafe sandbox path");
	});

	test("writes auditable JSON evidence with cleanup status", async () => {
		const sandboxPath = join(tmpdir(), "pantheon-meta-reviewer-sandbox-test-evidence");
		const evidencePath = join(await mkdtemp(join(tmpdir(), "pantheon-evidence-")), "evidence.json");
		const dummyCriteria = {
			C10: { pass: true, note: "ok" },
			C12: { pass: true, note: "ok", artifacts: [] },
			C13: { pass: false, unverified: true, note: "UNVERIFIED" },
			C14: { pass: true, note: "ok" },
			C15: { pass: false, unverified: true, note: "UNVERIFIED" },
		};
		await createSandboxEvidence(evidencePath, {
			traceId: "1b4f82f46e36a289fe805b1789481a33",
			startedAt: "2026-06-05T00:00:00.000Z",
			finishedAt: "2026-06-05T00:00:01.000Z",
			durationMs: 1000,
			sandboxPath,
			cleanup: "removed",
			command: `pi --no-session --no-context-files --no-skills --no-prompt-templates --no-extensions --extension /root --tools acpx,read,write,bash --append-system-prompt /root/agents/prompts/meta-reviewer.md -p "..."`,
			preflight: { traceReachable: true, note: "ok" },
			criteria: dummyCriteria,
			metaReviewer: {
				success: true,
				exitCode: 0,
				timedOut: false,
				durationMs: 500,
				stdoutTail: "telemetry findings harness",
				stderrTail: "",
			},
		});

		const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
		expect(evidence.traceId).toBe("1b4f82f46e36a289fe805b1789481a33");
		expect(evidence.sandboxPath).toBe(sandboxPath);
		expect(evidence.cleanup).toBe("removed");
		expect(evidence.metaReviewer.success).toBe(true);
		expect(evidence.metaReviewer.stdoutTail).toContain("telemetry");
		expect(evidence.criteria.C10.pass).toBe(true);
		expect(evidence.criteria.C13.unverified).toBe(true);
	});

	test("creates and cleans up a real temp directory", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pantheon-meta-reviewer-sandbox-"));
		expect(isSafeSandboxPath(dir)).toBe(true);
		await cleanupSandbox(dir);
		await expect(stat(dir)).rejects.toThrow();
	});

	test("prompt includes required role words and no forbidden patterns", () => {
		const prompt = buildMetaReviewerSandboxPrompt("test-trace-abc123", "/tmp/pantheon-meta-reviewer-sandbox-test");
		expect(prompt).toContain("telemetry");
		expect(prompt).toContain("findings");
		expect(prompt).toContain("harness");
		expect(prompt).toContain("test-trace-abc123");
		// Must NOT call runAcpx indirectly — this is a pi-spawn eval
		expect(prompt).not.toContain("runAcpx");
		// No watch/cron/schedule forbidden by done-contract
		expect(prompt).not.toMatch(/watch|cron|schedule|--since/i);
		// Must contain sandboxPath for explicit git -C invocation
		expect(prompt).toContain("/tmp/pantheon-meta-reviewer-sandbox-test");
		// Must make delegation mandatory
		expect(prompt).toContain("MANDATORY");
		// Must require git -C for stateless bash commands
		expect(prompt).toContain("git -C");
		// Must require diff artifact output
		expect(prompt).toContain(".diff");
		// Must require Reproduction evidence section in review.md (C15 gate)
		expect(prompt).toContain("Reproduction evidence");
		expect(prompt).toContain("Reproduction not feasible because");
		// Must instruct Pi acpx tool usage (not bash invocation of the acpx binary)
		expect(prompt).toContain("acpx Pi tool");
		expect(prompt).toContain("do NOT use bash");
	});

	test("buildPiCommand uses pi extension path with prompt injection, not runAcpx", () => {
		const args = buildPiCommand("/fake/root", "test prompt");
		// Must use isolation flags (no user config bleed)
		expect(args).toContain("--no-session");
		expect(args).toContain("--no-extensions");
		// Must use --extension flag (live eval surface mandate)
		expect(args).toContain("--extension");
		expect(args).toContain("/fake/root");
		// Must include required tools
		expect(args).toContain("acpx,read,write,bash");
		// Must inject meta-reviewer prompt via --append-system-prompt (not --agent)
		expect(args).toContain("--append-system-prompt");
		expect(args.join(" ")).toContain("meta-reviewer");
		// Must NOT use Pi-unsupported flags
		expect(args).not.toContain("--agent");
		expect(args).not.toContain("--timeout-seconds");
		expect(args).not.toContain("--max-turns");
		// Must pass the prompt via -p
		expect(args).toContain("-p");
		expect(args).toContain("test prompt");
		// Must NOT contain runAcpx string
		expect(args.join(" ")).not.toContain("runAcpx");
	});
});
