import { existsSync } from "node:fs";
import { cosineSimilarity } from "../embed/index.ts";
import { type IngestOptions, ingestTelemetry } from "../ingest/index.ts";
import { defaultTelemetryDbPath, sinceIso } from "../shared/index.ts";
import { openTelemetryStore } from "../store/index.ts";

export interface TelemetryCliOptions extends IngestOptions {
	stdout?: (text: string) => void;
}

type ParsedArgs = { command: string; positional: string[]; flags: Record<string, string | boolean> };

const READ_COMMANDS = new Set(["runs", "slow", "trace", "session-file", "search", "similar"]);
const BOOLEAN_FLAGS = new Set(["json", "no-ingest"]);

function parseArgs(args: string[]): ParsedArgs {
	const [command = "help", ...rest] = args;
	const positional: string[] = [];
	const flags: Record<string, string | boolean> = {};
	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index];
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const key = arg.slice(2);
		if (BOOLEAN_FLAGS.has(key)) {
			flags[key] = true;
			continue;
		}
		const next = rest[index + 1];
		if (!next || next.startsWith("--")) throw new Error(`--${key} requires a value`);
		flags[key] = next;
		index++;
	}
	return { command, positional, flags };
}

function asString(value: unknown) {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown, fallback: number) {
	const text = asString(value);
	return text && /^\d+$/.test(text) ? Number(text) : fallback;
}

function jsonOut(value: unknown) {
	return `${JSON.stringify(value, null, 2)}\n`;
}

export function telemetryUsage() {
	return [
		"Usage:",
		"  pantheon telemetry ingest [--since <duration>] [--source langwatch|local|all] [--json]",
		"  pantheon telemetry runs [--agent <name>] [--role <role>] [--status <status>] [--limit N] [--json --no-ingest]",
		"  pantheon telemetry trace <trace_id> [--json --no-ingest]",
		"  pantheon telemetry session-file <trace_id|--correlation-id <id>|--session-id-hash <hash>] [--json --no-ingest]",
		'  pantheon telemetry search "<query>" [--agent <name>] [--json --no-ingest]',
		"  pantheon telemetry slow [--agent <name>] [--role <role>] [--since <duration>] [--top N] [--json --no-ingest]",
		"",
		"Commands:",
		"  ingest        Populate ~/.pantheon/telemetry.db from LangWatch and/or local session files",
		"  runs          List filtered agent runs",
		"  trace         Reconstruct one trace from the local index",
		"  session-file  Resolve a trace/correlation/session hash to local JSONL paths",
		"  search        Full-text search indexed run content",
		"  similar       Semantic neighbors for a run_id, trace_id, or document_id when embeddings exist",
		"  slow          Show slowest runs",
		"  stats         Show local index counts and cursors",
		"",
		"Fast trace proof:",
		"  pantheon telemetry ingest --source langwatch --since 2h --json",
		"  pantheon telemetry trace <trace_id> --json --no-ingest",
		'  pantheon telemetry search "<marker>" --json --no-ingest',
	].join("\n");
}

function table(rows: Record<string, unknown>[], columns: string[]) {
	if (rows.length === 0) return "No rows\n";
	const widths = columns.map((column) =>
		Math.max(column.length, ...rows.map((row) => String(row[column] ?? "").length)),
	);
	const header = columns.map((column, index) => column.padEnd(widths[index])).join("  ");
	const body = rows.map((row) =>
		columns.map((column, index) => String(row[column] ?? "").padEnd(widths[index])).join("  "),
	);
	return `${[header, "-".repeat(header.length), ...body].join("\n")}\n`;
}

function ingestOptionsFromFlags(parsed: ParsedArgs, options: TelemetryCliOptions): TelemetryCliOptions {
	const source = asString(parsed.flags.source);
	return {
		...options,
		source: source === "local" || source === "langwatch" || source === "all" ? source : options.source,
		since: asString(parsed.flags.since) ?? options.since,
	};
}

async function maybeIngest(parsed: ParsedArgs, options: TelemetryCliOptions) {
	if (!READ_COMMANDS.has(parsed.command) || parsed.flags["no-ingest"]) return undefined;
	return await ingestTelemetry(ingestOptionsFromFlags(parsed, options));
}

