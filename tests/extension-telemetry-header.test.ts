import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	appendCanonicalTelemetryHeader,
	buildCanonicalTelemetryHeader,
	isSafeTelemetrySessionFile,
} from "../src/extension/index.ts";

describe("extension canonical telemetry header", () => {
	let tempDir: string;
	let homeDir: string;
	let savedDebug: string | undefined;
	let savedMainAgent: string | undefined;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pantheon-extension-header-test-${crypto.randomUUID()}`);
		homeDir = path.join(tempDir, "home");
		mkdirSync(homeDir, { recursive: true });
		savedDebug = process.env.PANTHEON_TELEMETRY_DEBUG;
		delete process.env.PANTHEON_TELEMETRY_DEBUG;
		savedMainAgent = process.env.PANTHEON_MAIN_AGENT;
		delete process.env.PANTHEON_MAIN_AGENT;
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		if (savedDebug === undefined) delete process.env.PANTHEON_TELEMETRY_DEBUG;
		else process.env.PANTHEON_TELEMETRY_DEBUG = savedDebug;
		if (savedMainAgent === undefined) delete process.env.PANTHEON_MAIN_AGENT;
		else process.env.PANTHEON_MAIN_AGENT = savedMainAgent;
	});

	test("builds a versioned metadata-only header without raw session id or prompt content", () => {
		const header = buildCanonicalTelemetryHeader({
			traceId: "trace-123",
			spanId: "span-123",
			sessionHash: "hash-123",
			correlationId: "corr-123",
			startedAt: Date.parse("2026-05-25T03:00:00.000Z"),
		});

		expect(header).toEqual({
			type: "pantheon_telemetry_header",
			event: "pantheon.telemetry.header",
			kind: "telemetry_metadata",
			schema_version: 1,
			trace_id: "trace-123",
			correlation_id: "corr-123",
			session_id_hash: "hash-123",
			span_id: "span-123",
			agent_name: "athena",
			agent_role: "primary-builder-orchestrator",
			started_at: "2026-05-25T03:00:00.000Z",
		});
		expect(JSON.stringify(header)).not.toContain("sessionId");
		expect(JSON.stringify(header)).not.toContain("prompt");
	});

	test("labels explicit non-default main agents when provided", () => {
		const header = buildCanonicalTelemetryHeader({
			traceId: "trace-123",
			sessionHash: "hash-123",
			correlationId: "corr-123",
			agentName: "zeus",
		});

		expect(header).toMatchObject({
			agent_name: "zeus",
			agent_role: "orchestrator",
		});
	});

	test("appends once only to absolute jsonl files under known home-derived session roots", () => {
		const sessionPath = path.join(homeDir, ".pi/agent/sessions/main.jsonl");
		mkdirSync(path.dirname(sessionPath), { recursive: true });
		writeFileSync(sessionPath, `${JSON.stringify({ type: "pi_session_start" })}\n`);

		expect(isSafeTelemetrySessionFile(sessionPath, { homeDir })).toBe(true);
		const input = {
			traceId: "trace-safe",
			spanId: "span-safe",
			sessionHash: "hash-safe",
			correlationId: "corr-safe",
			startedAt: Date.parse("2026-05-25T03:01:00.000Z"),
		};
		expect(appendCanonicalTelemetryHeader(sessionPath, input, { homeDir })).toBe(true);
		expect(appendCanonicalTelemetryHeader(sessionPath, input, { homeDir })).toBe(false);

		const rows = readFileSync(sessionPath, "utf8")
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(rows).toHaveLength(2);
		expect(rows[1]).toMatchObject({
			type: "pantheon_telemetry_header",
			trace_id: "trace-safe",
			correlation_id: "corr-safe",
			session_id_hash: "hash-safe",
		});
	});

	test("does not create the session file when it does not exist yet (EEXIST regression guard)", () => {
		// Pi 0.78+ flushes its session file with an exclusive openSync(file, "wx"). If we pre-create
		// the file the flush throws EEXIST, so appendCanonicalTelemetryHeader must never create it.
		const sessionPath = path.join(homeDir, ".pi/agent/sessions/not-yet-created.jsonl");
		mkdirSync(path.dirname(sessionPath), { recursive: true });

		expect(isSafeTelemetrySessionFile(sessionPath, { homeDir })).toBe(true);
		const input = {
			traceId: "trace-deferred",
			spanId: "span-deferred",
			sessionHash: "hash-deferred",
			correlationId: "corr-deferred",
			startedAt: Date.parse("2026-05-25T03:03:00.000Z"),
		};

		expect(appendCanonicalTelemetryHeader(sessionPath, input, { homeDir })).toBe(false);
		// The load-bearing assertion: the file must NOT have been created as a side effect.
		expect(existsSync(sessionPath)).toBe(false);

		// Once Pi has created the file, the header appends successfully.
		writeFileSync(sessionPath, `${JSON.stringify({ type: "pi_session_start" })}\n`);
		expect(appendCanonicalTelemetryHeader(sessionPath, input, { homeDir })).toBe(true);
	});

	test("refuses non-jsonl, relative, and arbitrary absolute paths without throwing", () => {
		const arbitraryPath = path.join(tempDir, "outside/session.jsonl");
		mkdirSync(path.dirname(arbitraryPath), { recursive: true });
		writeFileSync(arbitraryPath, "");

		const input = {
			traceId: "trace-unsafe",
			spanId: "span-unsafe",
			sessionHash: "hash-unsafe",
			correlationId: "corr-unsafe",
			startedAt: Date.parse("2026-05-25T03:02:00.000Z"),
		};
		expect(isSafeTelemetrySessionFile("relative.jsonl", { homeDir })).toBe(false);
		expect(isSafeTelemetrySessionFile(path.join(homeDir, ".pi/agent/sessions/not-json.txt"), { homeDir })).toBe(false);
		expect(isSafeTelemetrySessionFile(arbitraryPath, { homeDir })).toBe(false);
		expect(appendCanonicalTelemetryHeader(arbitraryPath, input, { homeDir })).toBe(false);
		expect(readFileSync(arbitraryPath, "utf8")).toBe("");
	});
});
