import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunArtifacts, finalizeRunArtifacts, redactArgv } from "../src/workflow/index.ts";

describe("Pantheon run artifacts", () => {
	test("redacts append-system-prompt and secret-like argv values", () => {
		const redacted = redactArgv([
			"--append-system-prompt",
			"secret governance",
			"--api-key",
			"abc",
			"--token=def",
			"exec",
			"hello",
		]);
		expect(redacted.argv).toContain("[REDACTED_APPEND_SYSTEM_PROMPT]");
		expect(redacted.argv).toContain("--api-key=[REDACTED_ARG]");
		expect(redacted.argv).toContain("--token=[REDACTED_ARG]");
		expect(redacted.argv).not.toContain("secret governance");
		expect(redacted.argv).not.toContain("abc");
		expect(redacted.argv).not.toContain("def");
	});

	test("writes prompt, output, stderr, metadata, and telemetry with redactions", () => {
		const root = mkdtempSync(path.join(tmpdir(), "pantheon-artifacts-test-"));
		process.env.PANTHEON_ARTIFACTS_DIR = root;
		const startedAt = 1_700_000_000_000;
		const artifacts = createRunArtifacts({
			workflowId: "wf",
			runId: "run",
			agent: "codebase-locator",
			cwd: "/repo",
			prompt: "find files token=SECRET",
			runType: "session",
			acpxSessionName: "pantheon-codebase-locator",
			traceId: "trace",
			spanId: "span",
			correlationId: "corr",
			startedAt,
		});

		const metadata = finalizeRunArtifacts({
			workflowId: "wf",
			runId: "run",
			agent: "codebase-locator",
			cwd: "/repo",
			prompt: "find files token=SECRET",
			runType: "session",
			acpxSessionName: "pantheon-codebase-locator",
			traceId: "trace",
			spanId: "span",
			correlationId: "corr",
			startedAt,
			completedAt: startedAt + 1000,
			artifacts,
			result: {
				success: true,
				stdout: "answer authorization: Bearer SECRET",
				stderr: "",
				exitCode: 0,
				signal: null,
				timedOut: false,
				aborted: false,
				command: "/opt/homebrew/bin/acpx",
				args: ["--append-system-prompt", "do not store", "prompt", "-s", "pantheon-codebase-locator"],
				finalAnswer: "answer",
				fullTranscript: "answer authorization: Bearer SECRET",
				durationMs: 1000,
			},
		});

		expect(readFileSync(artifacts.promptPath, "utf8")).toContain("[REDACTED_TOKEN]");
		expect(readFileSync(artifacts.outputPath, "utf8")).toContain("[REDACTED_AUTHORIZATION]");
		expect(readFileSync(artifacts.outputPath, "utf8")).not.toContain("SECRET");
		expect(readFileSync(artifacts.telemetryPath, "utf8")).toContain("trace");
		expect(metadata.schemaVersion).toBe(1);
		expect(metadata.status).toBe("completed");
		expect(metadata.acpxSessionName).toBe("pantheon-codebase-locator");
		expect(metadata.command.argvShape).not.toContain("do not store");
		for (const filePath of [
			artifacts.dir,
			artifacts.promptPath,
			artifacts.outputPath,
			artifacts.stderrPath,
			artifacts.metadataPath,
			artifacts.telemetryPath,
		]) {
			expect(statSync(filePath).mode & 0o077).toBe(0);
		}
	});

	test("redacts api key labels with spaces from persisted artifact files", () => {
		const root = mkdtempSync(path.join(tmpdir(), "pantheon-artifacts-api-key-test-"));
		process.env.PANTHEON_ARTIFACTS_DIR = root;
		const secret = "ARGUS-API-KEY-LEAK-6f21";
		const artifacts = createRunArtifacts({
			workflowId: "wf-api-key",
			runId: "run-api-key",
			agent: "hunter-security",
			cwd: "/repo",
			prompt: `call provider with api key: ${secret}`,
			runType: "exec",
			startedAt: 1_700_000_000_000,
		});
		finalizeRunArtifacts({
			workflowId: "wf-api-key",
			runId: "run-api-key",
			agent: "hunter-security",
			cwd: "/repo",
			prompt: `call provider with api key: ${secret}`,
			runType: "exec",
			startedAt: 1_700_000_000_000,
			completedAt: 1_700_000_001_000,
			artifacts,
			result: {
				success: true,
				stdout: `provider replied; api key: ${secret}`,
				stderr: "",
				exitCode: 0,
				signal: null,
				timedOut: false,
				aborted: false,
				command: "/opt/homebrew/bin/acpx",
				args: ["exec", "hunter-security"],
				finalAnswer: `provider replied; api key: ${secret}`,
				fullTranscript: `provider replied; api key: ${secret}`,
				durationMs: 1000,
			},
		});
		const persisted = [
			readFileSync(artifacts.promptPath, "utf8"),
			readFileSync(artifacts.outputPath, "utf8"),
			readFileSync(artifacts.metadataPath, "utf8"),
		].join("\n");
		expect(persisted).not.toContain(secret);
	});

	test("rejects empty workflow and run identifiers", () => {
		expect(() =>
			createRunArtifacts({
				workflowId: "",
				runId: "run",
				agent: "codebase-locator",
				cwd: "/repo",
				prompt: "inspect",
				runType: "exec",
				startedAt: 1_700_000_000_000,
			}),
		).toThrow("workflowId is required");
		expect(() =>
			createRunArtifacts({
				workflowId: "wf",
				runId: "",
				agent: "codebase-locator",
				cwd: "/repo",
				prompt: "inspect",
				runType: "exec",
				startedAt: 1_700_000_000_000,
			}),
		).toThrow("runId is required");
	});

	test("redacts password-style secrets from persisted artifact files", () => {
		const root = mkdtempSync(path.join(tmpdir(), "pantheon-artifacts-password-test-"));
		process.env.PANTHEON_ARTIFACTS_DIR = root;
		const secret = "ArgusPasswordLeak-9d04f7";
		const artifacts = createRunArtifacts({
			workflowId: "wf-password",
			runId: "run-password",
			agent: "hunter-security",
			cwd: "/repo",
			prompt: `debug login password=${secret}`,
			runType: "exec",
			startedAt: 1_700_000_000_000,
		});
		finalizeRunArtifacts({
			workflowId: "wf-password",
			runId: "run-password",
			agent: "hunter-security",
			cwd: "/repo",
			prompt: `debug login password=${secret}`,
			runType: "exec",
			startedAt: 1_700_000_000_000,
			completedAt: 1_700_000_001_000,
			artifacts,
			result: {
				success: false,
				stdout: `printed password=${secret}`,
				stderr: `stderr password=${secret}`,
				exitCode: 1,
				signal: null,
				timedOut: false,
				aborted: false,
				command: "/opt/homebrew/bin/acpx",
				args: ["exec", "hunter-security"],
				finalAnswer: `printed password=${secret}`,
				fullTranscript: `printed password=${secret}`,
				durationMs: 1000,
			},
		});
		const persisted = [
			readFileSync(artifacts.promptPath, "utf8"),
			readFileSync(artifacts.outputPath, "utf8"),
			readFileSync(artifacts.stderrPath, "utf8"),
			readFileSync(artifacts.metadataPath, "utf8"),
		].join("\n");
		expect(persisted).not.toContain(secret);
	});
});