function queryRuns(parsed: ParsedArgs, options: TelemetryCliOptions) {
	const store = openTelemetryStore({ dbPath: options.dbPath });
	const where: string[] = [];
	const params: Record<string, string | number> = {};
	for (const [flag, column] of [
		["agent", "agent_name"],
		["role", "agent_role"],
		["status", "status"],
	]) {
		const value = asString(parsed.flags[flag]);
		if (value) {
			where.push(`${column} = $${flag}`);
			params[`$${flag}`] = value;
		}
	}
	const since = sinceIso(asString(parsed.flags.since));
	if (since) {
		where.push("started_at >= $since");
		params.$since = since;
	}
	params.$limit = asNumber(parsed.flags.limit, 20);
	const sql = `SELECT run_id, trace_id, agent_name, agent_role, status, duration_ms, started_at, output_preview FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at DESC LIMIT $limit`;
	const runs = store.db.query(sql).all(params) as Record<string, unknown>[];
	store.close();
	return runs;
}

function querySlow(parsed: ParsedArgs, options: TelemetryCliOptions) {
	const store = openTelemetryStore({ dbPath: options.dbPath });
	const where = ["duration_ms IS NOT NULL"];
	const params: Record<string, string | number> = { $limit: asNumber(parsed.flags.top, 10) };
	const agent = asString(parsed.flags.agent);
	const role = asString(parsed.flags.role);
	const since = sinceIso(asString(parsed.flags.since));
	if (agent) {
		where.push("agent_name = $agent");
		params.$agent = agent;
	}
	if (role) {
		where.push("agent_role = $role");
		params.$role = role;
	}
	if (since) {
		where.push("started_at >= $since");
		params.$since = since;
	}
	const runs = store.db
		.query(
			`SELECT run_id, trace_id, agent_name, agent_role, duration_ms, status, started_at FROM runs WHERE ${where.join(" AND ")} ORDER BY duration_ms DESC LIMIT $limit`,
		)
		.all(params) as Record<string, unknown>[];
	store.close();
	return runs;
}

function querySessionFile(parsed: ParsedArgs, options: TelemetryCliOptions) {
	const store = openTelemetryStore({ dbPath: options.dbPath });
	const params: Record<string, string> = {};
	const traceId = parsed.positional[0];
	const corr = asString(parsed.flags["correlation-id"]);
	const sid = asString(parsed.flags["session-id-hash"]);
	const where: string[] = [];
	if (traceId) {
		where.push("trace_id = $trace_id");
		params.$trace_id = traceId;
	}
	if (corr) {
		where.push("correlation_id = $correlation_id");
		params.$correlation_id = corr;
	}
	if (sid) {
		where.push("session_id_hash = $session_id_hash");
		params.$session_id_hash = sid;
	}
	if (where.length === 0) throw new Error("session-file requires a trace_id, --correlation-id, or --session-id-hash");
	const rows = store.db
		.query(`SELECT session_file_path FROM trace_session_links WHERE ${where.join(" AND ")} ORDER BY session_file_path`)
		.all(params) as Array<{ session_file_path: string }>;
	store.close();
	return rows.map((row) => row.session_file_path);
}

function queryTrace(parsed: ParsedArgs, options: TelemetryCliOptions) {
	const traceId = parsed.positional[0];
	if (!traceId) throw new Error("trace requires trace_id");
	const store = openTelemetryStore({ dbPath: options.dbPath });
	const runs = store.db.query("SELECT * FROM runs WHERE trace_id = ? ORDER BY started_at").all(traceId);
	const spans = store.db.query("SELECT * FROM spans WHERE trace_id = ? ORDER BY started_at").all(traceId);
	const session_files = store.db
		.query("SELECT session_file_path FROM trace_session_links WHERE trace_id = ? ORDER BY session_file_path")
		.all(traceId);
	store.close();
	return { trace_id: traceId, runs, spans, session_files };
}

function querySearch(parsed: ParsedArgs, options: TelemetryCliOptions) {
	const query = parsed.positional.join(" ").trim();
	if (!query) throw new Error("search requires a query string");
	const store = openTelemetryStore({ dbPath: options.dbPath });
	const indexed = store.db
		.query<{ present: number }, []>("SELECT 1 AS present FROM documents WHERE content_redacted IS NOT NULL LIMIT 1")
		.get();
	if (!indexed) {
		store.close();
		return { content_storage_enabled: false, message: "content index empty", results: [] };
	}
	const params: Record<string, string | number> = { $query: query, $limit: asNumber(parsed.flags.limit, 20) };
	const filters: string[] = [];
	const agent = asString(parsed.flags.agent);
	const role = asString(parsed.flags.role);
	if (agent) {
		filters.push("r.agent_name = $agent");
		params.$agent = agent;
	}
	if (role) {
		filters.push("r.agent_role = $role");
		params.$role = role;
	}
	const since = sinceIso(asString(parsed.flags.since));
	if (since) {
		filters.push("r.started_at >= $since");
		params.$since = since;
	}
	const results = store.db
		.query(`SELECT d.document_id, d.run_id, d.trace_id, d.agent_name, d.kind, snippet(documents_fts, 0, '[', ']', '…', 12) AS snippet
			FROM documents_fts f JOIN documents d ON d.document_id = f.rowid JOIN runs r ON r.run_id = d.run_id
			WHERE documents_fts MATCH $query ${filters.length ? `AND ${filters.join(" AND ")}` : ""} LIMIT $limit`)
		.all(params);
	store.close();
	return { content_storage_enabled: true, results };
}

