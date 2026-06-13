import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getAgentConfig, PANTHEON_AGENTS } from "../src/agents.ts";
import { extractFinalAnswer, runAcpx } from "../src/runner/index.ts";
import { generateUniqueAcpxSessionId, sanitizeAcpxSessionName } from "../src/workflow/session.ts";

process.env.LANGWATCH_API_KEY = "";

describe("acpx runner", () => {
	test("extracts the final answer from an acpx text transcript", () => {
		const transcript = [
			"[client] started (ok)",
			"[thinking] considering",
			"intermediate thought",
			"[tool] read (completed)",
			"Final answer line 1",
			"Final answer line 2",
			"[done]",
			"",
		].join("\n");

		expect(extractFinalAnswer(transcript)).toBe("Final answer line 1\nFinal answer line 2");
	});

	test("extracts the final answer after a leading acpx marker", () => {
		const transcript = ["[client] fake (started)", "final answer", "[done]", ""].join("\n");

		expect(extractFinalAnswer(transcript)).toBe("final answer");
	});

	test("filters Pi startup update notices from extracted final answers", () => {
		const transcript = [
			"[client] initialize (running)",
			"New version available: v0.78.0 (installed v0.75.4). Run: `npm i -g @earendil-works/pi-coding-agent`",
			"actual answer",
			"[done] end_turn",
			"",
		].join("\n");

		expect(extractFinalAnswer(transcript)).toBe("actual answer");
	});

	test("filters Pi startup update notices from full transcripts", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pantheon-acpx-update-noise-"));
		const fakeAcpx = path.join(dir, "acpx");
		writeFileSync(
			fakeAcpx,
			[
				"#!/usr/bin/env bash",
				"printf '%s\\n' '[client] initialize (running)'",
				"printf '%s\\n' 'New version available: v0.78.0 (installed v0.75.4). Run: `npm i -g @earendil-works/pi-coding-agent`'",
				"printf '%s\\n' 'actual answer'",
				"printf '%s\\n' '[done] end_turn'",
			].join("\n"),
		);
		chmodSync(fakeAcpx, 0o755);

		const result = await runAcpx({
			agent: "oracle",
			prompt: "hello",
			cwd: dir,
			binaryPath: fakeAcpx,
			timeoutSeconds: 5,
		});

		expect(result.finalAnswer).toBe("actual answer");
		expect(result.fullTranscript).not.toContain("New version available:");
	});

	test("executes a fake acpx binary and returns structured output", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pantheon-acpx-"));
		const fakeAcpx = path.join(dir, "acpx");
		writeFileSync(
			fakeAcpx,
			[
				"#!/usr/bin/env bash",
				'echo "[client] fake (started)"',
				'echo "[tool] noop (completed)"',
				'last_arg=""',
				'for arg in "$@"; do last_arg="$arg"; done',
				'echo "fake final answer for: $last_arg"',
				'echo "[done]"',
				'echo "fake stderr" >&2',
			].join("\n"),
		);
		chmodSync(fakeAcpx, 0o755);

		const result = await runAcpx({
			agent: "zeus",
			prompt: "hello",
			cwd: dir,
			binaryPath: fakeAcpx,
			timeoutSeconds: 5,
		});

		expect(result.success).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("fake stderr");
		expect(result.finalAnswer).toBe("fake final answer for: hello");
		expect(result.args).toContain("--agent");
		const joined = result.args.join(" ");
		expect(joined).toContain("agents/bin/zeus");
		expect(joined).toContain("PANTHEON_PI_MODEL='openai-codex/gpt-5.5'");
		expect(result.args).not.toContain("--model");
		expect(result.args).toContain("exec");
	});

	test("routes Claude Code agents through the adapter with configured models and injected prompts", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pantheon-acpx-claude-agents-"));
		const fakeAcpx = path.join(dir, "acpx");
		writeFileSync(
			fakeAcpx,
			["#!/usr/bin/env bash", 'echo "[client] fake (started)"', 'echo "agent answer"', 'echo "[done]"'].join("\n"),
		);
		chmodSync(fakeAcpx, 0o755);

		for (const [agent, model] of [
			["argus", "claude-opus-4-8"],
			["oracle", "claude-opus-4-8"],
			["vulkanus", "claude-sonnet-4-6"],
		] as const) {
			const result = await runAcpx({
				agent,
				prompt: "hello",
				cwd: dir,
				binaryPath: fakeAcpx,
				timeoutSeconds: 5,
			});

			expect(result.success).toBe(true);
			const joined = result.args.join(" ");
			expect(joined).toContain("--agent");
			expect(joined).toContain("@agentclientprotocol/claude-agent-acp@latest");
			// Pantheon-owned Claude Code route with the versioned prompt injected, never pi-acp.
			expect(result.args).toContain("--model");
			expect(result.args).toContain(model);
			expect(result.args).toContain("--append-system-prompt");
			expect(result.args).toContain("--approve-all");
			expect(result.args).not.toContain("--approve-reads");
			expect(joined).not.toContain("PI_ACP_PI_COMMAND");
			expect(joined).not.toContain(`agents/bin/${agent}`);
			const promptArg = result.args[result.args.indexOf("--append-system-prompt") + 1];
			expect(promptArg).toContain(agent);
		}
	});

	test("forces Claude Code agents to approve-all while preserving explicit deny-all", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pantheon-acpx-claude-permissions-"));
		const fakeAcpx = path.join(dir, "acpx");
		writeFileSync(fakeAcpx, ["#!/usr/bin/env bash", 'echo "ok"'].join("\n"));
		chmodSync(fakeAcpx, 0o755);

		const defaultResult = await runAcpx({
			agent: "librarian",
			prompt: "hello",
			cwd: dir,
			binaryPath: fakeAcpx,
			timeoutSeconds: 5,
		});
		expect(defaultResult.args).toContain("--approve-all");
		expect(defaultResult.args).not.toContain("--approve-reads");

		const readRequestResult = await runAcpx({
			agent: "librarian",
			prompt: "hello",
			cwd: dir,
			binaryPath: fakeAcpx,
			permissions: "approve-reads",
			timeoutSeconds: 5,
		});
		expect(readRequestResult.args).toContain("--approve-all");
		expect(readRequestResult.args).not.toContain("--approve-reads");

		const denyRequestResult = await runAcpx({
			agent: "librarian",
			prompt: "hello",
			cwd: dir,
			binaryPath: fakeAcpx,
			permissions: "deny-all",
			timeoutSeconds: 5,
		});
		expect(denyRequestResult.args).toContain("--deny-all");
		expect(denyRequestResult.args).not.toContain("--approve-all");
	});

	test("keeps non-Claude agents on approve-reads by default with explicit permission passthrough", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pantheon-acpx-pi-permissions-"));
		const fakeAcpx = path.join(dir, "acpx");
		writeFileSync(fakeAcpx, ["#!/usr/bin/env bash", 'echo "ok"'].join("\n"));
		chmodSync(fakeAcpx, 0o755);

		const defaultResult = await runAcpx({
			agent: "zeus",
			prompt: "hello",
			cwd: dir,
			binaryPath: fakeAcpx,
			timeoutSeconds: 5,
		});
		expect(defaultResult.args).toContain("--approve-reads");
		expect(defaultResult.args).not.toContain("--approve-all");

		const approveAllResult = await runAcpx({
			agent: "zeus",
			prompt: "hello",
			cwd: dir,
			binaryPath: fakeAcpx,
			permissions: "approve-all",
			timeoutSeconds: 5,
		});
		expect(approveAllResult.args).toContain("--approve-all");
		expect(approveAllResult.args).not.toContain("--approve-reads");

		const denyRequestResult = await runAcpx({
			agent: "zeus",
			prompt: "hello",
			cwd: dir,
			binaryPath: fakeAcpx,
			permissions: "deny-all",
			timeoutSeconds: 5,
		});
		expect(denyRequestResult.args).toContain("--deny-all");
		expect(denyRequestResult.args).not.toContain("--approve-all");
	});

	test("uses Oracle's 10 minute configured timeout by default", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pantheon-acpx-oracle-timeout-default-"));
		const fakeAcpx = path.join(dir, "acpx");
		const log = path.join(dir, "calls.log");
		writeFileSync(
			fakeAcpx,
			[
				"#!/usr/bin/env bash",
				`printf '%s\n' "$*" >> ${JSON.stringify(log)}`,
				'echo "[client] fake (started)"',
				'echo "oracle answer"',
				'echo "[done]"',
			].join("\n"),
		);
		chmodSync(fakeAcpx, 0o755);

		const result = await runAcpx({
			agent: "oracle",
			prompt: "hello",
			cwd: dir,
			binaryPath: fakeAcpx,
		});

		expect(result.success).toBe(true);
		const calls = await Bun.file(log).text();
		expect(calls).toContain("--timeout 600");
	});

	test("executes a deterministic stateful session path against fake acpx", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pantheon-acpx-session-"));
		const fakeAcpx = path.join(dir, "acpx");
		const log = path.join(dir, "calls.log");
		const marker = path.join(dir, "session-created");
		writeFileSync(
			fakeAcpx,
			[
				"#!/usr/bin/env bash",
				`printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
				'if [[ "$*" == *"sessions ensure"* ]]; then',
				`  touch ${JSON.stringify(marker)}`,
				'  echo "[client] session ensured (ok)"',
				"  exit 0",
				"fi",
				`if [[ "$*" == *"prompt -s phase-4"* && ! -f ${JSON.stringify(marker)} ]]; then`,
				'  echo "No acpx session found" >&2',
				'  echo "Create one: acpx pi sessions new --name phase-4" >&2',
				"  exit 4",
				"fi",
				'last_arg=""',
				'for arg in "$@"; do last_arg="$arg"; done',
				'echo "[client] session prompt (started)"',
				'echo "[thinking] turn 1"',
				'echo "session final answer for: $last_arg"',
				'echo "[done]"',
			].join("\n"),
		);
		chmodSync(fakeAcpx, 0o755);

		const result = await runAcpx({
			agent: "zeus",
			prompt: "remember this",
			runType: "session",
			sessionId: "phase-4",
			cwd: dir,
			binaryPath: fakeAcpx,
			maxTurns: 3,
			ttlSeconds: 7,
			timeoutSeconds: 5,
		});

		expect(result.success).toBe(true);
		expect(result.finalAnswer).toBe("session final answer for: remember this");
		const calls = await Bun.file(log).text();
		expect(calls).toContain("--agent env PANTHEON_PI_MODEL='openai-codex/gpt-5.5' PI_ACP_PI_COMMAND=");
		expect(calls).toContain("agents/bin/zeus");
		expect(calls).toContain("prompt -s phase-4 remember this");
		expect(calls).toContain("sessions ensure --name phase-4");
		expect(calls.indexOf("prompt -s phase-4 remember this")).toBeLessThan(
			calls.indexOf("sessions ensure --name phase-4"),
		);
		expect(calls).toContain("--max-turns 3");
		expect(calls).toContain("--ttl 7");
	});

	test("continues an existing completed session without running ensure first", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pantheon-acpx-session-resume-"));
		const fakeAcpx = path.join(dir, "acpx");
		const log = path.join(dir, "calls.log");
		writeFileSync(
			fakeAcpx,
			[
				"#!/usr/bin/env bash",
				`printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
				'if [[ "$*" == *"sessions ensure"* ]]; then',
				'  echo "Agent rejected session/set_model Method not found" >&2',
				"  exit 1",
				"fi",
				'last_arg=""',
				'for arg in "$@"; do last_arg="$arg"; done',
				'echo "[client] session prompt (started)"',
				'echo "resumed final answer for: $last_arg"',
				'echo "[done]"',
			].join("\n"),
		);
		chmodSync(fakeAcpx, 0o755);

		const result = await runAcpx({
			agent: "vulkanus",
			prompt: "continue",
			runType: "session",
			sessionId: "finished-vulkanus-session",
			cwd: dir,
			binaryPath: fakeAcpx,
			timeoutSeconds: 5,
		});

		expect(result.success).toBe(true);
		expect(result.finalAnswer).toBe("resumed final answer for: continue");
		const calls = await Bun.file(log).text();
		expect(calls).toContain("prompt -s finished-vulkanus-session continue");
		expect(calls).not.toContain("sessions ensure");
	});

	test("returns needs_attention when acpx streams a final human-wait answer but never completes", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pantheon-acpx-human-wait-"));
		const fakeAcpx = path.join(dir, "acpx");
		writeFileSync(
			fakeAcpx,
			[
				"#!/usr/bin/env bash",
				"trap '' TERM",
				'echo "[client] session prompt (started)"',
				'echo "**Status summary:**"',
				'echo "**Waiting for human:** Yes. Session is paused waiting for a Telegram operator to send messages."',
				"sleep 10",
			].join("\n"),
		);
		chmodSync(fakeAcpx, 0o755);
		const statuses: string[] = [];
		const started = Date.now();

		const result = await runAcpx({
			agent: "vulkanus",
			prompt: "live proof",
			runType: "session",
			sessionId: "human-wait-vulkanus-session",
			cwd: dir,
			binaryPath: fakeAcpx,
			timeoutSeconds: 5,
			onStatus: (status) => statuses.push(status),
		});

		expect(Date.now() - started).toBeLessThan(3_000);
		expect(result.success).toBe(true);
		expect(result.needsAttention).toBe(true);
		expect(result.timedOut).toBe(false);
		expect(result.finalAnswer).toContain("Waiting for human");
		expect(result.stderr).toContain("returning needs_attention");
		expect(statuses).toContain("needs_attention");
	});

	test("times out a session prompt and reports the safeguard failure", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pantheon-acpx-timeout-"));
		const fakeAcpx = path.join(dir, "acpx");
		writeFileSync(
			fakeAcpx,
			[
				"#!/usr/bin/env bash",
				'if [[ "$*" == *"sessions ensure"* ]]; then',
				'  echo "[client] session ensured (ok)"',
				"  exit 0",
				"fi",
				"sleep 2",
				'echo "too late"',
			].join("\n"),
		);
		chmodSync(fakeAcpx, 0o755);

		const result = await runAcpx({
			agent: "oracle",
			prompt: "hang",
			runType: "session",
			sessionId: "timeout-test",
			cwd: dir,
			binaryPath: fakeAcpx,
			timeoutSeconds: 1,
		});

		expect(result.success).toBe(false);
		expect(result.timedOut).toBe(true);
		expect(result.stderr).toContain("acpx timeout after 1s");
	});

	test("forces termination when a timed-out acpx process ignores SIGTERM", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pantheon-acpx-ignore-term-"));
		const fakeAcpx = path.join(dir, "acpx");
		writeFileSync(
			fakeAcpx,
			["#!/usr/bin/env bash", "trap '' TERM", "for _ in 1 2 3 4 5; do sleep 1; done", 'echo "too late"'].join("\n"),
		);
		chmodSync(fakeAcpx, 0o755);

		const result = await Promise.race([
			runAcpx({
				agent: "oracle",
				prompt: "hang",
				cwd: dir,
				binaryPath: fakeAcpx,
				timeoutSeconds: 1,
			}),
			new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_500)),
		]);

		expect(result).not.toBe("hung");
		if (result === "hung") return;
		expect(result.success).toBe(false);
		expect(result.timedOut).toBe(true);
		expect(result.signal).toBe("SIGKILL");
		expect(result.stderr).toContain("acpx timeout after 1s");
	});

	test("passes explicit model through for non-Pantheon external agents", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pantheon-acpx-external-model-"));
		const fakeAcpx = path.join(dir, "acpx");
		writeFileSync(
			fakeAcpx,
			["#!/usr/bin/env bash", 'echo "[client] fake (started)"', 'echo "external answer"', 'echo "[done]"'].join("\n"),
		);
		chmodSync(fakeAcpx, 0o755);

		const result = await runAcpx({
			agent: "external-agent",
			prompt: "hello",
			cwd: dir,
			binaryPath: fakeAcpx,
			model: "test/model-proof",
			timeoutSeconds: 5,
		});

		expect(result.args).toContain("--model");
		expect(result.args).toContain("test/model-proof");
		expect(result.args.join(" ")).toContain("external-agent");
		expect(result.args.join(" ")).not.toContain("PANTHEON_PI_MODEL");
	});

	test("keeps non-Pantheon agents on acpx named-agent routing", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pantheon-acpx-external-"));
		const fakeAcpx = path.join(dir, "acpx");
		const log = path.join(dir, "calls.log");
		writeFileSync(
			fakeAcpx,
			["#!/usr/bin/env bash", `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`, 'echo "external final answer"'].join(
				"\n",
			),
		);
		chmodSync(fakeAcpx, 0o755);

		const result = await runAcpx({
			agent: "external-agent",
			prompt: "hello",
			cwd: dir,
			binaryPath: fakeAcpx,
			timeoutSeconds: 5,
		});

		expect(result.success).toBe(true);
		const calls = await Bun.file(log).text();
		expect(calls).toContain("external-agent exec hello");
		expect(calls).not.toContain("--agent env PI_ACP_PI_COMMAND");
	});

	test("reports an actionable error for silent acpx failures", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pantheon-acpx-silent-fail-"));
		const fakeAcpx = path.join(dir, "acpx");
		writeFileSync(fakeAcpx, ["#!/usr/bin/env bash", "exit 1"].join("\n"));
		chmodSync(fakeAcpx, 0o755);

		const result = await runAcpx({
			agent: "athena",
			prompt: "hello",
			cwd: dir,
			binaryPath: fakeAcpx,
			timeoutSeconds: 5,
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("acpx produced no output while launching athena");
		expect(result.stderr).toContain("packaged explicit agent command was used");
	});

	test("builds a working acpx route for every Pantheon agent", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pantheon-acpx-all-agents-"));
		const fakeAcpx = path.join(dir, "acpx");
		writeFileSync(
			fakeAcpx,
			["#!/usr/bin/env bash", 'echo "[client] fake (started)"', 'echo "route ok"', 'echo "[done]"'].join("\n"),
		);
		chmodSync(fakeAcpx, 0o755);

		for (const agent of PANTHEON_AGENTS) {
			const config = getAgentConfig(agent);
			const result = await runAcpx({
				agent,
				prompt: "hello",
				cwd: dir,
				binaryPath: fakeAcpx,
				timeoutSeconds: 5,
			});

			expect(result.success).toBe(true);
			if (config.backend.kind === "claude-agent-acp") {
				expect(result.args).toContain("--model");
				expect(result.args).toContain(config.model);
				expect(result.args).toContain("--append-system-prompt");
				expect(result.args.join(" ")).toContain("@agentclientprotocol/claude-agent-acp@latest");
			} else {
				expect(result.args).not.toContain("--model");
				expect(result.args.join(" ")).toContain(`PANTHEON_PI_MODEL='${config.model}'`);
				expect(result.args.join(" ")).toContain(`agents/bin/${agent}`);
			}
		}
	});

	test("rejects invalid session safeguard values before spawning acpx", async () => {
		const result = await runAcpx({
			agent: "oracle",
			prompt: "loop forever",
			runType: "session",
			binaryPath: "/path/that/should/not/run",
			maxTurns: 0,
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("maxTurns must be at least 1");
		expect(result.args).toEqual([]);
	});
});

