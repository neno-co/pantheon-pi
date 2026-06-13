import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DETERMINISTIC_EMBEDDING_DIMENSIONS } from "../embed/index.ts";
import { defaultTelemetryDbPath, nowIso, TELEMETRY_SCHEMA_VERSION } from "../shared/index.ts";

export interface TelemetryStoreOptions {
	dbPath?: string;
}

export interface TelemetryStore {
	db: Database;
	dbPath: string;
	close(): void;
}

const AGENT_VIEW_NAMES = ["athena", "zeus", "vulkanus", "prometheus", "mnemosyne", "oracle", "argus"];

function createVecTable(db: Database) {
	db.exec(
		"CREATE TABLE IF NOT EXISTS embeddings(document_id INTEGER PRIMARY KEY, embedding TEXT NOT NULL, provider TEXT DEFAULT 'deterministic-token-hash');",
	);
}

function applySchema(db: Database) {
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA foreign_keys = ON;");
	db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, metadata TEXT);
CREATE TABLE IF NOT EXISTS runs(
	run_id TEXT PRIMARY KEY,
	trace_id TEXT NOT NULL,
	parent_run_id TEXT,
	correlation_id TEXT NOT NULL,
	session_id_hash TEXT NOT NULL,
	agent_name TEXT NOT NULL,
	agent_role TEXT NOT NULL,
	orchestrator TEXT,
	source TEXT NOT NULL,
	started_at TEXT NOT NULL,
	ended_at TEXT,
	duration_ms INTEGER,
	status TEXT,
	turn_count INTEGER,
	tool_event_count INTEGER,
	prompt_hash TEXT,
	prompt_preview TEXT,
	output_hash TEXT,
	output_preview TEXT,
	metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_trace ON runs(trace_id);
CREATE INDEX IF NOT EXISTS idx_runs_agent_started ON runs(agent_name, started_at);
CREATE INDEX IF NOT EXISTS idx_runs_role_started ON runs(agent_role, started_at);
CREATE INDEX IF NOT EXISTS idx_runs_duration ON runs(duration_ms);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_orchestrator_started ON runs(orchestrator, started_at);
CREATE TABLE IF NOT EXISTS spans(
	span_id TEXT PRIMARY KEY,
	trace_id TEXT NOT NULL,
	parent_span_id TEXT,
	name TEXT,
	kind TEXT,
	started_at TEXT NOT NULL,
	ended_at TEXT,
	attributes_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_spans_trace_parent ON spans(trace_id, parent_span_id);
CREATE TABLE IF NOT EXISTS events(
	event_id INTEGER PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
	trace_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	at TEXT NOT NULL,
	payload_hash TEXT,
	payload_preview TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_run_at ON events(run_id, at);
CREATE TABLE IF NOT EXISTS documents(
	document_id INTEGER PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
	trace_id TEXT NOT NULL,
	agent_name TEXT,
	kind TEXT NOT NULL,
	started_at TEXT,
	offset_bytes INTEGER,
	length_bytes INTEGER,
	content_sha256 TEXT NOT NULL,
	content_redacted TEXT
);
CREATE INDEX IF NOT EXISTS idx_documents_run_kind ON documents(run_id, kind);
CREATE INDEX IF NOT EXISTS idx_documents_trace_off ON documents(trace_id, offset_bytes);
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(content_redacted, content='documents', content_rowid='document_id', tokenize='porter unicode61');
CREATE TABLE IF NOT EXISTS session_files(
	path TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	trace_id TEXT,
	correlation_id TEXT,
	session_id_hash TEXT,
	span_id TEXT,
	agent_name TEXT,
	started_at TEXT,
	bytes INTEGER,
	mtime TEXT,
	content_sha256 TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_files_trace ON session_files(trace_id);
CREATE INDEX IF NOT EXISTS idx_session_files_corr ON session_files(correlation_id);
CREATE INDEX IF NOT EXISTS idx_session_files_sid ON session_files(session_id_hash);
CREATE INDEX IF NOT EXISTS idx_session_files_agent ON session_files(agent_name, started_at);
CREATE TABLE IF NOT EXISTS trace_session_links(
	trace_id TEXT NOT NULL,
	correlation_id TEXT NOT NULL,
	session_id_hash TEXT NOT NULL,
	session_file_path TEXT NOT NULL,
	PRIMARY KEY(trace_id, correlation_id, session_id_hash, session_file_path)
);
CREATE INDEX IF NOT EXISTS idx_tsl_corr ON trace_session_links(correlation_id);
CREATE INDEX IF NOT EXISTS idx_tsl_sid ON trace_session_links(session_id_hash);
CREATE TABLE IF NOT EXISTS tags(tag_id INTEGER PRIMARY KEY, key TEXT NOT NULL, value TEXT, UNIQUE(key, value));
CREATE TABLE IF NOT EXISTS run_tags(
	run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
	tag_id INTEGER NOT NULL REFERENCES tags(tag_id) ON DELETE CASCADE,
	PRIMARY KEY(run_id, tag_id)
);
CREATE TABLE IF NOT EXISTS ingest_cursors(source TEXT PRIMARY KEY, cursor TEXT NOT NULL, last_run_at TEXT NOT NULL, last_status TEXT);
CREATE VIEW IF NOT EXISTS quarantine_session_files AS SELECT * FROM session_files WHERE trace_id IS NULL OR correlation_id IS NULL OR session_id_hash IS NULL;
CREATE VIEW IF NOT EXISTS hunter_runs AS SELECT * FROM runs WHERE agent_role = 'hunter';
CREATE VIEW IF NOT EXISTS argus_runs AS
	SELECT r.*, (SELECT d.content_redacted FROM documents d WHERE d.run_id = r.run_id AND d.kind = 'final_answer' LIMIT 1) AS verdict_text
	FROM runs r WHERE r.agent_name = 'argus';
CREATE VIEW IF NOT EXISTS vulkanus_runs AS
	SELECT r.*, (SELECT d.content_redacted FROM documents d WHERE d.run_id = r.run_id AND d.kind = 'output' LIMIT 1) AS implementation_summary
	FROM runs r WHERE r.agent_name = 'vulkanus';
`);
	for (const agent of AGENT_VIEW_NAMES.filter((agent) => !["argus", "vulkanus"].includes(agent))) {
		db.exec(`CREATE VIEW IF NOT EXISTS ${agent}_runs AS SELECT * FROM runs WHERE agent_name = '${agent}';`);
	}
	createVecTable(db);
	db.query("INSERT OR IGNORE INTO schema_migrations(version, applied_at, metadata) VALUES (?, ?, ?)").run(
		TELEMETRY_SCHEMA_VERSION,
		nowIso(),
		JSON.stringify({
			embedding: { provider: "deterministic-token-hash", dimension: DETERMINISTIC_EMBEDDING_DIMENSIONS },
		}),
	);
}

export function openTelemetryStore(options: TelemetryStoreOptions = {}): TelemetryStore {
	const dbPath = options.dbPath ?? defaultTelemetryDbPath();
	mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
	const db = new Database(dbPath, { create: true });
	applySchema(db);
	return { db, dbPath, close: () => db.close() };
}
