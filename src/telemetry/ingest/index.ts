import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { embedDeterministic } from "../embed/index.ts";
import {
	defaultAcpxSessionDir,
	defaultPiSessionDir,
	defaultTelemetryLockPath,
	isContentStorageEnabled,
	nowIso,
	previewForTelemetry,
	redactForTelemetry,
	sha256,
	sinceIso,
} from "../shared/index.ts";
import { openTelemetryStore } from "../store/index.ts";

export type TelemetryIngestSource = "all" | "local" | "langwatch";

export interface IngestOptions {
	dbPath?: string;
	homeDir?: string;
	piSessionDirs?: string[];
	acpxSessionDirs?: string[];
	langWatchTraceFiles?: string[];
	source?: TelemetryIngestSource;
	since?: string;
	lockPath?: string;
	skipLock?: boolean;
	env?: Record<string, string | undefined>;
}

export interface IngestSummary {
	skipped?: boolean;
	skipReason?: string;
	sessionFiles: { scanned: number; upserted: number; quarantined: number };
	langwatch: { scanned: number; upserted: number };
	traceSessionLinks: { upserted: number };
	runs: { upserted: number };
	documents: { upserted: number };
	warnings: string[];
}

type JsonRecord = Record<string, unknown>;

function stringField(record: JsonRecord | undefined, keys: string[]) {
	if (!record) return undefined;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	for (const nestedKey of ["attributes", "trace", "pantheon", "metadata"]) {
		const nested = record[nestedKey];
		if (typeof nested === "object" && nested !== null) {
			const value = stringField(nested as JsonRecord, keys);
			if (value) return value;
		}
	}
	return undefined;
}

function numberField(record: JsonRecord | undefined, keys: string[]) {
	if (!record) return undefined;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number") return value;
		if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
	}
	const attributes = record.attributes;
	if (typeof attributes === "object" && attributes !== null) return numberField(attributes as JsonRecord, keys);
	return undefined;
}

function listFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) return listFiles(fullPath);
		return entry.isFile() && entry.name.endsWith(".jsonl") ? [fullPath] : [];
	});
}

function parseJsonl(filePath: string) {
	return readFileSync(filePath, "utf8")
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as JsonRecord);
}

function inferRole(agentName: string | undefined) {
	if (!agentName) return "unknown";
	if (agentName === "athena") return "primary-builder-orchestrator";
	if (agentName === "zeus") return "orchestrator";
	if (agentName === "prometheus") return "planner";
	if (agentName === "mnemosyne") return "librarian";
	if (agentName === "vulkanus") return "executor";
	if (agentName === "oracle") return "consultant";
	if (agentName === "argus") return "reviewer";
	if (agentName.startsWith("hunter-")) return "hunter";
	return "utility";
}

function contentFrom(row: JsonRecord) {
	for (const key of ["content", "message", "text", "output", "final_answer", "line"]) {
		const value = row[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function kindFrom(row: JsonRecord) {
	return stringField(row, ["kind", "type", "event"]) ?? "transcript_chunk";
}

function runIdFor(header: JsonRecord, filePath: string) {
	return stringField(header, ["run_id", "span_id", "pantheon.span_id"]) ?? sha256(filePath).slice(0, 32);
}

function detectExistingSessionFile(
	db: ReturnType<typeof openTelemetryStore>["db"],
	filePath: string,
	fileHash: string,
) {
	return (
		db
			.query<{ content_sha256: string }, [string]>("SELECT content_sha256 FROM session_files WHERE path = ?")
			.get(filePath)?.content_sha256 === fileHash
	);
}

function emptySummary(): IngestSummary {
	return {
		sessionFiles: { scanned: 0, upserted: 0, quarantined: 0 },
		langwatch: { scanned: 0, upserted: 0 },
		traceSessionLinks: { upserted: 0 },
		runs: { upserted: 0 },
		documents: { upserted: 0 },
		warnings: [],
	};
}

function acquireLock(lockPath: string) {
	mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
	try {
		const fd = openSync(lockPath, "wx");
		return () => {
			closeSync(fd);
			try {
				unlinkSync(lockPath);
			} catch {
				// best-effort cleanup
			}
		};
	} catch (error) {
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		if (code === "EEXIST") return undefined;
		throw error;
	}
}

function shouldIncludeStartedAt(startedAt: string, since: string | undefined) {
	const sinceDate = sinceIso(since);
	return !sinceDate || startedAt >= sinceDate;
}

function normalizeSource(source: TelemetryIngestSource | undefined) {
	return source ?? "all";
}

function readJsonRecords(filePath: string) {
	const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
	if (Array.isArray(parsed)) return parsed as JsonRecord[];
	if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { spans?: unknown }).spans)) {
		return (parsed as { spans: JsonRecord[] }).spans;
	}
	return [parsed as JsonRecord];
}

const LANGWATCH_DEFAULT_ENDPOINT = "https://app.langwatch.ai";
const LANGWATCH_DEFAULT_PAGE_SIZE = 100;
const LANGWATCH_MAX_PAGES = 50;
const LANGWATCH_DEFAULT_SINCE_MS = 7 * 24 * 60 * 60 * 1000;

function sinceEpochMs(duration: string | undefined): number {
	if (!duration) return Date.now() - LANGWATCH_DEFAULT_SINCE_MS;
	const match = duration.match(/^(\d+)([hdm])$/);
	if (!match) return Date.now() - LANGWATCH_DEFAULT_SINCE_MS;
	const amount = Number(match[1]);
	const unit = match[2];
	const millis =
		unit === "h" ? amount * 60 * 60 * 1000 : unit === "d" ? amount * 24 * 60 * 60 * 1000 : amount * 60 * 1000;
	return Date.now() - millis;
}