describe("session ID generation — uniqueness and single source of truth (C11, R2)", () => {
	test("generateUniqueAcpxSessionId returns a unique id per call", () => {
		const id1 = generateUniqueAcpxSessionId("vulkanus");
		const id2 = generateUniqueAcpxSessionId("vulkanus");
		expect(id1).not.toBe(id2);
	});

	test("generateUniqueAcpxSessionId never returns bare 'pantheon-<agent>'", () => {
		for (let i = 0; i < 10; i++) {
			const id = generateUniqueAcpxSessionId("vulkanus");
			expect(id).not.toBe("pantheon-vulkanus");
			expect(id).toMatch(/^pantheon-vulkanus-[a-z0-9]+-[a-z0-9]+$/);
		}
	});

	test("sanitizeAcpxSessionName uses generateUniqueAcpxSessionId as fallback (no bare default)", () => {
		const id = sanitizeAcpxSessionName("vulkanus");
		expect(id).not.toBe("pantheon-vulkanus");
		expect(id).toMatch(/^pantheon-vulkanus-[a-z0-9]+-[a-z0-9]+$/);
	});

	test("sanitizeAcpxSessionName preserves an explicit caller-supplied sessionId", () => {
		const id = sanitizeAcpxSessionName("vulkanus", "neo-42-vulkanus-impl");
		expect(id).toBe("neo-42-vulkanus-impl");
	});

	test("extension and runner resolve the same id when caller supplies sessionId", () => {
		const suppliedId = "neo-42-vulkanus-impl";
		const fromExtension = sanitizeAcpxSessionName("vulkanus", suppliedId);
		const fromRunner = sanitizeAcpxSessionName("vulkanus", suppliedId);
		expect(fromExtension).toBe(fromRunner);
	});

	test("two no-sessionId calls produce distinct ids (no shared-session bleed)", () => {
		const id1 = sanitizeAcpxSessionName("vulkanus");
		const id2 = sanitizeAcpxSessionName("vulkanus");
		expect(id1).not.toBe(id2);
	});
});
