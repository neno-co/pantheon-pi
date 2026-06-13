import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	buildAcpxRunAttributes,
	classifyAcpxFailure,
	createInMemoryLangWatchRuntime,
	DEFAULT_LANGWATCH_ENDPOINT,
	decideSpanStatus,
	endMainAgentTrace,
	endMainToolSpan,
	endMainTurn,
	getCurrentMainTraceEnv,
	parseAcpxTranscriptEvents,
	parseLangWatchConfig,
	redactLangWatchContent,
	resetLangWatchRuntimeForTests,
	setLangWatchRuntimeForTests,
	startMainAgentTrace,
	startMainToolSpan,
	startMainTurn,
	summarizeValue,
	traceAcpxRun,
	withLangWatchTrace,
} from "../src/langwatch/index.ts";
import type { AcpxRunResult } from "../src/runner/index.ts";

describe("langwatch config", () => {
	test("is disabled safely when LANGWATCH_API_KEY is absent", () => {
		const config = parseLangWatchConfig({});

		expect(config.enabled).toBe(false);
		expect(config.apiKey).toBeUndefined();
		expect(config.endpoint).toBe(DEFAULT_LANGWATCH_ENDPOINT);
		expect(config.captureContent).toBe(true);
		expect(config.serviceName).toBe("pantheon-pi");
	});

	test("uses endpoint/debug env configuration while keeping safe fixed content decisions", () => {
		const config = parseLangWatchConfig({
			LANGWATCH_API_KEY: " key ",
			LANGWATCH_ENDPOINT: "https://example.test/",
			LANGWATCH_SERVICE_NAME: "ignored-service",
			LANGWATCH_CAPTURE_CONTENT: "false",
			LANGWATCH_REDACTION_STYLE: "summary",
			LANGWATCH_DEBUG: "true",
		});

		expect(config).toMatchObject({
			enabled: true,
			apiKey: "key",
			endpoint: "https://example.test",
			serviceName: "pantheon-pi",
			captureContent: true,
			redactionStyle: "hash",
			debug: true,
		});
	});

	test("enables debug with Pantheon-specific flag", () => {
		const config = parseLangWatchConfig({ LANGWATCH_API_KEY: "key", PANTHEON_LANGWATCH_DEBUG: "1" });

		expect(config.debug).toBe(true);
	});
});

describe("langwatch content redaction", () => {
	test("redacts common secrets before storing captured content", () => {
		const redacted = redactLangWatchContent(
			"LANGWATCH_API_KEY=lw_secret_123\nAuthorization: Bearer token-123\nkeep this output",
		);

		expect(redacted).toContain("LANGWATCH_API_KEY=[REDACTED]");
		expect(redacted).toContain("Authorization: Bearer [REDACTED]");
		expect(redacted).toContain("keep this output");
		expect(redacted).not.toContain("lw_secret_123");
		expect(redacted).not.toContain("token-123");
	});

	test("summarizes strings without leaking content by default", () => {
		const summary = summarizeValue("super-secret-prompt");

		expect(summary).toMatchObject({ type: "string", length: 19 });
		expect(summary.hash).toMatch(/^[a-f0-9]{64}$/);
		expect("value" in summary).toBe(false);
	});
});