function extractTracesFromResponse(payload: unknown): JsonRecord[] {
	if (payload == null || typeof payload !== "object") return [];
	const root = payload as JsonRecord;
	for (const key of ["traces", "data", "results", "items"]) {
		const value = root[key];
		if (Array.isArray(value)) return value as JsonRecord[];
	}
	const groups = root.groups;
	if (Array.isArray(groups)) {
		return groups.flatMap((group) => {
			if (group == null || typeof group !== "object") return [];
			const groupTraces = (group as JsonRecord).traces;
			return Array.isArray(groupTraces) ? (groupTraces as JsonRecord[]) : [];
		});
	}
	return [];
}

function extractScrollId(payload: unknown): string | undefined {
	if (payload == null || typeof payload !== "object") return undefined;
	const root = payload as JsonRecord;
	for (const key of ["scrollId", "scroll_id", "next_scroll_id", "nextScrollId"]) {
		const value = root[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	const pagination = root.pagination;
	if (pagination && typeof pagination === "object" && !Array.isArray(pagination)) {
		for (const key of ["scrollId", "scroll_id"]) {
			const value = (pagination as JsonRecord)[key];
			if (typeof value === "string" && value.length > 0) return value;
		}
	}
	return undefined;
}

export interface LangWatchApiPage {
	traces: JsonRecord[];
	scrollId?: string;
}

const LANGWATCH_DEFAULT_DETAIL_CONCURRENCY = 8;

export async function fetchLangWatchTraceDetail(params: {
	apiKey: string;
	endpoint: string;
	traceId: string;
	fetchImpl?: typeof fetch;
}): Promise<{ detail?: JsonRecord; warning?: string }> {
	const fetchImpl = params.fetchImpl ?? globalThis.fetch;
	const url = `${params.endpoint.replace(/\/+$/, "")}/api/traces/${encodeURIComponent(params.traceId)}`;
	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "GET",
			headers: { "X-Auth-Token": params.apiKey, Accept: "application/json" },
		});
	} catch (error) {
		return {
			warning: `langwatch trace detail fetch failed for ${params.traceId}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
	if (!response.ok) {
		return { warning: `langwatch trace detail returned status ${response.status} for ${params.traceId}` };
	}
	try {
		const payload = (await response.json()) as JsonRecord;
		return { detail: payload };
	} catch (error) {
		return {
			warning: `langwatch trace detail response was not JSON for ${params.traceId}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
}

interface DetailDerived {
	agentName?: string;
	agentRole?: string;
	runType?: string;
	status?: string;
	startedAt?: string;
	endedAt?: string;
	durationMs?: number;
	output?: string;
}

function valueAtPath(record: JsonRecord | undefined, key: string): unknown {
	if (!record) return undefined;
	if (key in record) return record[key];
	let cursor: unknown = record;
	for (const part of key.split(".")) {
		if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
		cursor = (cursor as JsonRecord)[part];
	}
	return cursor;
}

function stringAtPath(record: JsonRecord | undefined, keys: string[]) {
	for (const key of keys) {
		const value = valueAtPath(record, key);
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function numberAtPath(record: JsonRecord | undefined, keys: string[]) {
	for (const key of keys) {
		const value = valueAtPath(record, key);
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
	}
	return undefined;
}

function spanPantheon(span: JsonRecord): JsonRecord | undefined {
	const params = span.params;
	const pantheon =
		params && typeof params === "object" && !Array.isArray(params) ? (params as JsonRecord).pantheon : undefined;
	if (pantheon && typeof pantheon === "object" && !Array.isArray(pantheon)) return pantheon as JsonRecord;
	const direct = span.pantheon;
	if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct as JsonRecord;
	return undefined;
}

function spanPantheonString(span: JsonRecord, keys: string[]) {
	const params =
		span.params && typeof span.params === "object" && !Array.isArray(span.params)
			? (span.params as JsonRecord)
			: undefined;
	const pantheon = spanPantheon(span);
	return (
		stringAtPath(pantheon, keys) ??
		stringAtPath(
			params,
			keys.map((key) => `pantheon.${key}`),
		) ??
		stringAtPath(
			span,
			keys.map((key) => `pantheon.${key}`),
		) ??
		stringAtPath(params, keys) ??
		stringAtPath(span, keys)
	);
}

function spanPantheonNumber(span: JsonRecord, keys: string[]) {
	const params =
		span.params && typeof span.params === "object" && !Array.isArray(span.params)
			? (span.params as JsonRecord)
			: undefined;
	const pantheon = spanPantheon(span);
	return (
		numberAtPath(pantheon, keys) ??
		numberAtPath(
			params,
			keys.map((key) => `pantheon.${key}`),
		) ??
		numberAtPath(
			span,
			keys.map((key) => `pantheon.${key}`),
		) ??
		numberAtPath(params, keys) ??
		numberAtPath(span, keys)
	);
}

function outputFromLangWatchSpan(span: JsonRecord) {
	const output = span.output;
	if (typeof output === "string" && output.length > 0) return output;
	if (output && typeof output === "object" && !Array.isArray(output)) {
		const value = (output as JsonRecord).value;
		if (typeof value === "string" && value.length > 0) return value;
	}
	const params = span.params;
	if (params && typeof params === "object" && !Array.isArray(params)) {
		const value = stringAtPath(params as JsonRecord, ["langwatch.output", "output", "final_answer"]);
		if (value) return value;
	}
	return undefined;
}

function timestampsFromSpan(span: JsonRecord, fallbackStartedAt?: string) {
	const timestamps = span.timestamps;
	const t =
		timestamps && typeof timestamps === "object" && !Array.isArray(timestamps) ? (timestamps as JsonRecord) : undefined;
	const startedAt =
		toIsoTimestamp(t?.started_at) ?? stringField(span, ["started_at", "start_time"]) ?? fallbackStartedAt;
	const endedAt = toIsoTimestamp(t?.finished_at ?? t?.ended_at) ?? stringField(span, ["ended_at", "end_time"]);
	let durationMs: number | undefined;
	if (
		t &&
		typeof t.started_at === "number" &&
		typeof t.finished_at === "number" &&
		Number.isFinite(t.started_at) &&
		Number.isFinite(t.finished_at)
	) {
		const spanDuration = t.finished_at - t.started_at;
		if (spanDuration >= 0) durationMs = spanDuration;
	}
	return { startedAt, endedAt, durationMs };
}

function statusFromLangWatchSpan(span: JsonRecord) {
	const explicit = stringField(span, ["status"]);
	if (explicit) return explicit;
	const error = span.error;
	if (error && typeof error === "object" && !Array.isArray(error)) {
		const hasError = (error as JsonRecord).has_error;
		if (hasError === true) return "error";
		if (hasError === false) return "ok";
	}
	const success = spanPantheonString(span, ["run.success", "success"]);
	if (success === "true") return "ok";
	if (success === "false") return "error";
	return undefined;
}

function deriveFromDetail(detail: JsonRecord): { rootDerived: DetailDerived; spans: JsonRecord[] } {
	const rawSpans = Array.isArray(detail.spans) ? (detail.spans as JsonRecord[]) : [];
	const root = rawSpans.find((s) => (s as JsonRecord).parent_id == null) ?? rawSpans[0];
	const derived: DetailDerived = {};
	if (root) {
		derived.agentName = spanPantheonString(root, ["agent", "agent_name"]);
		derived.agentRole = spanPantheonString(root, ["agent_role", "role"]);
		derived.runType = spanPantheonString(root, ["run_type"]);
		const timestamps = timestampsFromSpan(root);
		derived.startedAt = timestamps.startedAt;
		derived.endedAt = timestamps.endedAt;
		derived.durationMs = spanPantheonNumber(root, ["run.duration_ms", "duration_ms"]) ?? timestamps.durationMs;
		derived.status = statusFromLangWatchSpan(root);
		derived.output = outputFromLangWatchSpan(root);
	}
	return { rootDerived: derived, spans: rawSpans };
}

async function fetchTraceDetailsParallel(args: {
	apiKey: string;
	endpoint: string;
	traceIds: string[];
	concurrency: number;
	fetchImpl?: typeof fetch;
}): Promise<{ details: Map<string, JsonRecord>; warnings: string[] }> {
	const details = new Map<string, JsonRecord>();
	const warnings: string[] = [];
	let cursor = 0;
	const concurrency = Math.max(1, Math.min(args.concurrency, args.traceIds.length || 1));
	const workers = Array.from({ length: concurrency }, async () => {
		while (true) {
			const i = cursor++;
			if (i >= args.traceIds.length) return;
			const traceId = args.traceIds[i];
			const { detail, warning } = await fetchLangWatchTraceDetail({
				apiKey: args.apiKey,
				endpoint: args.endpoint,
				traceId,
				fetchImpl: args.fetchImpl,
			});
			if (warning) warnings.push(warning);
			if (detail) details.set(traceId, detail);
		}
	});
	await Promise.all(workers);
	return { details, warnings };
}

export async function fetchLangWatchTracePages(params: {
	apiKey: string;
	endpoint: string;
	startDate: number;
	endDate: number;
	pageSize?: number;
	fetchImpl?: typeof fetch;
}): Promise<{ pages: LangWatchApiPage[]; warnings: string[] }> {
	const fetchImpl = params.fetchImpl ?? globalThis.fetch;
	const pageSize = Math.min(params.pageSize ?? LANGWATCH_DEFAULT_PAGE_SIZE, 1000);
	const url = `${params.endpoint.replace(/\/+$/, "")}/api/traces/search`;
	const pages: LangWatchApiPage[] = [];
	const warnings: string[] = [];
	let scrollId: string | undefined;
	for (let iteration = 0; iteration < LANGWATCH_MAX_PAGES; iteration++) {
		const body: Record<string, unknown> = {
			pageSize,
			startDate: params.startDate,
			endDate: params.endDate,
		};
		if (scrollId) body.scrollId = scrollId;
		let response: Response;
		try {
			response = await fetchImpl(url, {
				method: "POST",
				headers: {
					"X-Auth-Token": params.apiKey,
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify(body),
			});
		} catch (error) {
			warnings.push(`langwatch trace fetch failed: ${error instanceof Error ? error.message : String(error)}`);
			break;
		}
		if (!response.ok) {
			warnings.push(`langwatch trace fetch returned status ${response.status}`);
			break;
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch (error) {
			warnings.push(`langwatch trace response was not JSON: ${error instanceof Error ? error.message : String(error)}`);
			break;
		}
		const traces = extractTracesFromResponse(payload);
		const nextScrollId = extractScrollId(payload);
		pages.push({ traces, scrollId: nextScrollId });
		if (!nextScrollId || traces.length === 0) break;
		scrollId = nextScrollId;
	}
	return { pages, warnings };
}

function toIsoTimestamp(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
	if (typeof value === "string" && value.length > 0) {
		if (/^\d+$/.test(value)) return new Date(Number(value)).toISOString();
		return value;
	}
	return undefined;
}

function flattenLangWatchTrace(trace: JsonRecord): JsonRecord {
	const flat: JsonRecord = { ...trace };
	for (const key of ["metadata", "attributes", "pantheon"]) {
		const nested = trace[key];
		if (nested && typeof nested === "object" && !Array.isArray(nested)) {
			for (const [k, v] of Object.entries(nested as JsonRecord)) {
				if (!(k in flat)) flat[k] = v;
				if (v && typeof v === "object" && !Array.isArray(v)) {
					for (const [k2, v2] of Object.entries(v as JsonRecord)) {
						const composite = `${k}.${k2}`;
						if (!(composite in flat)) flat[composite] = v2;
					}
				}
			}
		}
	}
	const timestamps = trace.timestamps;
	if (timestamps && typeof timestamps === "object") {
		const t = timestamps as JsonRecord;
		if (!flat.started_at) flat.started_at = toIsoTimestamp(t.started_at) ?? toIsoTimestamp(t.inserted_at);
		if (!flat.ended_at) flat.ended_at = toIsoTimestamp(t.ended_at) ?? toIsoTimestamp(t.updated_at);
	}
	const metrics = trace.metrics;
	if (metrics && typeof metrics === "object") {
		const m = metrics as JsonRecord;
		if (flat.duration_ms === undefined && typeof m.total_time_ms === "number") {
			flat.duration_ms = m.total_time_ms;
		}
	}
	const input = trace.input;
	if (input && typeof input === "object" && !Array.isArray(input)) {
		const value = (input as JsonRecord).value;
		if (typeof value === "string" && typeof flat.input !== "string") flat.input = value;
	}
	const output = trace.output;
	if (output && typeof output === "object" && !Array.isArray(output)) {
		const value = (output as JsonRecord).value;
		if (typeof value === "string" && typeof flat.output !== "string") flat.output = value;
	}
	const error = trace.error;
	if (error && typeof error === "object" && !Array.isArray(error)) {
		const e = error as JsonRecord;
		if (typeof flat.status !== "string") {
			if (e.has_error === true) flat.status = "error";
			else if (e.has_error === false) flat.status = "ok";
		}
	}
	return flat;
}

export async function ingestTelemetry(options: IngestOptions = {}): Promise<IngestSummary> {
	const env = options.env ?? process.env;
	const homeDir = options.homeDir ?? env.HOME ?? os.homedir();
	const lockPath = options.lockPath ?? defaultTelemetryLockPath(env, homeDir);
	const releaseLock = options.skipLock ? () => undefined : acquireLock(lockPath);
	if (!releaseLock) return { ...emptySummary(), skipped: true, skipReason: "ingest lock held" };
	try {
		return await ingestTelemetryUnlocked(options);
	} finally {
		releaseLock();
	}
}

async function ingestTelemetryUnlocked(options: IngestOptions = {}): Promise<IngestSummary> {
	const env = options.env ?? process.env;
	const store = openTelemetryStore({ dbPath: options.dbPath });
	const { db } = store;
	const contentEnabled = isContentStorageEnabled(env);
	const summary = emptySummary();
	const homeDir = options.homeDir ?? env.HOME ?? os.homedir();
	const sourceFilter = normalizeSource(options.source);
	const sources =
		sourceFilter === "langwatch"
			? []
			: [
					...(options.piSessionDirs ?? [defaultPiSessionDir(homeDir)]).map((dir) => ({
						dir,
						kind: "pi_agent",
					})),
					...(options.acpxSessionDirs ?? [defaultAcpxSessionDir(homeDir)]).map((dir) => ({ dir, kind: "acpx" })),
				];

	const insertSession =
		db.query(`INSERT INTO session_files(path, kind, trace_id, correlation_id, session_id_hash, span_id, agent_name, started_at, bytes, mtime, content_sha256)
		VALUES($path, $kind, $trace_id, $correlation_id, $session_id_hash, $span_id, $agent_name, $started_at, $bytes, $mtime, $content_sha256)
		ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, trace_id = excluded.trace_id, correlation_id = excluded.correlation_id,
		session_id_hash = excluded.session_id_hash, span_id = excluded.span_id, agent_name = excluded.agent_name, started_at = excluded.started_at,
		bytes = excluded.bytes, mtime = excluded.mtime, content_sha256 = excluded.content_sha256`);
	const insertRun =
		db.query(`INSERT INTO runs(run_id, trace_id, parent_run_id, correlation_id, session_id_hash, agent_name, agent_role, orchestrator, source, started_at, ended_at, duration_ms, status, turn_count, tool_event_count, output_hash, output_preview, metadata_json)
		VALUES($run_id, $trace_id, $parent_run_id, $correlation_id, $session_id_hash, $agent_name, $agent_role, $orchestrator, 'local_jsonl', $started_at, $ended_at, $duration_ms, $status, $turn_count, $tool_event_count, $output_hash, $output_preview, $metadata_json)
		ON CONFLICT(run_id) DO UPDATE SET trace_id = excluded.trace_id, parent_run_id = excluded.parent_run_id, correlation_id = excluded.correlation_id,
		session_id_hash = excluded.session_id_hash, agent_name = excluded.agent_name, agent_role = excluded.agent_role, orchestrator = excluded.orchestrator,
		started_at = excluded.started_at, ended_at = excluded.ended_at, duration_ms = excluded.duration_ms, status = excluded.status,
		turn_count = excluded.turn_count, tool_event_count = excluded.tool_event_count, output_hash = excluded.output_hash,
		output_preview = excluded.output_preview, metadata_json = excluded.metadata_json`);
	const insertSpan =
		db.query(`INSERT OR IGNORE INTO spans(span_id, trace_id, parent_span_id, name, kind, started_at, ended_at, attributes_json)
		VALUES($span_id, $trace_id, $parent_span_id, $name, 'local_jsonl', $started_at, $ended_at, $attributes_json)`);
	const insertEvent = db.query(
		`INSERT INTO events(run_id, trace_id, kind, at, payload_hash, payload_preview) VALUES($run_id, $trace_id, $kind, $at, $payload_hash, $payload_preview)`,
	);
	const insertDocument =
		db.query(`INSERT INTO documents(run_id, trace_id, agent_name, kind, started_at, offset_bytes, length_bytes, content_sha256, content_redacted)
		VALUES($run_id, $trace_id, $agent_name, $kind, $started_at, $offset_bytes, $length_bytes, $content_sha256, $content_redacted)`);
	const insertFts = db.query("INSERT INTO documents_fts(rowid, content_redacted) VALUES(?, ?)");
	const insertEmbedding = db.query(
		"INSERT OR REPLACE INTO embeddings(document_id, embedding, provider) VALUES(?, ?, ?)",
	);
	const insertLink =
		db.query(`INSERT OR IGNORE INTO trace_session_links(trace_id, correlation_id, session_id_hash, session_file_path)
		VALUES($trace_id, $correlation_id, $session_id_hash, $session_file_path)`);
	const selectDocumentIdsForRun = db.query<{ document_id: number }, [string]>(
		"SELECT document_id FROM documents WHERE run_id = ?",
	);
	const deleteEmbeddingForDocument = db.query("DELETE FROM embeddings WHERE document_id = ?");
	const deleteEventsForRun = db.query("DELETE FROM events WHERE run_id = ?");
	const deleteDocumentsForRun = db.query("DELETE FROM documents WHERE run_id = ?");

	function upsertLangWatchDocuments(args: {
		runId: string;
		traceId: string;
		agentName: string | null;
		startedAt: string;
		input?: string;
		output?: string;
	}): number {
		for (const { document_id } of selectDocumentIdsForRun.all(args.runId)) {
			deleteEmbeddingForDocument.run(document_id);
		}
		deleteEventsForRun.run(args.runId);
		deleteDocumentsForRun.run(args.runId);
		let offset = 0;
		let inserted = 0;
		const pairs: Array<{ kind: string; content: string }> = [];
		if (args.input && args.input.trim().length > 0) pairs.push({ kind: "input", content: args.input });
		if (args.output && args.output.trim().length > 0) pairs.push({ kind: "final_answer", content: args.output });
		for (const { kind, content } of pairs) {
			const redacted = redactForTelemetry(content);
			const result = insertDocument.run({
				$run_id: args.runId,
				$trace_id: args.traceId,
				$agent_name: args.agentName,
				$kind: kind,
				$started_at: args.startedAt,
				$offset_bytes: offset,
				$length_bytes: Buffer.byteLength(content),
				$content_sha256: sha256(redacted),
				$content_redacted: contentEnabled ? redacted : null,
			});
			if (contentEnabled) {
				insertFts.run(result.lastInsertRowid, redacted);
				insertEmbedding.run(
					result.lastInsertRowid,
					JSON.stringify(embedDeterministic(redacted)),
					"deterministic-token-hash",
				);
			}
			offset += Buffer.byteLength(content);
			inserted++;
		}
		return inserted;
	}

	const apiTraces: Array<{ trace: JsonRecord; source: string }> = [];
	const apiWarnings: string[] = [];
	if (sourceFilter !== "local" && env.LANGWATCH_API_KEY) {
		const endpoint = env.LANGWATCH_ENDPOINT ?? LANGWATCH_DEFAULT_ENDPOINT;
		const startDate = sinceEpochMs(options.since);
		const endDate = Date.now();
		const { pages, warnings: fetchWarnings } = await fetchLangWatchTracePages({
			apiKey: env.LANGWATCH_API_KEY,
			endpoint,
			startDate,
			endDate,
		});
		apiWarnings.push(...fetchWarnings);
		for (const page of pages) for (const trace of page.traces) apiTraces.push({ trace, source: "langwatch_api" });
	}

	const apiTraceDetails = new Map<string, JsonRecord>();
	if (
		sourceFilter !== "local" &&
		env.LANGWATCH_API_KEY &&
		env.PANTHEON_LANGWATCH_SKIP_TRACE_DETAIL !== "true" &&
		apiTraces.length > 0
	) {
		const detailEndpoint = env.LANGWATCH_ENDPOINT ?? LANGWATCH_DEFAULT_ENDPOINT;
		const requestedConcurrency = Number(
			env.PANTHEON_LANGWATCH_DETAIL_CONCURRENCY ?? LANGWATCH_DEFAULT_DETAIL_CONCURRENCY,
		);
		const concurrency =
			Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
				? requestedConcurrency
				: LANGWATCH_DEFAULT_DETAIL_CONCURRENCY;
		const needDetail: string[] = [];
		for (const { trace } of apiTraces) {
			const flat = flattenLangWatchTrace(trace);
			const traceId = stringField(flat, ["trace_id", "traceId", "pantheon.trace_id"]);
			if (!traceId) continue;
			const agentName = stringField(flat, ["agent_name", "agent", "pantheon.agent", "pantheon.agent_name"]);
			if (!agentName) needDetail.push(traceId);
		}
		if (needDetail.length > 0) {
			const { details, warnings: detailWarnings } = await fetchTraceDetailsParallel({
				apiKey: env.LANGWATCH_API_KEY,
				endpoint: detailEndpoint,
				traceIds: needDetail,
				concurrency,
			});
			apiWarnings.push(...detailWarnings);
			for (const [traceId, detail] of details) apiTraceDetails.set(traceId, detail);
		}
	}

	const ingestBatch = db.transaction(() => {
		summary.warnings.push(...apiWarnings);
		if (sourceFilter !== "local") {
			const langWatchTraceFiles =
				options.langWatchTraceFiles ?? env.PANTHEON_LANGWATCH_TRACE_FILES?.split(path.delimiter).filter(Boolean) ?? [];
			if (
				sourceFilter === "langwatch" &&
				langWatchTraceFiles.length === 0 &&
				apiTraces.length === 0 &&
				!env.LANGWATCH_API_KEY
			) {
				summary.warnings.push(
					"LangWatch ingest skipped: set LANGWATCH_API_KEY for live read API ingestion or PANTHEON_LANGWATCH_TRACE_FILES for file-backed exports.",
				);
			}
			for (const { trace, source } of apiTraces) {
				const span = flattenLangWatchTrace(trace);
				summary.langwatch.scanned++;
				const traceId = stringField(span, ["trace_id", "traceId", "pantheon.trace_id"]);
				if (!traceId) continue;
				const detail = apiTraceDetails.get(traceId);
				const detailDerivation = detail ? deriveFromDetail(detail) : undefined;
				const derived = detailDerivation?.rootDerived;
				if (derived) {
					if (
						derived.agentName &&
						!stringField(span, ["agent_name", "agent", "pantheon.agent", "pantheon.agent_name"])
					) {
						span.agent_name = derived.agentName;
					}
					if (derived.agentRole && !stringField(span, ["agent_role", "role", "pantheon.agent_role"])) {
						span.agent_role = derived.agentRole;
					}
					if (derived.runType && !stringField(span, ["run_type", "pantheon.run_type"])) {
						span.run_type = derived.runType;
					}
					if (derived.status && typeof span.status !== "string") span.status = derived.status;
					if (derived.startedAt && typeof span.started_at !== "string") span.started_at = derived.startedAt;
					if (derived.endedAt && typeof span.ended_at !== "string") span.ended_at = derived.endedAt;
					if (
						derived.durationMs != null &&
						(typeof span.duration_ms !== "number" || !Number.isFinite(span.duration_ms))
					) {
						span.duration_ms = derived.durationMs;
					}
					if (derived.output && typeof span.output !== "string") span.output = derived.output;
				}
				const detailRootSpan = detailDerivation?.spans.find((s) => (s as JsonRecord).parent_id == null);
				const correlationId =
					stringField(span, ["correlation_id", "pantheon.correlation_id"]) ??
					(detailRootSpan ? spanPantheonString(detailRootSpan, ["correlation_id"]) : undefined) ??
					`langwatch-${traceId}`;
				const sessionIdHash =
					stringField(span, ["session_id_hash", "session_hash", "pantheon.session_id.hash"]) ??
					(detailRootSpan ? spanPantheonString(detailRootSpan, ["session_id.hash", "session_id_hash"]) : undefined) ??
					sha256(traceId);
				const agentName = stringField(span, ["agent_name", "agent", "pantheon.agent", "pantheon.agent_name"]);
				const startedAt = stringField(span, ["started_at", "start_time", "timestamp", "time"]) ?? nowIso();
				if (!shouldIncludeStartedAt(startedAt, options.since)) continue;
				const runId =
					stringField(span, ["run_id", "span_id", "spanId", "pantheon.span_id"]) ??
					sha256(JSON.stringify(span)).slice(0, 32);
				const output = contentFrom(span);
				insertRun.run({
					$run_id: runId,
					$trace_id: traceId,
					$parent_run_id: stringField(span, ["parent_run_id", "parent_span_id", "pantheon.parent_span_id"]) ?? null,
					$correlation_id: correlationId,
					$session_id_hash: sessionIdHash,
					$agent_name: agentName ?? "unknown",
					$agent_role: stringField(span, ["agent_role", "role", "pantheon.agent_role"]) ?? inferRole(agentName),
					$orchestrator: stringField(span, ["orchestrator"]) ?? null,
					$started_at: startedAt,
					$ended_at: stringField(span, ["ended_at", "end_time"]) ?? null,
					$duration_ms: numberField(span, ["duration_ms", "pantheon.run.duration_ms"]) ?? null,
					$status: stringField(span, ["status"]) ?? "unknown",
					$turn_count: numberField(span, ["turn_count", "pantheon.turn_count"]) ?? null,
					$tool_event_count: numberField(span, ["tool_event_count", "pantheon.tool_event_count"]) ?? null,
					$output_hash: output ? sha256(redactForTelemetry(output)) : null,
					$output_preview: output ? previewForTelemetry(output) : null,
					$metadata_json: JSON.stringify({
						langwatch_source: source,
						detail_enriched: detail !== undefined,
					}),
				});
				const detailChildren = detailDerivation?.spans ?? [];
				if (detailChildren.length > 0) {
					for (const child of detailChildren) {
						const childSpanId = stringField(child, ["span_id"]);
						if (!childSpanId) continue;
						const childTimestamps = (child as JsonRecord).timestamps as JsonRecord | undefined;
						const childStartedAt = toIsoTimestamp(childTimestamps?.started_at) ?? startedAt;
						const childEndedAt =
							toIsoTimestamp(childTimestamps?.finished_at) ?? toIsoTimestamp(childTimestamps?.ended_at) ?? null;
						const childParentId =
							stringField(child, ["parent_id", "parent_span_id"]) ?? spanPantheonString(child, ["parent_span_id"]);
						const childName = stringField(child, ["name"]) ?? "langwatch";
						insertSpan.run({
							$span_id: childSpanId,
							$trace_id: traceId,
							$parent_span_id: childParentId ?? null,
							$name: childName,
							$started_at: childStartedAt,
							$ended_at: childEndedAt,
							$attributes_json: JSON.stringify(child),
						});
						const childAgentName =
							spanPantheonString(child, ["agent", "agent_name"]) ?? stringField(child, ["agent_name", "agent"]);
						if (childParentId && childName === "pantheon.acpx.run" && childAgentName) {
							const childOutput = outputFromLangWatchSpan(child);
							insertRun.run({
								$run_id: childSpanId,
								$trace_id: traceId,
								$parent_run_id: childParentId,
								$correlation_id: spanPantheonString(child, ["correlation_id"]) ?? correlationId,
								$session_id_hash: spanPantheonString(child, ["session_id.hash", "session_id_hash"]) ?? sessionIdHash,
								$agent_name: childAgentName,
								$agent_role: spanPantheonString(child, ["agent_role", "role"]) ?? inferRole(childAgentName),
								$orchestrator: stringField(span, ["orchestrator"]) ?? null,
								$started_at: childStartedAt,
								$ended_at: childEndedAt,
								$duration_ms:
									spanPantheonNumber(child, ["run.duration_ms", "duration_ms"]) ??
									timestampsFromSpan(child).durationMs ??
									null,
								$status: statusFromLangWatchSpan(child) ?? "unknown",
								$turn_count: spanPantheonNumber(child, ["turn_count"]) ?? null,
								$tool_event_count: spanPantheonNumber(child, ["tool_event_count"]) ?? null,
								$output_hash: childOutput ? sha256(redactForTelemetry(childOutput)) : null,
								$output_preview: childOutput ? previewForTelemetry(childOutput) : null,
								$metadata_json: JSON.stringify({
									langwatch_source: source,
									detail_enriched: true,
									materialized_from_span: true,
								}),
							});
							summary.runs.upserted++;
						}
					}
				} else {
					insertSpan.run({
						$span_id: runId,
						$trace_id: traceId,
						$parent_span_id: stringField(span, ["parent_span_id", "pantheon.parent_span_id"]) ?? null,
						$name: agentName ?? "langwatch",
						$started_at: startedAt,
						$ended_at: stringField(span, ["ended_at", "end_time"]) ?? null,
						$attributes_json: JSON.stringify(span),
					});
				}
				const apiInput = stringField(span, ["input", "prompt"]);
				const apiOutput = output ?? derived?.output;
				summary.documents.upserted += upsertLangWatchDocuments({
					runId,
					traceId,
					agentName: agentName ?? null,
					startedAt,
					input: apiInput,
					output: apiOutput,
				});
				summary.runs.upserted++;
				summary.langwatch.upserted++;
			}
			for (const filePath of langWatchTraceFiles) {
				for (const rawSpan of readJsonRecords(filePath)) {
					const span = flattenLangWatchTrace(rawSpan);
					summary.langwatch.scanned++;
					const traceId = stringField(span, ["trace_id", "traceId", "pantheon.trace_id"]);
					const correlationId = stringField(span, ["correlation_id", "pantheon.correlation_id"]);
					const sessionIdHash = stringField(span, ["session_id_hash", "session_hash", "pantheon.session_id.hash"]);
					const agentName = stringField(span, ["agent_name", "agent", "pantheon.agent", "pantheon.agent_name"]);
					const startedAt = stringField(span, ["started_at", "start_time", "timestamp", "time"]) ?? nowIso();
					if (!traceId || !correlationId || !sessionIdHash || !shouldIncludeStartedAt(startedAt, options.since))
						continue;
					const runId =
						stringField(span, ["run_id", "span_id", "spanId", "pantheon.span_id"]) ??
						sha256(JSON.stringify(span)).slice(0, 32);
					const output = contentFrom(span);
					insertRun.run({
						$run_id: runId,
						$trace_id: traceId,
						$parent_run_id: stringField(span, ["parent_run_id", "parent_span_id", "pantheon.parent_span_id"]) ?? null,
						$correlation_id: correlationId,
						$session_id_hash: sessionIdHash,
						$agent_name: agentName ?? "unknown",
						$agent_role: stringField(span, ["agent_role", "role", "pantheon.agent_role"]) ?? inferRole(agentName),
						$orchestrator: stringField(span, ["orchestrator"]) ?? null,
						$started_at: startedAt,
						$ended_at: stringField(span, ["ended_at", "end_time"]) ?? null,
						$duration_ms: numberField(span, ["duration_ms", "pantheon.run.duration_ms"]) ?? null,
						$status: stringField(span, ["status"]) ?? "unknown",
						$turn_count: numberField(span, ["turn_count", "pantheon.turn_count"]) ?? null,
						$tool_event_count: numberField(span, ["tool_event_count", "pantheon.tool_event_count"]) ?? null,
						$output_hash: output ? sha256(redactForTelemetry(output)) : null,
						$output_preview: output ? previewForTelemetry(output) : null,
						$metadata_json: JSON.stringify({ langwatch_trace_file: filePath }),
					});
					insertSpan.run({
						$span_id: runId,
						$trace_id: traceId,
						$parent_span_id: stringField(span, ["parent_span_id", "pantheon.parent_span_id"]) ?? null,
						$name: agentName ?? "langwatch",
						$started_at: startedAt,
						$ended_at: stringField(span, ["ended_at", "end_time"]) ?? null,
						$attributes_json: JSON.stringify(span),
					});
					const fileInput = stringField(span, ["input", "prompt"]);
					summary.documents.upserted += upsertLangWatchDocuments({
						runId,
						traceId,
						agentName: agentName ?? null,
						startedAt,
						input: fileInput,
						output,
					});
					summary.runs.upserted++;
					summary.langwatch.upserted++;
				}
			}
		}
		for (const source of sources) {
			for (const filePath of listFiles(source.dir)) {
				summary.sessionFiles.scanned++;
				const raw = readFileSync(filePath);
				const fileHash = sha256(raw);
				if (detectExistingSessionFile(db, filePath, fileHash)) continue;
				let rows: JsonRecord[] = [];
				try {
					rows = parseJsonl(filePath);
				} catch (error) {
					summary.warnings.push(
						`failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
					);
					continue;
				}
				const header =
					rows.find(
						(row) =>
							stringField(row, ["trace_id", "pantheon.trace_id"]) ||
							stringField(row, ["correlation_id", "pantheon.correlation_id"]),
					) ??
					rows[0] ??
					{};
				const traceId = stringField(header, ["trace_id", "pantheon.trace_id"]);
				const correlationId = stringField(header, ["correlation_id", "pantheon.correlation_id"]);
				const sessionIdHash = stringField(header, ["session_id_hash", "session_hash", "pantheon.session_id.hash"]);
				const agentName = stringField(header, ["agent_name", "agent", "pantheon.agent", "pantheon.agent_name"]);
				const startedAt = stringField(header, ["started_at", "timestamp", "time"]) ?? nowIso();
				if (!shouldIncludeStartedAt(startedAt, options.since)) continue;
				const spanId = stringField(header, ["span_id", "run_id", "pantheon.span_id"]);
				const stat = statSync(filePath);

				insertSession.run({
					$path: filePath,
					$kind: source.kind,
					$trace_id: traceId ?? null,
					$correlation_id: correlationId ?? null,
					$session_id_hash: sessionIdHash ?? null,
					$span_id: spanId ?? null,
					$agent_name: agentName ?? null,
					$started_at: startedAt,
					$bytes: stat.size,
					$mtime: stat.mtime.toISOString(),
					$content_sha256: fileHash,
				});
				summary.sessionFiles.upserted++;

				if (!traceId || !correlationId || !sessionIdHash) {
					summary.sessionFiles.quarantined++;
					continue;
				}

				const runId = runIdFor(header, filePath);
				for (const { document_id } of selectDocumentIdsForRun.all(runId)) {
					deleteEmbeddingForDocument.run(document_id);
				}
				deleteEventsForRun.run(runId);
				deleteDocumentsForRun.run(runId);
				const contentRows = rows.map((row) => ({ row, content: contentFrom(row) })).filter((item) => item.content);
				const finalOutput = [...contentRows]
					.reverse()
					.find((item) => ["final_answer", "done", "output"].includes(kindFrom(item.row)))?.content;
				insertRun.run({
					$run_id: runId,
					$trace_id: traceId,
					$parent_run_id: stringField(header, ["parent_run_id", "parent_span_id", "pantheon.parent_span_id"]) ?? null,
					$correlation_id: correlationId,
					$session_id_hash: sessionIdHash,
					$agent_name: agentName ?? "unknown",
					$agent_role: stringField(header, ["agent_role", "role", "pantheon.agent_role"]) ?? inferRole(agentName),
					$orchestrator: stringField(header, ["orchestrator"]) ?? null,
					$started_at: startedAt,
					$ended_at: stringField(header, ["ended_at"]) ?? null,
					$duration_ms: numberField(header, ["duration_ms", "pantheon.run.duration_ms"]) ?? null,
					$status: stringField(header, ["status"]) ?? "unknown",
					$turn_count: numberField(header, ["turn_count", "pantheon.turn_count"]) ?? null,
					$tool_event_count: numberField(header, ["tool_event_count", "pantheon.tool_event_count"]) ?? null,
					$output_hash: finalOutput ? sha256(redactForTelemetry(finalOutput)) : null,
					$output_preview: finalOutput ? previewForTelemetry(finalOutput) : null,
					$metadata_json: JSON.stringify({ session_file_path: filePath }),
				});
				summary.runs.upserted++;
				insertSpan.run({
					$span_id: spanId ?? runId,
					$trace_id: traceId,
					$parent_span_id: stringField(header, ["parent_span_id", "pantheon.parent_span_id"]) ?? null,
					$name: agentName ?? "local_jsonl",
					$started_at: startedAt,
					$ended_at: stringField(header, ["ended_at"]) ?? null,
					$attributes_json: JSON.stringify(header),
				});
				insertLink.run({
					$trace_id: traceId,
					$correlation_id: correlationId,
					$session_id_hash: sessionIdHash,
					$session_file_path: filePath,
				});
				summary.traceSessionLinks.upserted +=
					db.query<{ changes: number }, []>("SELECT changes() AS changes").get()?.changes ?? 0;

				let offset = 0;
				for (const { row, content } of contentRows) {
					if (!content) continue;
					const redacted = redactForTelemetry(content);
					insertEvent.run({
						$run_id: runId,
						$trace_id: traceId,
						$kind: kindFrom(row),
						$at: stringField(row, ["at", "timestamp", "time"]) ?? startedAt,
						$payload_hash: sha256(redacted),
						$payload_preview: previewForTelemetry(content),
					});
					const result = insertDocument.run({
						$run_id: runId,
						$trace_id: traceId,
						$agent_name: agentName ?? null,
						$kind:
							kindFrom(row) === "final_answer"
								? "final_answer"
								: kindFrom(row) === "tool"
									? "tool_result"
									: "transcript_chunk",
						$started_at: stringField(row, ["at", "timestamp", "time"]) ?? startedAt,
						$offset_bytes: offset,
						$length_bytes: Buffer.byteLength(content),
						$content_sha256: sha256(redacted),
						$content_redacted: contentEnabled ? redacted : null,
					});
					if (contentEnabled) {
						insertFts.run(result.lastInsertRowid, redacted);
						insertEmbedding.run(
							result.lastInsertRowid,
							JSON.stringify(embedDeterministic(redacted)),
							"deterministic-token-hash",
						);
					}
					summary.documents.upserted++;
					offset += Buffer.byteLength(content);
				}
			}
		}
		if (contentEnabled) db.exec("INSERT INTO documents_fts(documents_fts) VALUES('rebuild')");
		for (const cursorSource of ["pi_sessions", "acpx_sessions"]) {
			db.query(
				"INSERT OR REPLACE INTO ingest_cursors(source, cursor, last_run_at, last_status) VALUES(?, ?, ?, ?)",
			).run(cursorSource, nowIso(), nowIso(), "ok");
		}
	});
	ingestBatch();
	store.close();
	return summary;
}
