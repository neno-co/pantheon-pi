import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ingestTelemetry } from "../../../src/telemetry/ingest/index.ts";

export interface SeedCorpusPaths {
	tempDir: string;
	dbPath: string;
	piDir: string;
	acpxDir: string;
}

export interface SeedCorpusManifest {
	prometheusRuns: string[];
	vulkanusFailureAnchorTrace: string;
	vulkanusFailureSimilarTraces: string[];
	oracleArchAnchorTrace: string;
	oracleArchSimilarTraces: string[];
	mnemosyneAnchorTrace: string;
	mnemosyneSimilarTraces: string[];
	argusTimeoutTrace: string;
	hunterParallelTrace: string;
	hunterParallelSlowFile: string;
	parallelCorrelationIds: string[];
	parallelTraces: Array<{ correlationId: string; traceId: string; sessionFile: string }>;
}

function writeJsonl(filePath: string, rows: unknown[]) {
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function recentIso(offsetMinutesAgo: number) {
	return new Date(Date.now() - offsetMinutesAgo * 60_000).toISOString();
}

/**
 * Synthesizes the §7.2 seed corpus (Vulkanus, Oracle, Mnemosyne, Argus, hunter parallel + slow hunter).
 *
 * Synthetic substitution: fixtures replay the same SHAPE as real operator scenarios — long-running argus
 * run with no `done` event, hunter-test-coverage at ~385s — to keep the proof matrix self-contained.
 */
export function writeSeedCorpus(piDir: string, acpxDir: string): SeedCorpusManifest {
	// --- Use Case 1: Fleet Latest Runs (prometheus) ---
	const prometheusRuns: string[] = [];
	for (let index = 0; index < 6; index++) {
		const traceId = `trace-prometheus-${index}`;
		prometheusRuns.push(traceId);
		writeJsonl(path.join(piDir, `prometheus-${index}.jsonl`), [
			{
				type: "session_start",
				trace_id: traceId,
				correlation_id: `corr-prometheus-${index}`,
				session_id_hash: `sid-prometheus-${index}`,
				agent_name: "prometheus",
				agent_role: "planner",
				span_id: `run-prometheus-${index}`,
				started_at: recentIso(60 + index),
				status: "ok",
				duration_ms: 2000 + index * 100,
			},
			{ type: "final_answer", content: `prometheus plan ${index} milestones risks dependencies` },
		]);
	}

	// --- Use Case 2: Parallel Correlation (two concurrent sessions, distinct correlation_id) ---
	const parallelTraces: SeedCorpusManifest["parallelTraces"] = [];
	for (const tag of ["alpha", "beta"]) {
		const correlationId = `corr-parallel-${tag}`;
		const traceId = `trace-parallel-${tag}`;
		const sessionFile = path.join(piDir, `parallel-${tag}.jsonl`);
		writeJsonl(sessionFile, [
			{
				type: "session_start",
				trace_id: traceId,
				correlation_id: correlationId,
				session_id_hash: `sid-parallel-${tag}`,
				agent_name: "zeus",
				agent_role: "orchestrator",
				span_id: `run-parallel-${tag}`,
				started_at: recentIso(30),
				status: "ok",
				duration_ms: 4000,
			},
			{ type: "final_answer", content: `zeus parallel session ${tag} delegated work` },
		]);
		parallelTraces.push({ correlationId, traceId, sessionFile });
	}

	// --- Use Case 3: Vulkanus Failure Similar ---
	const vulkanusFailureAnchorTrace = "trace-vulkanus-failure-anchor";
	writeJsonl(path.join(piDir, "vulkanus-anchor.jsonl"), [
		{
			type: "session_start",
			trace_id: vulkanusFailureAnchorTrace,
			correlation_id: "corr-vulkanus-anchor",
			session_id_hash: "sid-vulkanus-anchor",
			agent_name: "vulkanus",
			agent_role: "executor",
			span_id: "run-vulkanus-anchor",
			started_at: recentIso(120),
			status: "error",
			duration_ms: 9000,
		},
		{
			type: "final_answer",
			content:
				"vulkanus validation failed during typecheck because missing import and missing test coverage for boundary condition",
		},
	]);
	const vulkanusFailureSimilarTraces: string[] = [];
	const vulkanusSimilarContent = [
		"vulkanus validation failed typecheck reported missing import for boundary helper",
		"vulkanus implementation failed validation: typecheck missing import and boundary test coverage gap",
		"vulkanus typecheck validation failure missing import boundary coverage",
	];
	for (let index = 0; index < vulkanusSimilarContent.length; index++) {
		const traceId = `trace-vulkanus-similar-${index}`;
		vulkanusFailureSimilarTraces.push(traceId);
		writeJsonl(path.join(piDir, `vulkanus-similar-${index}.jsonl`), [
			{
				type: "session_start",
				trace_id: traceId,
				correlation_id: `corr-vulkanus-similar-${index}`,
				session_id_hash: `sid-vulkanus-similar-${index}`,
				agent_name: "vulkanus",
				agent_role: "executor",
				span_id: `run-vulkanus-similar-${index}`,
				started_at: recentIso(240 + index * 60),
				status: "error",
				duration_ms: 8000 + index * 100,
			},
			{ type: "final_answer", content: vulkanusSimilarContent[index] },
		]);
	}
	// Unrelated vulkanus success (should NOT rank as similar to failure anchor)
	writeJsonl(path.join(piDir, "vulkanus-unrelated.jsonl"), [
		{
			type: "session_start",
			trace_id: "trace-vulkanus-unrelated",
			correlation_id: "corr-vulkanus-unrelated",
			session_id_hash: "sid-vulkanus-unrelated",
			agent_name: "vulkanus",
			agent_role: "executor",
			span_id: "run-vulkanus-unrelated",
			started_at: recentIso(500),
			status: "ok",
			duration_ms: 1500,
		},
		{ type: "final_answer", content: "vulkanus completed simple refactor without incident green build" },
	]);

	// --- Use Case 4: Oracle Architecture Search ---
	const oracleArchAnchorTrace = "trace-oracle-arch-anchor";
	writeJsonl(path.join(piDir, "oracle-anchor.jsonl"), [
		{
			type: "session_start",
			trace_id: oracleArchAnchorTrace,
			correlation_id: "corr-oracle-anchor",
			session_id_hash: "sid-oracle-anchor",
			agent_name: "oracle",
			agent_role: "consultant",
			span_id: "run-oracle-anchor",
			started_at: recentIso(180),
			status: "ok",
			duration_ms: 3000,
		},
		{
			type: "final_answer",
			content: "oracle consultation on eventual consistency tradeoffs across distributed services",
		},
	]);
	const oracleArchSimilarTraces: string[] = [];
	const oracleSimilarContent = [
		"oracle architecture review on eventual consistency in replication topology",
		"oracle weighed eventual consistency tradeoffs distributed services replication",
		"oracle reviewed consistency model: eventual consistency for the distributed cache layer",
	];
	for (let index = 0; index < oracleSimilarContent.length; index++) {
		const traceId = `trace-oracle-similar-${index}`;
		oracleArchSimilarTraces.push(traceId);
		writeJsonl(path.join(piDir, `oracle-similar-${index}.jsonl`), [
			{
				type: "session_start",
				trace_id: traceId,
				correlation_id: `corr-oracle-similar-${index}`,
				session_id_hash: `sid-oracle-similar-${index}`,
				agent_name: "oracle",
				agent_role: "consultant",
				span_id: `run-oracle-similar-${index}`,
				started_at: recentIso(360 + index * 60),
				status: "ok",
				duration_ms: 2500 + index * 100,
			},
			{ type: "final_answer", content: oracleSimilarContent[index] },
		]);
	}
	// Unrelated oracle (no eventual consistency content)
	writeJsonl(path.join(piDir, "oracle-unrelated.jsonl"), [
		{
			type: "session_start",
			trace_id: "trace-oracle-unrelated",
			correlation_id: "corr-oracle-unrelated",
			session_id_hash: "sid-oracle-unrelated",
			agent_name: "oracle",
			agent_role: "consultant",
			span_id: "run-oracle-unrelated",
			started_at: recentIso(600),
			status: "ok",
			duration_ms: 1000,
		},
		{ type: "final_answer", content: "oracle reviewed naming convention for new module exports" },
	]);

	// --- Use Case 5: Mnemosyne Research Similar ---
	const mnemosyneAnchorTrace = "trace-mnemosyne-anchor";
	writeJsonl(path.join(piDir, "mnemosyne-anchor.jsonl"), [
		{
			type: "session_start",
			trace_id: mnemosyneAnchorTrace,
			correlation_id: "corr-mnemosyne-anchor",
			session_id_hash: "sid-mnemosyne-anchor",
			agent_name: "mnemosyne",
			agent_role: "librarian",
			span_id: "run-mnemosyne-anchor",
			started_at: recentIso(200),
			status: "ok",
			duration_ms: 5000,
		},
		{
			type: "final_answer",
			content: "mnemosyne research mapped auth middleware modules sessions tokens jwt verification",
		},
	]);
	const mnemosyneSimilarTraces: string[] = [];
	const mnemosyneSimilarContent = [
		"mnemosyne mapped auth middleware sessions jwt verification tokens",
		"mnemosyne researched auth middleware jwt tokens sessions verification flow",
	];
	for (let index = 0; index < mnemosyneSimilarContent.length; index++) {
		const traceId = `trace-mnemosyne-similar-${index}`;
		mnemosyneSimilarTraces.push(traceId);
		writeJsonl(path.join(piDir, `mnemosyne-similar-${index}.jsonl`), [
			{
				type: "session_start",
				trace_id: traceId,
				correlation_id: `corr-mnemosyne-similar-${index}`,
				session_id_hash: `sid-mnemosyne-similar-${index}`,
				agent_name: "mnemosyne",
				agent_role: "librarian",
				span_id: `run-mnemosyne-similar-${index}`,
				started_at: recentIso(420 + index * 60),
				status: "ok",
				duration_ms: 4500,
			},
			{ type: "final_answer", content: mnemosyneSimilarContent[index] },
		]);
	}

	// --- Use Case 6: Argus timeout + Hunter parallel slow ---
	const argusTimeoutTrace = "trace-argus-timeout-synthetic";
	writeJsonl(path.join(acpxDir, "argus-timeout.jsonl"), [
		{
			type: "session_start",
			trace_id: argusTimeoutTrace,
			correlation_id: "corr-argus-timeout-synthetic",
			session_id_hash: "sid-argus-timeout-synthetic",
			agent_name: "argus",
			agent_role: "reviewer",
			span_id: "run-argus-timeout-synthetic",
			started_at: recentIso(60),
			status: "timeout",
			duration_ms: 600_000,
		},
		{ type: "tool", content: "argus running review pass over diff" },
		// intentionally no final_answer / done — replays a no-done timeout shape
	]);
	const hunterParallelTrace = "trace-hunter-parallel-synthetic";
	const hunterParallelSlowFile = path.join(
		acpxDir,
		"sessions/2026-05-24T20-50-00-055Z_019e5bc0-74f7-7f77-8f14-7cdf77767c45.jsonl",
	);
	writeJsonl(hunterParallelSlowFile, [
		{
			type: "session_start",
			trace_id: hunterParallelTrace,
			correlation_id: "corr-hunter-parallel-synthetic",
			session_id_hash: "sid-hunter-parallel-synthetic",
			agent_name: "hunter-test-coverage",
			agent_role: "hunter",
			span_id: "run-hunter-parallel-synthetic",
			started_at: recentIso(45),
			status: "ok",
			duration_ms: 385_000,
		},
		{ type: "final_answer", content: "hunter-test-coverage flagged 3 untested branches in auth middleware" },
	]);
	// Faster hunters that should NOT outrank the 385s outlier
	for (const [index, name] of ["hunter-style", "hunter-typing"].entries()) {
		writeJsonl(path.join(acpxDir, `${name}.jsonl`), [
			{
				type: "session_start",
				trace_id: `trace-${name}`,
				correlation_id: `corr-${name}`,
				session_id_hash: `sid-${name}`,
				agent_name: name,
				agent_role: "hunter",
				span_id: `run-${name}`,
				started_at: recentIso(50 + index),
				status: "ok",
				duration_ms: 30_000 + index * 5_000,
			},
			{ type: "final_answer", content: `${name} found nothing significant` },
		]);
	}

	return {
		prometheusRuns,
		vulkanusFailureAnchorTrace,
		vulkanusFailureSimilarTraces,
		oracleArchAnchorTrace,
		oracleArchSimilarTraces,
		mnemosyneAnchorTrace,
		mnemosyneSimilarTraces,
		argusTimeoutTrace,
		hunterParallelTrace,
		hunterParallelSlowFile,
		parallelCorrelationIds: parallelTraces.map((row) => row.correlationId),
		parallelTraces,
	};
}

export async function buildSeedCorpus(paths: SeedCorpusPaths): Promise<SeedCorpusManifest> {
	mkdirSync(paths.piDir, { recursive: true });
	mkdirSync(paths.acpxDir, { recursive: true });
	const manifest = writeSeedCorpus(paths.piDir, paths.acpxDir);
	await ingestTelemetry({
		dbPath: paths.dbPath,
		piSessionDirs: [paths.piDir],
		acpxSessionDirs: [paths.acpxDir],
		skipLock: true,
		env: { PANTHEON_TELEMETRY_STORE_CONTENT: "true" },
	});
	return manifest;
}