describe("acpx run attributes", () => {
	const result: AcpxRunResult = {
		success: true,
		stdout: "final answer with sensitive detail",
		stderr: "warning detail",
		exitCode: 0,
		signal: null,
		timedOut: false,
		aborted: false,
		command: "acpx",
		args: ["oracle", "exec", "prompt"],
		finalAnswer: "final answer with sensitive detail",
		fullTranscript: "transcript",
		durationMs: 123,
	};

	test("records success, duration, exit and captured redacted output", () => {
		const attrs = buildAcpxRunAttributes(
			{
				agent: "oracle",
				prompt: "audit secrets",
				runType: "exec",
				cwd: "/repo",
				permissions: "approve-reads",
				timeoutSeconds: 60,
			},
			result,
			{ captureContent: true },
		);

		expect(attrs["langwatch.span.type"]).toBe("tool");
		expect(attrs["pantheon.agent"]).toBe("oracle");
		expect(attrs["pantheon.run_type"]).toBe("exec");
		expect(attrs["pantheon.run.success"]).toBe(true);
		expect(attrs["pantheon.run.duration_ms"]).toBe(123);
		expect(attrs["pantheon.run.exit_code"]).toBe(0);
		expect(attrs["pantheon.prompt.length"]).toBe(13);
		expect(attrs["pantheon.stdout.length"]).toBe(34);
		expect(attrs["pantheon.stderr.length"]).toBe(14);
		expect(attrs["langwatch.input"]).toBe("audit secrets");
		expect(attrs["langwatch.output"]).toBe("final answer with sensitive detail");
		expect(attrs["pantheon.stderr"]).toBe("warning detail");
		expect(attrs["pantheon.stdout.hash"]).toMatch(/^[a-f0-9]{64}$/);
	});

	test("parses transcript markers for nested child spans", () => {
		const events = parseAcpxTranscriptEvents(
			"[thinking] plan\n[tool] functions.read {path}\n[client] received output\nfinal answer\n[done]",
		);

		expect(events).toEqual([
			{ kind: "thinking", index: 1, line: "[thinking] plan", label: "plan" },
			{ kind: "tool", index: 2, line: "[tool] functions.read {path}", label: "functions.read {path}" },
			{ kind: "client", index: 3, line: "[client] received output", label: "received output" },
			{ kind: "done", index: 4, line: "[done]", label: "" },
		]);
	});

	test("records session and turn metadata for stateful runs", () => {
		const attrs = buildAcpxRunAttributes(
			{
				agent: "oracle",
				prompt: "continue",
				runType: "session",
				sessionId: "phase-4",
				maxTurns: 4,
				ttlSeconds: 30,
			},
			{ ...result, stdout: "[thinking] one\n[tool] read (completed)\n[thinking] two\nfinal" },
			{ captureContent: false },
		);

		expect(attrs["pantheon.run_type"]).toBe("session");
		expect(attrs["pantheon.session_id.hash"]).toMatch(/^[a-f0-9]{64}$/);
		expect(attrs["pantheon.max_turns"]).toBe(4);
		expect(attrs["pantheon.ttl_seconds"]).toBe(30);
		expect(attrs["pantheon.turn_count"]).toBe(2);
		expect(attrs["pantheon.tool_event_count"]).toBe(1);
	});
});

describe("traceAcpxRun", () => {
	test("does not report a resolved void forceFlush as a timeout", async () => {
		const runtime = createInMemoryLangWatchRuntime();
		const originalDebug = process.env.PANTHEON_LANGWATCH_DEBUG;
		const warn = console.warn;
		const warnings: string[] = [];
		process.env.PANTHEON_LANGWATCH_DEBUG = "true";
		console.warn = (message?: unknown) => {
			warnings.push(String(message));
		};
		setLangWatchRuntimeForTests({
			...runtime,
			async forceFlush() {
				return undefined;
			},
		});

		try {
			await traceAcpxRun({ agent: "oracle", prompt: "flush", runType: "exec" }, () =>
				Promise.resolve({
					success: true,
					stdout: "done",
					stderr: "",
					exitCode: 0,
					signal: null,
					timedOut: false,
					aborted: false,
					command: "acpx",
					args: ["oracle"],
					finalAnswer: "done",
					fullTranscript: "done",
					durationMs: 1,
				}),
			);
		} finally {
			console.warn = warn;
			if (originalDebug === undefined) delete process.env.PANTHEON_LANGWATCH_DEBUG;
			else process.env.PANTHEON_LANGWATCH_DEBUG = originalDebug;
			resetLangWatchRuntimeForTests();
		}

		expect(warnings.join("\n")).not.toContain("timed out");
	});

	test("awaits runtime forceFlush before resolving", async () => {
		const runtime = createInMemoryLangWatchRuntime();
		let flushResolved = false;
		const flushed = Promise.withResolvers<void>();
		setLangWatchRuntimeForTests({
			...runtime,
			async forceFlush() {
				await flushed.promise;
				flushResolved = true;
			},
		});

		const pending = traceAcpxRun({ agent: "oracle", prompt: "flush", runType: "exec" }, () =>
			Promise.resolve({
				success: true,
				stdout: "done",
				stderr: "",
				exitCode: 0,
				signal: null,
				timedOut: false,
				aborted: false,
				command: "acpx",
				args: ["oracle"],
				finalAnswer: "done",
				fullTranscript: "done",
				durationMs: 1,
			}),
		);
		await Promise.resolve();
		let settled = false;
		pending.then(() => {
			settled = true;
		});
		await Promise.resolve();

		expect(settled).toBe(false);
		expect(flushResolved).toBe(false);
		flushed.resolve();
		await pending;
		expect(flushResolved).toBe(true);
		resetLangWatchRuntimeForTests();
	});

	test("creates child spans for acpx transcript markers under the run span", async () => {
		const runtime = createInMemoryLangWatchRuntime();
		setLangWatchRuntimeForTests(runtime);
		const transcript = "[thinking] inspect state\n[tool] functions.read package.json\n[client] tool result\n[done]";

		const result = await traceAcpxRun(
			{
				agent: "oracle",
				prompt: "review",
				runType: "session",
				sessionId: "session-1",
			},
			() =>
				Promise.resolve({
					success: true,
					stdout: transcript,
					stderr: "",
					exitCode: 0,
					signal: null,
					timedOut: false,
					aborted: false,
					command: "acpx",
					args: ["oracle"],
					finalAnswer: "done",
					fullTranscript: transcript,
					durationMs: 42,
				}),
		);

		expect(result.success).toBe(true);
		const spans = runtime.getFinishedSpans();
		const runSpan = spans.find((span) => span.name === "pantheon.acpx.run");
		const childSpans = spans.filter((span) => span.name.startsWith("pantheon.acpx.event."));

		expect(runSpan).toBeDefined();
		expect(childSpans.map((span) => span.name)).toEqual([
			"pantheon.acpx.event.thinking",
			"pantheon.acpx.event.tool",
			"pantheon.acpx.event.client",
			"pantheon.acpx.event.done",
		]);
		for (const span of childSpans) {
			expect(span.parentSpanContext?.spanId).toBe(runSpan?.spanContext().spanId);
			expect(span.attributes["pantheon.event.index"]).toBeGreaterThan(0);
			expect(span.attributes["pantheon.event.line.hash"]).toMatch(/^[a-f0-9]{64}$/);
		}
		expect(childSpans[1].attributes["pantheon.tool.name"]).toBe("functions.read");
		resetLangWatchRuntimeForTests();
	});
});

