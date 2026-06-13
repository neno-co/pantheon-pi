import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { telemetryMain } from "../../src/telemetry/cli/index.ts";
import { buildSeedCorpus, type SeedCorpusManifest } from "./fixtures/seed-corpus.ts";

interface MatrixMetric {
	row: number;
	use_case: string;
	command: string;
	actual_ms: number;
	threshold_ms: number;
	passed: boolean;
	fixture: true;
	authoritative_live_proof: false;
}

const metrics: MatrixMetric[] = [];

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
	const start = performance.now();
	const result = await fn();
	return { result, ms: performance.now() - start };
}

function record(metric: Omit<MatrixMetric, "passed" | "fixture" | "authoritative_live_proof">) {
	metrics.push({
		...metric,
		passed: metric.actual_ms <= metric.threshold_ms,
		fixture: true,
		authoritative_live_proof: false,
	});
}

/**
 * Fixture-backed §7.1 E2E proof matrix. The §7.2 fresh-subagent UX bar is NOT proven here —
 * see scripts/telemetry-live-eval.ts for the gated live runner.
 *
 * Latency thresholds match the spec table, but on an in-process fixture DB they act as a
 * regression sentinel rather than perf proof on a real populated index.
 */
describe("telemetry §7.1 proof matrix — fixture-backed (NOT authoritative live proof)", () => {
	let tempDir: string;
	let dbPath: string;
	let piDir: string;
	let acpxDir: string;
	let manifest: SeedCorpusManifest;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pantheon-telemetry-proof-${crypto.randomUUID()}`);
		dbPath = path.join(tempDir, "telemetry.db");
		piDir = path.join(tempDir, "pi-sessions");
		acpxDir = path.join(tempDir, "acpx-sessions");
		manifest = await buildSeedCorpus({ tempDir, dbPath, piDir, acpxDir });
	});

	afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

	afterAll(() => {
		const reportDir = path.join(process.cwd(), "reports");
		mkdirSync(reportDir, { recursive: true });
		writeFileSync(
			path.join(reportDir, "telemetry-proof-matrix.json"),
			`${JSON.stringify(
				{
					generated_at: new Date().toISOString(),
					fixture: true,
					authoritative_live_proof: false,
					note: "Latency thresholds are regression sentinels against a tiny in-process fixture DB. Real-perf proof requires the gated live runner.",
					metrics,
				},
				null,
				2,
			)}\n`,
		);
	});

	test("Row 1 — Fleet Latest Runs: --agent prometheus --limit 5 returns exactly 5 structured rows", async () => {
		const command = "pantheon telemetry runs --agent prometheus --limit 5 --json";
		const { result: output, ms } = await timed(() =>
			telemetryMain(["runs", "--agent", "prometheus", "--limit", "5", "--json", "--no-ingest"], { dbPath }),
		);
		record({ row: 1, use_case: "Fleet Latest Runs", command, actual_ms: ms, threshold_ms: 500 });
		const parsed = JSON.parse(output);
		expect(parsed.runs).toHaveLength(5);
		for (const run of parsed.runs) {
			expect(run).toMatchObject({ agent_name: "prometheus", agent_role: "planner" });
			expect(typeof run.run_id).toBe("string");
			expect(typeof run.trace_id).toBe("string");
			expect(typeof run.started_at).toBe("string");
			expect(typeof run.duration_ms).toBe("number");
			expect(typeof run.output_preview).toBe("string");
		}
		const traceIds = parsed.runs.map((row: { trace_id: string }) => row.trace_id);
		expect(new Set(traceIds).size).toBe(5);
		for (const traceId of traceIds) expect(manifest.prometheusRuns).toContain(traceId);
		expect(ms).toBeLessThanOrEqual(500);
	});

	test("Row 2 — Parallel Correlation: each correlation_id resolves to its own session file with no cross-talk", async () => {
		const command = "pantheon telemetry session-file --correlation-id <id> --json (per parallel session)";
		const calls: Array<{ ms: number; expected: string; actual: string[] }> = [];
		for (const parallel of manifest.parallelTraces) {
			const { result, ms } = await timed(() =>
				telemetryMain(["session-file", "--correlation-id", parallel.correlationId, "--json", "--no-ingest"], {
					dbPath,
				}),
			);
			const parsed = JSON.parse(result);
			calls.push({ ms, expected: parallel.sessionFile, actual: parsed.session_files });
		}
		const worst = calls.reduce((max, call) => Math.max(max, call.ms), 0);
		record({ row: 2, use_case: "Parallel Correlation", command, actual_ms: worst, threshold_ms: 100 });
		for (const call of calls) {
			expect(call.actual).toEqual([call.expected]);
		}
		const allSeen = calls.flatMap((call) => call.actual);
		expect(new Set(allSeen).size).toBe(calls.length);
		expect(worst).toBeLessThanOrEqual(100);
	});

	test("Row 3 — Vulkanus Failure: similar groups by trace and ranks semantic neighbours above unrelated runs", async () => {
		const command = `pantheon telemetry similar ${manifest.vulkanusFailureAnchorTrace} --agent vulkanus --top 3 --json`;
		const { result, ms } = await timed(() =>
			telemetryMain(
				["similar", manifest.vulkanusFailureAnchorTrace, "--agent", "vulkanus", "--top", "3", "--json", "--no-ingest"],
				{ dbPath },
			),
		);
		record({ row: 3, use_case: "Vulkanus Failure Similar", command, actual_ms: ms, threshold_ms: 1500 });
		const parsed = JSON.parse(result);
		expect(parsed.available).toBe(true);
		expect(parsed.results.length).toBeGreaterThanOrEqual(1);
		const traceIds = parsed.results.map((row: { trace_id: string }) => row.trace_id);
		// Grouped by trace_id
		expect(new Set(traceIds).size).toBe(traceIds.length);
		// Anchor must not appear in results
		expect(traceIds).not.toContain(manifest.vulkanusFailureAnchorTrace);
		// At least one of the semantic neighbours is in the top-3
		const topThree = traceIds.slice(0, 3);
		const hits = topThree.filter((id: string) => manifest.vulkanusFailureSimilarTraces.includes(id));
		expect(hits.length).toBeGreaterThanOrEqual(1);
		// Unrelated success should not outrank all of them
		expect(parsed.results[0]).toMatchObject({ agent_name: "vulkanus" });
		expect(ms).toBeLessThanOrEqual(1500);
	});

	test("Row 4 — Oracle Arch Search: FTS + Semantic flow returns architecture neighbours", async () => {
		const fts = await timed(() =>
			telemetryMain(["search", "eventual consistency", "--agent", "oracle", "--json", "--no-ingest"], {
				dbPath,
				env: { PANTHEON_TELEMETRY_STORE_CONTENT: "true" },
			}),
		);
		record({
			row: 4,
			use_case: "Oracle Arch Search (FTS)",
			command: `pantheon telemetry search "eventual consistency" --agent oracle --json`,
			actual_ms: fts.ms,
			threshold_ms: 500,
		});
		const ftsParsed = JSON.parse(fts.result);
		expect(ftsParsed.content_storage_enabled).toBe(true);
		expect(ftsParsed.results.length).toBeGreaterThanOrEqual(2);
		for (const hit of ftsParsed.results) expect(hit.agent_name).toBe("oracle");
		expect(fts.ms).toBeLessThanOrEqual(500);

		const anchorDocId =
			ftsParsed.results.find(
				(row: { trace_id: string; document_id: number }) => row.trace_id === manifest.oracleArchAnchorTrace,
			)?.document_id ?? ftsParsed.results[0].document_id;

		const vec = await timed(() =>
			telemetryMain(["similar", String(anchorDocId), "--agent", "oracle", "--top", "3", "--json", "--no-ingest"], {
				dbPath,
			}),
		);
		record({
			row: 4,
			use_case: "Oracle Arch Search (Semantic)",
			command: `pantheon telemetry similar <doc_id> --agent oracle --top 3 --json`,
			actual_ms: vec.ms,
			threshold_ms: 1500,
		});
		const vecParsed = JSON.parse(vec.result);
		expect(vecParsed.available).toBe(true);
		expect(vecParsed.results.length).toBeGreaterThanOrEqual(1);
		const vecTraceIds = vecParsed.results.map((row: { trace_id: string }) => row.trace_id);
		expect(new Set(vecTraceIds).size).toBe(vecTraceIds.length);
		const hits = vecTraceIds.filter((id: string) => manifest.oracleArchSimilarTraces.includes(id));
		expect(hits.length).toBeGreaterThanOrEqual(1);
		expect(vec.ms).toBeLessThanOrEqual(1500);
	});

	test("Row 5 — Mnemosyne Research: similar returns related research sessions grouped by trace", async () => {
		const command = `pantheon telemetry similar ${manifest.mnemosyneAnchorTrace} --agent mnemosyne --top 3 --json`;
		const { result, ms } = await timed(() =>
			telemetryMain(
				["similar", manifest.mnemosyneAnchorTrace, "--agent", "mnemosyne", "--top", "3", "--json", "--no-ingest"],
				{ dbPath },
			),
		);
		record({ row: 5, use_case: "Mnemosyne Research Similar", command, actual_ms: ms, threshold_ms: 1500 });
		const parsed = JSON.parse(result);
		expect(parsed.available).toBe(true);
		const traceIds = parsed.results.map((row: { trace_id: string }) => row.trace_id);
		expect(new Set(traceIds).size).toBe(traceIds.length);
		expect(traceIds).not.toContain(manifest.mnemosyneAnchorTrace);
		const hits = traceIds.filter((id: string) => manifest.mnemosyneSimilarTraces.includes(id));
		expect(hits.length).toBeGreaterThanOrEqual(1);
		for (const row of parsed.results) expect(row.agent_name).toBe("mnemosyne");
		expect(ms).toBeLessThanOrEqual(1500);
	});

	test("Row 6 — Argus / Hunter SLA: slow --role hunter identifies hunter-test-coverage outlier with correct duration", async () => {
		const command = "pantheon telemetry slow --role hunter --since 24h --top 5 --json";
		const { result, ms } = await timed(() =>
			telemetryMain(["slow", "--role", "hunter", "--since", "24h", "--top", "5", "--json", "--no-ingest"], { dbPath }),
		);
		record({ row: 6, use_case: "Argus / Hunter SLA", command, actual_ms: ms, threshold_ms: 500 });
		const parsed = JSON.parse(result);
		expect(parsed.runs.length).toBeGreaterThanOrEqual(1);
		const top = parsed.runs[0];
		expect(top).toMatchObject({
			agent_name: "hunter-test-coverage",
			agent_role: "hunter",
			duration_ms: 385_000,
			trace_id: manifest.hunterParallelTrace,
		});
		// Faster hunters must not outrank
		for (let index = 1; index < parsed.runs.length; index++) {
			expect(parsed.runs[index].duration_ms).toBeLessThanOrEqual(top.duration_ms);
		}
		// Argus timeout also surfaces under role=reviewer; not required for hunter SLA query, but
		// the trace itself must be queryable via trace command.
		const argusTrace = JSON.parse(
			await telemetryMain(["trace", manifest.argusTimeoutTrace, "--json", "--no-ingest"], { dbPath }),
		);
		expect(argusTrace.runs).toMatchObject([
			{ agent_name: "argus", agent_role: "reviewer", status: "timeout", duration_ms: 600_000 },
		]);
		expect(argusTrace.session_files.length).toBe(1);
		expect(ms).toBeLessThanOrEqual(500);
	});

	test("Row 7 — Fresh-Subagent UX: skill-recipe contract proxy (NOT a substitute for §7.2 live proof)", async () => {
		// Simulates a fresh subagent that can only see commands listed in the
		// pantheon-telemetry SKILL.md cheat-sheet. We verify each documented recipe
		// is sufficient on its own to answer a seed §7.2 question in ≤3 invocations.
		// This is a CONTRACT proxy. The actual UX bar (real fresh subagent reading
		// the skill once, no operator help, ≤30s wall-clock) is enforced only by
		// scripts/telemetry-live-eval.ts when PANTHEON_TELEMETRY_LIVE_E2E=true.
		const start = performance.now();

		// Q1: "most recent Vulkanus run that failed during validation"
		const vulkanusErrors = JSON.parse(
			await telemetryMain(
				["runs", "--agent", "vulkanus", "--status", "error", "--limit", "1", "--json", "--no-ingest"],
				{ dbPath },
			),
		);
		expect(vulkanusErrors.runs.length).toBe(1);
		expect(vulkanusErrors.runs[0].agent_name).toBe("vulkanus");
		expect(vulkanusErrors.runs[0].status).toBe("error");

		// Q2: "find the most recent Argus run that timed out and tell me the local session file path"
		// Path A: runs --agent argus --status timeout → trace_id → session-file <trace_id>
		const argusTimeouts = JSON.parse(
			await telemetryMain(
				["runs", "--agent", "argus", "--status", "timeout", "--limit", "1", "--json", "--no-ingest"],
				{ dbPath },
			),
		);
		expect(argusTimeouts.runs[0].trace_id).toBe(manifest.argusTimeoutTrace);
		const argusFile = JSON.parse(
			await telemetryMain(["session-file", argusTimeouts.runs[0].trace_id, "--json", "--no-ingest"], { dbPath }),
		);
		expect(argusFile.session_files.length).toBe(1);

		// Q3: "which hunter was slowest on the last 24h"
		const slowHunter = JSON.parse(
			await telemetryMain(["hunters", "slow", "--top", "1", "--since", "24h", "--json", "--no-ingest"], { dbPath }),
		);
		expect(slowHunter.runs[0].agent_name).toBe("hunter-test-coverage");

		const ms = performance.now() - start;
		record({
			row: 7,
			use_case: "Fresh-Subagent UX (fixture proxy, NOT live UX proof)",
			command: "multi-step recipe: runs + session-file + hunters slow",
			actual_ms: ms,
			threshold_ms: 30_000,
		});
		expect(ms).toBeLessThanOrEqual(30_000);
	});
});