function parseVector(value: unknown) {
	if (typeof value !== "string") return undefined;
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) && parsed.every((item) => typeof item === "number") ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function querySimilar(parsed: ParsedArgs, options: TelemetryCliOptions) {
	const anchor = parsed.positional[0];
	if (!anchor) throw new Error("similar requires a run_id, trace_id, or document_id anchor");
	const store = openTelemetryStore({ dbPath: options.dbPath });
	const anchorRow = /^\d+$/.test(anchor)
		? store.db
				.query<{ document_id: number; trace_id: string; embedding: string }, [number]>(
					"SELECT d.document_id, d.trace_id, e.embedding FROM documents d JOIN embeddings e ON e.document_id = d.document_id WHERE d.document_id = ?",
				)
				.get(Number(anchor))
		: store.db
				.query<{ document_id: number; trace_id: string; embedding: string }, [string, string]>(
					`SELECT d.document_id, d.trace_id, e.embedding
					 FROM documents d JOIN embeddings e ON e.document_id = d.document_id
					 WHERE d.trace_id = ? OR d.run_id = ?
					 ORDER BY CASE d.kind WHEN 'final_answer' THEN 0 WHEN 'output' THEN 1 ELSE 2 END, d.document_id
					 LIMIT 1`,
				)
				.get(anchor, anchor);
	const anchorVector = parseVector(anchorRow?.embedding);
	if (!anchorRow || !anchorVector) {
		store.close();
		return { available: true, anchor, results: [], message: "anchor has no embedded document" };
	}
	const params: Record<string, string | number> = {};
	const filters: string[] = ["e.embedding IS NOT NULL"];
	const agent = asString(parsed.flags.agent);
	const role = asString(parsed.flags.role);
	if (agent) {
		filters.push("r.agent_name = $agent");
		params.$agent = agent;
	}
	if (role) {
		filters.push("r.agent_role = $role");
		params.$role = role;
	}
	const rows = store.db
		.query(`SELECT d.document_id, d.run_id, d.trace_id, d.agent_name, d.kind, d.content_redacted, e.embedding
			FROM documents d JOIN embeddings e ON e.document_id = d.document_id JOIN runs r ON r.run_id = d.run_id
			WHERE ${filters.join(" AND ")}`)
		.all(params) as Array<Record<string, unknown>>;
	store.close();
	const byTrace = new Map<string, Record<string, unknown> & { score: number }>();
	for (const row of rows) {
		const vector = parseVector(row.embedding);
		const traceId = typeof row.trace_id === "string" ? row.trace_id : undefined;
		if (!vector || !traceId || traceId === anchorRow.trace_id) continue;
		const score = cosineSimilarity(anchorVector, vector);
		const existing = byTrace.get(traceId);
		if (!existing || score > existing.score) byTrace.set(traceId, { ...row, score });
	}
	const results = [...byTrace.values()]
		.sort((left, right) => right.score - left.score)
		.slice(0, asNumber(parsed.flags.top, 5))
		.map(({ embedding: _embedding, content_redacted: _content, ...row }) => row);
	return { available: true, anchor, results };
}

function stats(options: TelemetryCliOptions) {
	const dbPath = options.dbPath ?? defaultTelemetryDbPath(options.env ?? process.env);
	const store = openTelemetryStore({ dbPath });
	const tables = ["runs", "spans", "events", "documents", "session_files", "trace_session_links", "ingest_cursors"];
	const counts = Object.fromEntries(
		tables.map((name) => [
			name,
			(store.db.query(`SELECT count(*) AS count FROM ${name}`).get() as { count: number }).count,
		]),
	);
	const quarantine = (
		store.db.query("SELECT count(*) AS count FROM quarantine_session_files").get() as { count: number }
	).count;
	const cursors = store.db.query("SELECT * FROM ingest_cursors ORDER BY source").all();
	store.close();
	return { db_path: dbPath, exists: existsSync(dbPath), counts, quarantine, cursors };
}