describe("main session tracing", () => {
	let savedMainAgent: string | undefined;

	beforeEach(() => {
		savedMainAgent = process.env.PANTHEON_MAIN_AGENT;
		delete process.env.PANTHEON_MAIN_AGENT;
	});

	afterEach(() => {
		if (savedMainAgent === undefined) delete process.env.PANTHEON_MAIN_AGENT;
		else process.env.PANTHEON_MAIN_AGENT = savedMainAgent;
	});

	test("awaits runtime forceFlush when ending the main agent trace", async () => {
		const runtime = createInMemoryLangWatchRuntime();
		let flushResolved = false;
		const flushed = Promise.withResolvers<void>();
		setLangWatchRuntimeForTests({
			...runtime,
			async forceFlush() {
				await flushed.promise;
				flushResolved = true;
			},
		});

		await startMainAgentTrace({ prompt: "flush main", sessionId: "pi-session-flush", cwd: "/repo" });
		const pending = endMainAgentTrace("done");
		await Promise.resolve();
		let settled = false;
		pending.then(() => {
			settled = true;
		});
		await Promise.resolve();

		expect(settled).toBe(false);
		flushed.resolve();
		await pending;
		expect(flushResolved).toBe(true);
		resetLangWatchRuntimeForTests();
	});

	test("labels explicit non-default main agents", async () => {
		const runtime = createInMemoryLangWatchRuntime();
		setLangWatchRuntimeForTests(runtime);
		await startMainAgentTrace({
			prompt: "legacy orchestration",
			sessionId: "pi-session-zeus",
			cwd: "/repo",
			agentId: "zeus",
		});
		startMainTurn({ turnIndex: 1 });
		endMainTurn("done");
		await endMainAgentTrace("done");

		const spans = runtime.getFinishedSpans();
		const root = spans.find((span) => span.name === "pantheon.pi.main");
		const turn = spans.find((span) => span.name === "pantheon.pi.turn");
		expect(root?.attributes["pantheon.agent"]).toBe("zeus");
		expect(turn?.attributes["pantheon.agent"]).toBe("zeus");
		resetLangWatchRuntimeForTests();
	});

	test("creates root, turn, tool and delegated acpx spans with shared trace/session metadata", async () => {
		const runtime = createInMemoryLangWatchRuntime();
		setLangWatchRuntimeForTests(runtime);

		const state = await startMainAgentTrace({ prompt: "delegate safely", sessionId: "pi-session-A", cwd: "/repo" });
		expect(state).toBeDefined();
		startMainTurn({ turnIndex: 1 });
		startMainToolSpan({ toolCallId: "tool-1", toolName: "acpx", args: { prompt: "ask oracle" } });
		const env = getCurrentMainTraceEnv();
		expect(env?.TRACEPARENT).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
		expect(env?.PANTHEON_SESSION_ID).toBe("pi-session-A");

		await traceAcpxRun({ agent: "oracle", prompt: "ask oracle", runType: "exec" }, () =>
			Promise.resolve({
				success: true,
				stdout: "delegated output",
				stderr: "",
				exitCode: 0,
				signal: null,
				timedOut: false,
				aborted: false,
				command: "acpx",
				args: ["oracle"],
				finalAnswer: "delegated output",
				fullTranscript: "delegated output",
				durationMs: 7,
			}),
		);
		endMainToolSpan({ toolCallId: "tool-1", result: "tool output" });
		endMainTurn("assistant output");
		await endMainAgentTrace("final output");

		const spans = runtime.getFinishedSpans();
		const root = spans.find((span) => span.name === "pantheon.pi.main");
		const turn = spans.find((span) => span.name === "pantheon.pi.turn");
		const acpx = spans.find((span) => span.name === "pantheon.acpx.run");
		expect(root?.attributes["langwatch.input"]).toBe("delegate safely");
		expect(root?.attributes["langwatch.output"]).toBe("final output");
		expect(root?.attributes["pantheon.agent"]).toBe("athena");
		expect(turn?.attributes["pantheon.agent"]).toBe("athena");
		expect(root?.attributes["pantheon.correlation_id"]).toEqual(turn?.attributes["pantheon.correlation_id"]);
		expect(acpx?.spanContext().traceId).toBe(root?.spanContext().traceId);
		expect(acpx?.parentSpanContext?.spanId).toBe(turn?.spanContext().spanId);
		expect(acpx?.attributes["langwatch.output"]).toBe("delegated output");
		expect(acpx?.attributes["pantheon.session_id.hash"]).toBe(root?.attributes["pantheon.session_id.hash"]);
		resetLangWatchRuntimeForTests();
	});
});

