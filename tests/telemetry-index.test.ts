import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { telemetryMain } from "../src/telemetry/cli/index.ts";
import { DETERMINISTIC_EMBEDDING_DIMENSIONS } from "../src/telemetry/embed/index.ts";
import { ingestTelemetry } from "../src/telemetry/ingest/index.ts";
import { openTelemetryStore } from "../src/telemetry/store/index.ts";

function writeJsonl(filePath: string, rows: unknown[]) {
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function readDb(dbPath: string) {
	return new Database(dbPath, { readonly: true });
}

function recentLangWatchEpochMs(hoursAgo = 1, offsetMs = 0) {
	return Date.now() - hoursAgo * 60 * 60 * 1000 + offsetMs;
}

describe("local telemetry index", () => {
	let tempDir: string;
	let dbPath: string;
	let savedLangWatchKey: string | undefined;
	let savedLangWatchEndpoint: string | undefined;
	let savedFetch: typeof fetch;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pantheon-telemetry-test-${crypto.randomUUID()}`);
		dbPath = path.join(tempDir, "telemetry.db");
		mkdirSync(tempDir, { recursive: true });
		savedLangWatchKey = process.env.LANGWATCH_API_KEY;
		savedLangWatchEndpoint = process.env.LANGWATCH_ENDPOINT;
		savedFetch = globalThis.fetch;
		delete process.env.LANGWATCH_API_KEY;
		delete process.env.LANGWATCH_ENDPOINT;
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		if (savedLangWatchKey === undefined) delete process.env.LANGWATCH_API_KEY;
		else process.env.LANGWATCH_API_KEY = savedLangWatchKey;
		if (savedLangWatchEndpoint === undefined) delete process.env.LANGWATCH_ENDPOINT;
		else process.env.LANGWATCH_ENDPOINT = savedLangWatchEndpoint;
		globalThis.fetch = savedFetch;
	});

	test("migrates all required tables, views, and indexes without agent-specific physical tables", () => {
		const store = openTelemetryStore({ dbPath });
		store.close();

		const db = readDb(dbPath);
		const objects = db.query<{ name: string; type: string }, []>("SELECT name, type FROM sqlite_master").all();
		const names = new Set(objects.map((object) => object.name));
		for (const table of [
			"runs",
			"spans",
			"events",
			"documents",
			"documents_fts",
			"embeddings",
			"session_files",
			"trace_session_links",
			"tags",
			"run_tags",
			"schema_migrations",
			"ingest_cursors",
		])
			expect(names.has(table)).toBe(true);
		const migration = db
			.query<{ metadata: string }, []>("SELECT metadata FROM schema_migrations ORDER BY version DESC LIMIT 1")
			.get();
		expect(JSON.parse(migration?.metadata ?? "{}").embedding).toEqual({
			provider: "deterministic-token-hash",
			dimension: DETERMINISTIC_EMBEDDING_DIMENSIONS,
		});
		expect(names.has("quarantine_session_files")).toBe(true);
		expect(names.has("argus_runs")).toBe(true);
		expect(names.has("hunter_runs")).toBe(true);
		expect(objects.filter((object) => object.type === "table").map((object) => object.name)).not.toContain(
			"argus_runs",
		);
		expect(objects.filter((object) => object.type === "table").map((object) => object.name)).not.toContain(
			"hunter_runs",
		);
		db.close();
	});

	test("extension schedules best-effort post-run telemetry ingest on agent end without statically importing ingest", () => {
		const extensionSource = readFileSync(path.join(process.cwd(), "src/extension/index.ts"), "utf8");

		expect(extensionSource).toContain("schedulePostRunTelemetryIngest");
		expect(extensionSource).toContain('pi.on("agent_end"');
		expect(extensionSource).toContain('ingestTelemetry({ source: "all" })');
		expect(extensionSource).toContain("best-effort");

		// Pi loads the extension under Node, so the extension MUST NOT statically import
		// telemetry ingest/store/cli modules. Those modules pull in bun:sqlite and crash Node.
		expect(extensionSource).not.toMatch(/^\s*import[^\n]*from\s+["']\.\.\/telemetry\//m);
		// The post-run ingest must be loaded via dynamic import and gated on Bun runtime.
		expect(extensionSource).toContain('await import("../telemetry/ingest/index.ts")');
		expect(extensionSource).toContain("process.versions.bun");
	});

	test("ingests local sessions idempotently, links only by canonical triple, and quarantines malformed files", async () => {
		const piDir = path.join(tempDir, "pi-sessions");
		const acpxDir = path.join(tempDir, "acpx-sessions");
		writeJsonl(path.join(piDir, "zeus.jsonl"), [
			{
				type: "session_start",
				trace_id: "trace-zeus",
				correlation_id: "corr-zeus",
				session_id_hash: "sid-zeus",
				agent_name: "zeus",
				agent_role: "orchestrator",
				span_id: "run-zeus",
				started_at: "2026-05-25T00:00:00.000Z",
			},
			{ type: "final_answer", content: "Zeus delegated safely" },
		]);
		writeJsonl(path.join(acpxDir, "hunter.jsonl"), [
			{
				type: "session_start",
				trace_id: "trace-hunter",
				correlation_id: "corr-hunter",
				session_id_hash: "sid-hunter",
				agent_name: "hunter-test-coverage",
				agent_role: "hunter",
				span_id: "run-hunter",
				duration_ms: 385000,
				status: "ok",
				started_at: "2026-05-25T00:01:00.000Z",
			},
			{ type: "tool", content: "Coverage found a missing validation test" },
		]);
		writeJsonl(path.join(piDir, "broken.jsonl"), [
			{ type: "session_start", trace_id: "trace-broken", correlation_id: "corr-broken" },
		]);

		const first = await ingestTelemetry({ dbPath, piSessionDirs: [piDir], acpxSessionDirs: [acpxDir] });
		const second = await ingestTelemetry({ dbPath, piSessionDirs: [piDir], acpxSessionDirs: [acpxDir] });

		expect(first.sessionFiles.upserted).toBe(3);
		expect(first.traceSessionLinks.upserted).toBe(2);
		expect(second.sessionFiles.upserted).toBe(0);
		expect(second.traceSessionLinks.upserted).toBe(0);

		const db = readDb(dbPath);
		expect(db.query("SELECT count(*) AS count FROM runs").get()).toEqual({ count: 2 });
		expect(
			db.query("SELECT session_file_path FROM trace_session_links WHERE correlation_id = 'corr-hunter'").get(),
		).toEqual({
			session_file_path: path.join(acpxDir, "hunter.jsonl"),
		});
		expect(db.query("SELECT path FROM quarantine_session_files").all()).toEqual([
			{ path: path.join(piDir, "broken.jsonl") },
		]);
		expect(db.query("SELECT count(*) AS count FROM documents WHERE content_redacted IS NOT NULL").get()).toEqual({
			count: 0,
		});
		db.close();
	});

	test("re-ingesting an appended session replaces derived rows instead of duplicating them", async () => {
		const piDir = path.join(tempDir, "pi-sessions");
		const sessionPath = path.join(piDir, "vulkanus.jsonl");
		writeJsonl(sessionPath, [
			{
				type: "session_start",
				trace_id: "trace-vulkanus",
				correlation_id: "corr-vulkanus",
				session_id_hash: "sid-vulkanus",
				agent_name: "vulkanus",
				span_id: "run-vulkanus",
				started_at: "2026-05-25T00:00:00.000Z",
			},
			{ type: "final_answer", content: "first output" },
		]);
		await ingestTelemetry({ dbPath, piSessionDirs: [piDir], acpxSessionDirs: [] });

		writeJsonl(sessionPath, [
			{
				type: "session_start",
				trace_id: "trace-vulkanus",
				correlation_id: "corr-vulkanus",
				session_id_hash: "sid-vulkanus",
				agent_name: "vulkanus",
				span_id: "run-vulkanus",
				started_at: "2026-05-25T00:00:00.000Z",
			},
			{ type: "tool", content: "validation failed" },
			{ type: "final_answer", content: "second output" },
		]);
		await ingestTelemetry({ dbPath, piSessionDirs: [piDir], acpxSessionDirs: [] });

		const db = readDb(dbPath);
		expect(db.query("SELECT count(*) AS count FROM events WHERE run_id = 'run-vulkanus'").get()).toEqual({ count: 2 });
		expect(db.query("SELECT output_preview FROM runs WHERE run_id = 'run-vulkanus'").get()).toEqual({
			output_preview: "second output",
		});
		db.close();
	});

	test("defaults to home session directories and advisory lock skips concurrent auto-ingest", async () => {
		const homeDir = path.join(tempDir, "home");
		const piDir = path.join(homeDir, ".pi/agent/sessions");
		writeJsonl(path.join(piDir, "zeus.jsonl"), [
			{
				type: "session_start",
				trace_id: "trace-home",
				correlation_id: "corr-home",
				session_id_hash: "sid-home",
				agent_name: "zeus",
				span_id: "run-home",
				started_at: "2026-05-25T00:00:00.000Z",
			},
			{ type: "final_answer", content: "home session" },
		]);
		mkdirSync(path.join(homeDir, ".pantheon/telemetry"), { recursive: true });
		writeFileSync(path.join(homeDir, ".pantheon/telemetry/ingest.lock"), "busy");

		const locked = await telemetryMain(["runs", "--agent", "zeus", "--json"], {
			dbPath,
			homeDir,
		});
		expect(JSON.parse(locked).runs).toEqual([]);

		rmSync(path.join(homeDir, ".pantheon/telemetry/ingest.lock"));
		const unlocked = await telemetryMain(["runs", "--agent", "zeus", "--json"], {
			dbPath,
			homeDir,
		});
		expect(JSON.parse(unlocked).runs).toMatchObject([{ trace_id: "trace-home", agent_name: "zeus" }]);
	});

	test("ingest source flags include local and LangWatch fixture artifacts", async () => {
		const piDir = path.join(tempDir, "pi-sessions");
		const langwatchFixture = path.join(tempDir, "langwatch.json");
		writeJsonl(path.join(piDir, "local.jsonl"), [
			{
				type: "session_start",
				trace_id: "trace-local",
				correlation_id: "corr-local",
				session_id_hash: "sid-local",
				agent_name: "zeus",
				span_id: "run-local",
				started_at: "2026-05-25T00:00:00.000Z",
			},
		]);
		writeFileSync(
			langwatchFixture,
			JSON.stringify({
				spans: [
					{
						span_id: "run-langwatch",
						trace_id: "trace-langwatch",
						correlation_id: "corr-langwatch",
						session_id_hash: "sid-langwatch",
						agent_name: "oracle",
						agent_role: "consultant",
						started_at: "2026-05-25T00:03:00.000Z",
						status: "ok",
						output: "LangWatch fixture output",
					},
				],
			}),
		);

		await telemetryMain(["ingest", "--source", "langwatch", "--json"], {
			dbPath,
			piSessionDirs: [piDir],
			acpxSessionDirs: [],
			langWatchTraceFiles: [langwatchFixture],
		});
		let db = readDb(dbPath);
		expect(db.query("SELECT agent_name FROM runs WHERE trace_id = 'trace-langwatch'").get()).toEqual({
			agent_name: "oracle",
		});
		expect(db.query("SELECT count(*) AS count FROM runs WHERE trace_id = 'trace-local'").get()).toEqual({ count: 0 });
		db.close();

		await telemetryMain(["ingest", "--source", "local", "--json"], {
			dbPath,
			piSessionDirs: [piDir],
			acpxSessionDirs: [],
			langWatchTraceFiles: [langwatchFixture],
		});
		db = readDb(dbPath);
		expect(db.query("SELECT agent_name FROM runs WHERE trace_id = 'trace-local'").get()).toEqual({
			agent_name: "zeus",
		});
		db.close();
	});

	test("search --since filters content hits and similar returns deterministic related traces", async () => {
		const piDir = path.join(tempDir, "pi-sessions");
		writeJsonl(path.join(piDir, "current.jsonl"), [
			{
				type: "session_start",
				trace_id: "trace-current",
				correlation_id: "corr-current",
				session_id_hash: "sid-current",
				agent_name: "vulkanus",
				span_id: "run-current",
				started_at: new Date().toISOString(),
			},
			{ type: "final_answer", content: "validation failed because typecheck reported missing import" },
		]);
		writeJsonl(path.join(piDir, "related.jsonl"), [
			{
				type: "session_start",
				trace_id: "trace-related",
				correlation_id: "corr-related",
				session_id_hash: "sid-related",
				agent_name: "vulkanus",
				span_id: "run-related",
				started_at: new Date().toISOString(),
			},
			{ type: "final_answer", content: "typecheck validation failed due to missing import" },
		]);
		writeJsonl(path.join(piDir, "old.jsonl"), [
			{
				type: "session_start",
				trace_id: "trace-old",
				correlation_id: "corr-old",
				session_id_hash: "sid-old",
				agent_name: "oracle",
				span_id: "run-old",
				started_at: "2020-01-01T00:00:00.000Z",
			},
			{ type: "final_answer", content: "eventual consistency legacy note" },
		]);
		await ingestTelemetry({
			dbPath,
			piSessionDirs: [piDir],
			acpxSessionDirs: [],
			env: { PANTHEON_TELEMETRY_STORE_CONTENT: "true" },
		});

		const search = await telemetryMain(["search", "validation", "--since", "1d", "--json", "--no-ingest"], {
			dbPath,
			env: {},
		});
		expect(JSON.parse(search).content_storage_enabled).toBe(true);
		expect(
			JSON.parse(search)
				.results.map((row: { trace_id: string }) => row.trace_id)
				.sort(),
		).toEqual(["trace-current", "trace-related"]);

		const similar = await telemetryMain(
			["similar", "trace-current", "--agent", "vulkanus", "--top", "2", "--json", "--no-ingest"],
			{
				dbPath,
			},
		);
		expect(JSON.parse(similar)).toMatchObject({ available: true });
		expect(JSON.parse(similar).results.map((row: { trace_id: string }) => row.trace_id)).toContain("trace-related");
	});

	test("CLI read commands auto-ingest unless disabled and expose JSON contracts", async () => {
		const piDir = path.join(tempDir, "pi-sessions");
		writeJsonl(path.join(piDir, "oracle.jsonl"), [
			{
				type: "session_start",
				trace_id: "trace-oracle",
				correlation_id: "corr-oracle",
				session_id_hash: "sid-oracle",
				agent_name: "oracle",
				agent_role: "consultant",
				span_id: "run-oracle",
				status: "error",
				duration_ms: 1200,
				started_at: "2026-05-25T00:02:00.000Z",
			},
			{ type: "final_answer", content: "eventual consistency consultation" },
		]);

		const output = await telemetryMain(["runs", "--agent", "oracle", "--json"], {
			dbPath,
			piSessionDirs: [piDir],
			acpxSessionDirs: [],
		});
		expect(JSON.parse(output).runs).toMatchObject([
			{ trace_id: "trace-oracle", agent_name: "oracle", status: "error" },
		]);

		const sessionFile = await telemetryMain(
			["session-file", "--correlation-id", "corr-oracle", "--json", "--no-ingest"],
			{
				dbPath,
				piSessionDirs: [piDir],
				acpxSessionDirs: [],
			},
		);
		expect(JSON.parse(sessionFile).session_files).toEqual([path.join(piDir, "oracle.jsonl")]);

		const search = await telemetryMain(["search", "eventual consistency", "--agent", "oracle", "--json"], {
			dbPath,
			piSessionDirs: [piDir],
			acpxSessionDirs: [],
			env: { PANTHEON_TELEMETRY_STORE_CONTENT: "false" },
		});
		expect(JSON.parse(search)).toMatchObject({ content_storage_enabled: false, results: [] });
	});

	test("ingest links a session file from the extension canonical telemetry header shape", async () => {
		const piDir = path.join(tempDir, "pi-sessions");
		const sessionPath = path.join(piDir, "argus.jsonl");
		writeJsonl(sessionPath, [
			{ type: "pi_session_start", content: "local Pi session row without telemetry IDs" },
			{
				type: "pantheon_telemetry_header",
				event: "pantheon.telemetry.header",
				kind: "telemetry_metadata",
				schema_version: 1,
				trace_id: "trace-extension-header",
				correlation_id: "corr-extension-header",
				session_id_hash: "sid-extension-header",
				span_id: "span-extension-header",
				agent_name: "zeus",
				agent_role: "orchestrator",
				started_at: "2026-05-25T03:00:00.000Z",
			},
			{ type: "final_answer", content: "Argus reviewed the change" },
		]);

		const summary = await ingestTelemetry({ dbPath, piSessionDirs: [piDir], acpxSessionDirs: [] });
		expect(summary.sessionFiles.upserted).toBe(1);
		expect(summary.traceSessionLinks.upserted).toBe(1);

		const sessionFile = await telemetryMain(["session-file", "trace-extension-header", "--json", "--no-ingest"], {
			dbPath,
			piSessionDirs: [piDir],
			acpxSessionDirs: [],
		});
		expect(JSON.parse(sessionFile).session_files).toEqual([sessionPath]);
	});

	test("live LangWatch read API ingest POSTs JSON body with epoch-ms startDate/endDate, paginates via scrollId, and inserts API runs", async () => {
		const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
		const t1Started = recentLangWatchEpochMs(2);
		const t2Started = t1Started + 60 * 60 * 1000;
		const pageOne = {
			scrollId: "cursor-2",
			traces: [
				{
					trace_id: "trace-api-1",
					project_id: "project_test",
					metadata: {
						sdk_name: "pantheon-pi",
						"service.name": "pantheon-pi",
						correlation_id: "corr-api-1",
						session_id_hash: "sid-api-1",
						agent_name: "vulkanus",
						agent_role: "executor",
					},
					timestamps: { started_at: t1Started, inserted_at: t1Started, updated_at: t1Started + 1500 },
					input: { value: "validate the change" },
					output: { value: "api page one final output" },
					metrics: { total_time_ms: 1500 },
					error: { has_error: false, message: null },
				},
			],
		};
		const pageTwo = {
			scrollId: null,
			traces: [
				{
					trace_id: "trace-api-2",
					project_id: "project_test",
					metadata: {
						sdk_name: "pantheon-pi",
						correlation_id: "corr-api-2",
						session_id_hash: "sid-api-2",
						agent_name: "oracle",
					},
					timestamps: { started_at: t2Started, inserted_at: t2Started, updated_at: t2Started + 2200 },
					output: { value: "api page two final output" },
					metrics: { total_time_ms: 2200 },
					error: { has_error: true, message: "consult failed" },
				},
			],
		};

		globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const headerSnapshot: Record<string, string> = {};
			const rawHeaders = init?.headers ?? {};
			if (rawHeaders instanceof Headers) {
				rawHeaders.forEach((v, k) => {
					headerSnapshot[k.toLowerCase()] = v;
				});
			} else for (const [k, v] of Object.entries(rawHeaders)) headerSnapshot[k.toLowerCase()] = String(v);
			calls.push({
				url,
				method: (init?.method ?? "GET").toUpperCase(),
				headers: headerSnapshot,
				body: typeof init?.body === "string" ? init.body : "",
			});
			const body = calls.length === 1 ? pageOne : pageTwo;
			return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
		}) as typeof fetch;

		const beforeMs = Date.now();
		const summary = await ingestTelemetry({
			dbPath,
			source: "langwatch",
			since: "24h",
			piSessionDirs: [],
			acpxSessionDirs: [],
			env: { LANGWATCH_API_KEY: "test-live-key", LANGWATCH_ENDPOINT: "https://app.langwatch.ai" },
		});
		const afterMs = Date.now();

		expect(calls.length).toBe(2);
		for (const call of calls) {
			expect(call.method).toBe("POST");
			expect(call.url).toContain("/api/traces/search");
			expect(call.url).not.toContain("?");
			expect(call.headers["x-auth-token"]).toBe("test-live-key");
			expect(call.headers["content-type"]).toContain("application/json");
			expect(call.body.includes("test-live-key")).toBe(false);
			const parsed = JSON.parse(call.body) as Record<string, unknown>;
			expect(typeof parsed.pageSize).toBe("number");
			expect(parsed.pageSize as number).toBeLessThanOrEqual(1000);
			expect(typeof parsed.startDate).toBe("number");
			expect(typeof parsed.endDate).toBe("number");
			expect(parsed.startDate as number).toBeLessThan(parsed.endDate as number);
			expect(parsed.startDate as number).toBeGreaterThanOrEqual(beforeMs - 24 * 60 * 60 * 1000 - 1000);
			expect(parsed.endDate as number).toBeLessThanOrEqual(afterMs + 1000);
		}
		const firstBody = JSON.parse(calls[0].body) as Record<string, unknown>;
		const secondBody = JSON.parse(calls[1].body) as Record<string, unknown>;
		expect(firstBody.scrollId).toBeUndefined();
		expect(secondBody.scrollId).toBe("cursor-2");

		expect(summary.langwatch.scanned).toBe(2);
		expect(summary.langwatch.upserted).toBe(2);
		expect(summary.runs.upserted).toBe(2);

		const db = readDb(dbPath);
		const rows = db
			.query<
				{ trace_id: string; agent_name: string; status: string; started_at: string; duration_ms: number | null },
				[]
			>("SELECT trace_id, agent_name, status, started_at, duration_ms FROM runs ORDER BY trace_id")
			.all();
		expect(rows).toEqual([
			{
				trace_id: "trace-api-1",
				agent_name: "vulkanus",
				status: "ok",
				started_at: new Date(t1Started).toISOString(),
				duration_ms: 1500,
			},
			{
				trace_id: "trace-api-2",
				agent_name: "oracle",
				status: "error",
				started_at: new Date(t2Started).toISOString(),
				duration_ms: 2200,
			},
		]);
		const previews = db
			.query<{ output_preview: string | null }, []>("SELECT output_preview FROM runs ORDER BY trace_id")
			.all();
		expect(previews[0].output_preview).toContain("api page one final output");
		expect(previews[1].output_preview).toContain("api page two final output");
		db.close();
	});

	test("live LangWatch detail enrichment fills agent_name/role/status from spans when trace metadata lacks pantheon.*", async () => {
		const tStarted = recentLangWatchEpochMs();
		const tFinished = tStarted + 1234;
		const searchTraces = [
			{
				trace_id: "trace-needs-detail",
				project_id: "project_test",
				metadata: {
					sdk_name: "pantheon-pi",
					"service.name": "pantheon-pi",
					"langwatch.origin": "sdk",
				},
				timestamps: { started_at: tStarted, inserted_at: tStarted, updated_at: tFinished },
				input: { value: "do a vulkanus thing" },
				spans: [],
			},
		];
		const traceDetail = {
			trace_id: "trace-needs-detail",
			project_id: "project_test",
			metadata: {
				sdk_name: "pantheon-pi",
				"service.name": "pantheon-pi",
				"langwatch.origin": "sdk",
			},
			timestamps: { started_at: tStarted, inserted_at: tStarted, updated_at: tFinished },
			spans: [
				{
					span_id: "root-span-1",
					parent_id: null,
					trace_id: "trace-needs-detail",
					type: "tool",
					name: "pantheon.acpx.run",
					timestamps: { started_at: tStarted, finished_at: tFinished, first_token_at: null },
					error: { has_error: false, message: null, stacktrace: [] },
					input: { type: "text", value: "do a vulkanus thing" },
					output: { type: "text", value: "vulkanus completed the work" },
					params: {
						langwatch: { span: { type: "tool" }, input: "do a vulkanus thing", output: "vulkanus completed" },
						pantheon: {
							agent: "vulkanus",
							agent_role: "executor",
							run_type: "session",
							event: "acpx_run",
							run: { success: "true", exit_code: "0" },
						},
						gen_ai: { operation: "tool.call" },
					},
				},
				{
					span_id: "child-span-1",
					parent_id: "root-span-1",
					trace_id: "trace-needs-detail",
					type: "span",
					name: "pantheon.acpx.event.client",
					timestamps: { started_at: tStarted + 100, finished_at: tStarted + 500, first_token_at: null },
					params: { pantheon: { event: "client" } },
				},
			],
		};

		const recorded: Array<{ url: string; method: string }> = [];
		globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const method = (init?.method ?? "GET").toUpperCase();
			recorded.push({ url, method });
			if (method === "POST" && url.includes("/api/traces/search")) {
				return new Response(JSON.stringify({ scrollId: null, traces: searchTraces }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (method === "GET" && url.includes("/api/traces/trace-needs-detail")) {
				const headerSnapshot: Record<string, string> = {};
				const raw = init?.headers ?? {};
				if (raw instanceof Headers) {
					raw.forEach((v, k) => {
						headerSnapshot[k.toLowerCase()] = v;
					});
				} else for (const [k, v] of Object.entries(raw)) headerSnapshot[k.toLowerCase()] = String(v);
				expect(headerSnapshot["x-auth-token"]).toBe("detail-key");
				return new Response(JSON.stringify(traceDetail), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;

		const summary = await ingestTelemetry({
			dbPath,
			source: "langwatch",
			since: "24h",
			piSessionDirs: [],
			acpxSessionDirs: [],
			env: { LANGWATCH_API_KEY: "detail-key", LANGWATCH_ENDPOINT: "https://app.langwatch.ai" },
		});

		expect(summary.warnings).toEqual([]);
		expect(summary.runs.upserted).toBe(1);
		expect(recorded.some((c) => c.method === "POST" && c.url.includes("/api/traces/search"))).toBe(true);
		expect(recorded.some((c) => c.method === "GET" && c.url.endsWith("/api/traces/trace-needs-detail"))).toBe(true);

		const db = readDb(dbPath);
		const runRow = db
			.query<
				{
					trace_id: string;
					agent_name: string;
					agent_role: string;
					status: string;
					started_at: string;
					duration_ms: number | null;
					output_preview: string | null;
					metadata_json: string;
				},
				[]
			>(
				"SELECT trace_id, agent_name, agent_role, status, started_at, duration_ms, output_preview, metadata_json FROM runs",
			)
			.get();
		expect(runRow).toMatchObject({
			trace_id: "trace-needs-detail",
			agent_name: "vulkanus",
			agent_role: "executor",
			status: "ok",
			started_at: new Date(tStarted).toISOString(),
			duration_ms: 1234,
		});
		expect(runRow?.output_preview).toContain("vulkanus completed the work");
		const metadata = JSON.parse(runRow?.metadata_json ?? "{}") as Record<string, unknown>;
		expect(metadata.detail_enriched).toBe(true);

		const spanRows = db
			.query<{ span_id: string; parent_span_id: string | null; name: string | null; trace_id: string }, []>(
				"SELECT span_id, parent_span_id, name, trace_id FROM spans ORDER BY span_id",
			)
			.all();
		expect(spanRows).toEqual([
			{
				span_id: "child-span-1",
				parent_span_id: "root-span-1",
				name: "pantheon.acpx.event.client",
				trace_id: "trace-needs-detail",
			},
			{
				span_id: "root-span-1",
				parent_span_id: null,
				name: "pantheon.acpx.run",
				trace_id: "trace-needs-detail",
			},
		]);
		db.close();
	});

	test("LangWatch detail ingest materializes delegated pantheon.acpx.run child spans as runs", async () => {
		const tStarted = recentLangWatchEpochMs();
		const tFinished = tStarted + 2500;
		const traceDetail = {
			trace_id: "trace-delegated",
			metadata: { sdk_name: "pantheon-pi" },
			spans: [
				{
					span_id: "root-zeus-span",
					parent_id: null,
					trace_id: "trace-delegated",
					name: "pantheon.pi.run",
					timestamps: { started_at: tStarted, finished_at: tFinished },
					error: { has_error: false },
					params: {
						pantheon: {
							agent: "zeus",
							correlation_id: "corr-delegated",
							session_id: { hash: "sid-delegated" },
						},
					},
				},
				{
					span_id: "argus-child-span",
					parent_id: "root-zeus-span",
					trace_id: "trace-delegated",
					name: "pantheon.acpx.run",
					timestamps: { started_at: tStarted + 100, finished_at: tFinished - 100 },
					error: { has_error: false },
					output: { type: "text", value: "Argus reviewed the diff" },
					params: {
						pantheon: {
							agent: "argus",
							run_type: "exec",
							correlation_id: "corr-delegated",
							session_id: { hash: "sid-delegated" },
							run: { duration_ms: "2300", success: "true" },
						},
					},
				},
			],
		};

		globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const method = (init?.method ?? "GET").toUpperCase();
			if (method === "POST" && url.includes("/api/traces/search")) {
				return new Response(
					JSON.stringify({
						scrollId: null,
						traces: [
							{
								trace_id: "trace-delegated",
								metadata: { sdk_name: "pantheon-pi" },
								timestamps: { started_at: tStarted, inserted_at: tStarted, updated_at: tFinished },
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			if (method === "GET" && url.endsWith("/api/traces/trace-delegated")) {
				return new Response(JSON.stringify(traceDetail), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;

		const first = await ingestTelemetry({
			dbPath,
			source: "langwatch",
			since: "24h",
			piSessionDirs: [],
			acpxSessionDirs: [],
			env: { LANGWATCH_API_KEY: "detail-key", LANGWATCH_ENDPOINT: "https://app.langwatch.ai" },
		});
		const second = await ingestTelemetry({
			dbPath,
			source: "langwatch",
			since: "24h",
			piSessionDirs: [],
			acpxSessionDirs: [],
			env: { LANGWATCH_API_KEY: "detail-key", LANGWATCH_ENDPOINT: "https://app.langwatch.ai" },
		});

		expect(first.runs.upserted).toBe(2);
		expect(second.runs.upserted).toBe(2);

		const db = readDb(dbPath);
		expect(db.query("SELECT count(*) AS count FROM runs").get()).toEqual({ count: 2 });
		expect(db.query("SELECT count(*) AS count FROM spans").get()).toEqual({ count: 2 });
		const argusRun = db
			.query<
				{
					run_id: string;
					trace_id: string;
					parent_run_id: string | null;
					correlation_id: string;
					session_id_hash: string;
					agent_name: string;
					agent_role: string;
					status: string;
					duration_ms: number | null;
					output_preview: string | null;
				},
				[]
			>(
				"SELECT run_id, trace_id, parent_run_id, correlation_id, session_id_hash, agent_name, agent_role, status, duration_ms, output_preview FROM runs WHERE run_id = 'argus-child-span'",
			)
			.get();
		expect(argusRun).toMatchObject({
			run_id: "argus-child-span",
			trace_id: "trace-delegated",
			parent_run_id: "root-zeus-span",
			correlation_id: "corr-delegated",
			session_id_hash: "sid-delegated",
			agent_name: "argus",
			agent_role: "reviewer",
			status: "ok",
			duration_ms: 2300,
		});
		expect(argusRun?.output_preview).toContain("Argus reviewed the diff");
		db.close();
	});

	test("live LangWatch detail fetch failures are warnings; ingest still upserts the run with fallback agent_name=unknown", async () => {
		const tStarted = recentLangWatchEpochMs();
		globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const method = (init?.method ?? "GET").toUpperCase();
			if (method === "POST" && url.includes("/api/traces/search")) {
				return new Response(
					JSON.stringify({
						scrollId: null,
						traces: [
							{
								trace_id: "trace-detail-fails",
								metadata: { sdk_name: "pantheon-pi" },
								timestamps: { started_at: tStarted, inserted_at: tStarted, updated_at: tStarted + 500 },
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response("oops", { status: 502 });
		}) as typeof fetch;

		const summary = await ingestTelemetry({
			dbPath,
			source: "langwatch",
			since: "24h",
			piSessionDirs: [],
			acpxSessionDirs: [],
			env: { LANGWATCH_API_KEY: "x-key", LANGWATCH_ENDPOINT: "https://app.langwatch.ai" },
		});
		expect(summary.warnings.some((w) => w.includes("trace detail returned status 502"))).toBe(true);
		expect(summary.warnings.some((w) => w.includes("x-key"))).toBe(false);
		expect(summary.runs.upserted).toBe(1);

		const db = readDb(dbPath);
		const row = db
			.query<{ agent_name: string }, []>("SELECT agent_name FROM runs WHERE trace_id = 'trace-detail-fails'")
			.get();
		expect(row?.agent_name).toBe("unknown");
		db.close();
	});

	test("PANTHEON_LANGWATCH_SKIP_TRACE_DETAIL=true disables detail enrichment", async () => {
		const tStarted = recentLangWatchEpochMs();
		const calls: Array<{ url: string; method: string }> = [];
		globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const method = (init?.method ?? "GET").toUpperCase();
			calls.push({ url, method });
			if (method === "POST" && url.includes("/api/traces/search")) {
				return new Response(
					JSON.stringify({
						scrollId: null,
						traces: [
							{
								trace_id: "trace-skip",
								metadata: { sdk_name: "pantheon-pi" },
								timestamps: { started_at: tStarted, inserted_at: tStarted, updated_at: tStarted + 100 },
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response("unexpected", { status: 599 });
		}) as typeof fetch;

		const summary = await ingestTelemetry({
			dbPath,
			source: "langwatch",
			since: "24h",
			piSessionDirs: [],
			acpxSessionDirs: [],
			env: {
				LANGWATCH_API_KEY: "skip-key",
				LANGWATCH_ENDPOINT: "https://app.langwatch.ai",
				PANTHEON_LANGWATCH_SKIP_TRACE_DETAIL: "true",
			},
		});
		expect(summary.runs.upserted).toBe(1);
		expect(calls.every((c) => c.method !== "GET")).toBe(true);
	});

	test("LangWatch live API failures are warnings; file-backed ingest still works and warning fires when nothing configured", async () => {
		const langwatchFixture = path.join(tempDir, "langwatch-file.json");
		writeFileSync(
			langwatchFixture,
			JSON.stringify({
				spans: [
					{
						span_id: "run-file",
						trace_id: "trace-file",
						correlation_id: "corr-file",
						session_id_hash: "sid-file",
						agent_name: "argus",
						started_at: "2026-05-25T03:00:00.000Z",
					},
				],
			}),
		);

		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return new Response("nope", { status: 500 });
		}) as typeof fetch;

		const withKey = await ingestTelemetry({
			dbPath,
			source: "langwatch",
			piSessionDirs: [],
			acpxSessionDirs: [],
			langWatchTraceFiles: [langwatchFixture],
			env: { LANGWATCH_API_KEY: "test-live-key" },
		});
		expect(calls).toBe(1);
		expect(withKey.warnings.some((w) => w.includes("status 500"))).toBe(true);
		expect(withKey.warnings.some((w) => w.includes("test-live-key"))).toBe(false);
		expect(withKey.langwatch.upserted).toBe(1);
		const db = readDb(dbPath);
		expect(db.query("SELECT agent_name FROM runs WHERE trace_id = 'trace-file'").get()).toEqual({
			agent_name: "argus",
		});
		db.close();

		const dbPath2 = path.join(tempDir, "telemetry2.db");
		const without = await ingestTelemetry({
			dbPath: dbPath2,
			source: "langwatch",
			piSessionDirs: [],
			acpxSessionDirs: [],
			langWatchTraceFiles: [],
			env: {},
		});
		expect(without.warnings.some((w) => w.includes("LANGWATCH_API_KEY"))).toBe(true);
	});
});