function purge(traceId: string | undefined, options: TelemetryCliOptions) {
	if (!traceId) throw new Error("purge requires trace_id");
	const store = openTelemetryStore({ dbPath: options.dbPath });
	const db = store.db;
	const runIds = db
		.query<{ run_id: string }, [string]>("SELECT run_id FROM runs WHERE trace_id = ?")
		.all(traceId)
		.map((row) => row.run_id);
	const tx = db.transaction(() => {
		for (const runId of runIds) db.query("DELETE FROM run_tags WHERE run_id = ?").run(runId);
		db.query("DELETE FROM events WHERE trace_id = ?").run(traceId);
		db.query("DELETE FROM documents WHERE trace_id = ?").run(traceId);
		db.exec("INSERT INTO documents_fts(documents_fts) VALUES('rebuild')");
		db.query("DELETE FROM spans WHERE trace_id = ?").run(traceId);
		db.query("DELETE FROM trace_session_links WHERE trace_id = ?").run(traceId);
		db.query("DELETE FROM session_files WHERE trace_id = ?").run(traceId);
		db.query("DELETE FROM runs WHERE trace_id = ?").run(traceId);
	});
	tx();
	store.close();
	return { trace_id: traceId, purged: true };
}

function vacuum(options: TelemetryCliOptions) {
	const store = openTelemetryStore({ dbPath: options.dbPath });
	store.db.exec("INSERT INTO documents_fts(documents_fts) VALUES('optimize'); VACUUM;");
	store.close();
	return { vacuumed: true };
}

export async function telemetryMain(args: string[], options: TelemetryCliOptions = {}) {
	const parsed = parseArgs(args);
	await maybeIngest(parsed, options);
	const json = Boolean(parsed.flags.json);
	let payload: unknown;
	let human = "";

	if (parsed.command === "help" || parsed.command === "--help" || parsed.command === "-h")
		return `${telemetryUsage()}\n`;
	if (parsed.command === "ingest") payload = await ingestTelemetry(ingestOptionsFromFlags(parsed, options));
	else if (parsed.command === "runs") {
		const runs = queryRuns(parsed, options);
		payload = { runs };
		human = table(runs, ["started_at", "agent_name", "status", "duration_ms", "trace_id", "output_preview"]);
	} else if (parsed.command === "slow") {
		const runs = querySlow(parsed, options);
		payload = { runs };
		human = table(runs, ["duration_ms", "agent_name", "status", "trace_id"]);
	} else if (parsed.command === "trace") payload = queryTrace(parsed, options);
	else if (parsed.command === "session-file") {
		const session_files = querySessionFile(parsed, options);
		payload = { session_files };
		human = `${session_files.join("\n")}\n`;
	} else if (parsed.command === "search") payload = querySearch(parsed, options);
	else if (parsed.command === "similar") payload = querySimilar(parsed, options);
	else if (parsed.command === "stats") payload = stats(options);
	else if (parsed.command === "purge") payload = purge(parsed.positional[0], options);
	else if (parsed.command === "vacuum") payload = vacuum(options);
	else if (["vulkanus", "oracle", "argus"].includes(parsed.command) && parsed.positional[0] === "latest") {
		parsed.flags.agent = parsed.command;
		parsed.flags.limit = parsed.flags.limit ?? "5";
		const runs = queryRuns({ ...parsed, command: "runs" }, options);
		payload = { runs };
		human = table(runs, ["started_at", "agent_name", "status", "duration_ms", "trace_id", "output_preview"]);
	} else if (parsed.command === "hunters" && parsed.positional[0] === "slow") {
		parsed.flags.role = "hunter";
		const runs = querySlow({ ...parsed, command: "slow" }, options);
		payload = { runs };
		human = table(runs, ["duration_ms", "agent_name", "status", "trace_id"]);
	} else {
		payload = {
			commands: ["ingest", "runs", "slow", "trace", "session-file", "search", "similar", "stats", "purge", "vacuum"],
		};
	}

	const output = json ? jsonOut(payload) : human || jsonOut(payload);
	options.stdout?.(output);
	return output;
}

export async function runTelemetryCli(argv = process.argv.slice(2)) {
	const args = argv[0] === "telemetry" ? argv.slice(1) : argv;
	try {
		process.stdout.write(await telemetryMain(args));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