describe("withLangWatchTrace", () => {
	test("creates an in-memory span with trace correlation attributes", async () => {
		const runtime = createInMemoryLangWatchRuntime();
		const result = await withLangWatchTrace(
			{
				agentId: "oracle",
				runType: "exec",
				traceId: "0123456789abcdef0123456789abcdef",
				parentSpanId: "0123456789abcdef",
				sessionId: "session-1",
			},
			() => Promise.resolve("ok"),
			{ runtime },
		);

		expect(result.result).toBe("ok");
		const spans = runtime.getFinishedSpans();
		expect(spans).toHaveLength(1);
		expect(spans[0].name).toBe("pantheon.acpx.run");
		expect(spans[0].spanContext().traceId).toBe("0123456789abcdef0123456789abcdef");
		expect(spans[0].parentSpanContext?.spanId).toBe("0123456789abcdef");
		expect(spans[0].attributes["pantheon.trace_id"]).toBe("0123456789abcdef0123456789abcdef");
		expect(spans[0].attributes["pantheon.parent_span_id"]).toBe("0123456789abcdef");
		expect(spans[0].attributes["pantheon.session_id.hash"]).toMatch(/^[a-f0-9]{64}$/);
	});
});

describe("classifyAcpxFailure — failure taxonomy (C4, C5, R1)", () => {
	const base = { stdout: "", stderr: "", timedOut: false, aborted: false };

	test("classifies timeout", () => {
		expect(classifyAcpxFailure({ ...base, timedOut: true }).class).toBe("timeout");
	});

	test("classifies aborted", () => {
		expect(classifyAcpxFailure({ ...base, aborted: true }).class).toBe("aborted");
	});

	test("classifies max_turns and extracts cap N (C5)", () => {
		const result = classifyAcpxFailure({ ...base, stderr: "Reached maximum number of turns (50)" });
		expect(result.class).toBe("max_turns");
		expect(result.maxTurnsCap).toBe(50);
	});

	test("classifies auth failure", () => {
		expect(classifyAcpxFailure({ ...base, stderr: "Authentication required: please log in" }).class).toBe("auth");
	});

	test("classifies set_model_rejected", () => {
		expect(classifyAcpxFailure({ ...base, stderr: "session_set_model call failed" }).class).toBe("set_model_rejected");
	});

	test("classifies rate_limit", () => {
		expect(classifyAcpxFailure({ ...base, stderr: "session limit exceeded" }).class).toBe("rate_limit");
	});

	test("classifies unknown as other", () => {
		expect(classifyAcpxFailure({ ...base, stderr: "unexpected crash" }).class).toBe("other");
	});

	test("timeout takes priority over max_turns text in stderr", () => {
		const result = classifyAcpxFailure({
			...base,
			timedOut: true,
			stderr: "Reached maximum number of turns (20)",
		});
		expect(result.class).toBe("timeout");
	});
});

describe("buildAcpxRunAttributes — failure telemetry (C6, C7, R1)", () => {
	const baseResult: AcpxRunResult = {
		success: false,
		stdout: "",
		stderr: "Connection refused",
		exitCode: 1,
		signal: null,
		timedOut: false,
		aborted: false,
		command: "acpx",
		args: [],
		finalAnswer: "",
		fullTranscript: "",
		durationMs: 500,
	};

	test("sets pantheon.error.message even when result.error is undefined (C6)", () => {
		const attrs = buildAcpxRunAttributes({ agent: "vulkanus", prompt: "implement", runType: "session" }, baseResult, {
			captureContent: false,
		});
		expect(attrs["pantheon.error.message"]).toBeTruthy();
		expect(typeof attrs["pantheon.error.message"]).toBe("string");
		expect(attrs["pantheon.error.message"]).toContain("exit 1");
	});

	test("sets pantheon.failure.class on failure (C4)", () => {
		const attrs = buildAcpxRunAttributes({ agent: "vulkanus", prompt: "implement", runType: "session" }, baseResult, {
			captureContent: false,
		});
		expect(attrs["pantheon.failure.class"]).toBe("other");
	});

	test("sets pantheon.failure.max_turns_cap for max_turns failure (C5)", () => {
		const attrs = buildAcpxRunAttributes(
			{ agent: "vulkanus", prompt: "implement", runType: "session" },
			{ ...baseResult, stderr: "Reached maximum number of turns (50)" },
			{ captureContent: false },
		);
		expect(attrs["pantheon.failure.class"]).toBe("max_turns");
		expect(attrs["pantheon.failure.max_turns_cap"]).toBe(50);
	});

	test("does not set failure attributes on success", () => {
		const attrs = buildAcpxRunAttributes(
			{ agent: "vulkanus", prompt: "implement", runType: "exec" },
			{ ...baseResult, success: true, exitCode: 0 },
			{ captureContent: false },
		);
		expect(attrs["pantheon.failure.class"]).toBeUndefined();
		expect(attrs["pantheon.error.message"]).toBeUndefined();
	});
});

describe("decideSpanStatus — never returns bare 'operation failed' (C7)", () => {
	test("returns ERROR with real message when pantheon.error.message is set", () => {
		const decision = decideSpanStatus({
			"pantheon.run.success": false,
			"pantheon.error.message": "exit 1; Connection refused",
		});
		expect(decision.code).toBe("ERROR");
		expect(decision.message).not.toBe("operation failed");
		expect(decision.message).toContain("exit 1");
	});

	test("returns OK for successful run", () => {
		expect(decideSpanStatus({ "pantheon.run.success": true }).code).toBe("OK");
	});
});

describe("endMainToolSpan — Pi-side tool error propagation (C8)", () => {
	test("sets pantheon.tool.error.message from Pi SDK tool result content (C8)", async () => {
		resetLangWatchRuntimeForTests();
		const runtime = createInMemoryLangWatchRuntime();
		setLangWatchRuntimeForTests(runtime);
		await startMainAgentTrace({ agentId: "athena", sessionId: "s1", prompt: "p", startedAt: Date.now() });
		startMainTurn({ turnIndex: 1 });
		startMainToolSpan({ toolCallId: "tc-c8", toolName: "acpx" });
		endMainToolSpan({
			toolCallId: "tc-c8",
			isError: true,
			result: { content: [{ type: "text", text: "acpx exited with code 1; something went wrong" }], details: {} },
		});
		const spans = runtime.getFinishedSpans();
		const toolSpan = spans.find((s) => s.name === "pantheon.pi.tool.acpx");
		expect(toolSpan?.attributes["pantheon.tool.error"]).toBe(true);
		expect(toolSpan?.attributes["pantheon.tool.error.message"]).toContain("acpx exited with code 1");
		expect(toolSpan?.attributes["pantheon.tool.error.message"]).not.toBe("operation failed");
		resetLangWatchRuntimeForTests();
	});

	test("does not set pantheon.tool.error for successful tool call", async () => {
		resetLangWatchRuntimeForTests();
		const runtime = createInMemoryLangWatchRuntime();
		setLangWatchRuntimeForTests(runtime);
		await startMainAgentTrace({ agentId: "athena", sessionId: "s1", prompt: "p", startedAt: Date.now() });
		startMainTurn({ turnIndex: 1 });
		startMainToolSpan({ toolCallId: "tc-ok", toolName: "acpx" });
		endMainToolSpan({ toolCallId: "tc-ok", result: "all good" });
		const spans = runtime.getFinishedSpans();
		const toolSpan = spans.find((s) => s.name === "pantheon.pi.tool.acpx");
		expect(toolSpan?.attributes["pantheon.tool.error"]).toBeUndefined();
		resetLangWatchRuntimeForTests();
	});
});
