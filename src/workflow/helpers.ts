import { getAcpxBackend } from "../agents.ts";
import { getCurrentMainTraceState } from "../langwatch/index.ts";
import { type AcpxRunRequest, type AcpxRunResult, runAcpx } from "../runner/index.ts";
import { createRunArtifacts, finalizeRunArtifacts } from "./artifacts.ts";
import { type PantheonWorkflowRegistry, pantheonWorkflowRegistry } from "./registry.ts";
import { findAcpxSessionFileByName, sanitizeAcpxSessionName } from "./session.ts";
import type { PantheonRunSnapshot, PantheonWorkflowSnapshot, PantheonWorkflowStatus } from "./types.ts";

export interface PantheonWorkflowNode {
	agent: string;
	prompt: string;
	label?: string;
	runType?: AcpxRunRequest["runType"];
	sessionId?: string;
	cwd?: string;
	model?: string;
	maxTurns?: number;
	permissions?: AcpxRunRequest["permissions"];
	timeoutSeconds?: number;
	ttlSeconds?: number;
}

export interface PantheonWorkflowOptions {
	workflowId?: string;
	cwd?: string;
	mode?: PantheonWorkflowSnapshot["mode"];
	concurrency?: number;
	registry?: PantheonWorkflowRegistry;
	runner?: (request: AcpxRunRequest) => Promise<AcpxRunResult>;
	signal?: AbortSignal;
	onSnapshot?: (run: PantheonRunSnapshot) => void;
}

export interface PantheonWorkflowRunResult {
	run: PantheonRunSnapshot;
	result: AcpxRunResult;
	artifactsDir?: string;
}

function finalStatus(result: AcpxRunResult): PantheonWorkflowStatus {
	if (result.timedOut) return "timeout";
	if (result.aborted) return "cancelled";
	return result.success ? "completed" : "failed";
}

function acpxSessionName(node: PantheonWorkflowNode, sessionId: string | undefined) {
	return (node.runType ?? "exec") === "session"
		? sanitizeAcpxSessionName(node.agent, node.sessionId ?? sessionId)
		: undefined;
}

function defaultWorkflowSessionId(node: PantheonWorkflowNode, workflowId: string | undefined) {
	return sanitizeAcpxSessionName(
		node.agent,
		`${workflowId ?? "wf"}-${node.agent}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
	);
}

export async function runPantheonWorkflowNode(
	node: PantheonWorkflowNode,
	options: PantheonWorkflowOptions = {},
): Promise<PantheonWorkflowRunResult> {
	const registry = options.registry ?? pantheonWorkflowRegistry;
	const runner = options.runner ?? runAcpx;
	const mainTrace = getCurrentMainTraceState();
	const runType = node.runType ?? "session";
	const cwd = node.cwd ?? options.cwd ?? process.cwd();
	const sessionId =
		runType === "session" ? (node.sessionId ?? defaultWorkflowSessionId(node, options.workflowId)) : undefined;
	const sessionName = acpxSessionName({ ...node, runType }, sessionId);
	const startedAt = Date.now();
	const backend = getAcpxBackend(node.agent);
	const model = node.model ?? backend.model;
	const run = registry.startRun({
		workflowId: options.workflowId,
		mode: options.mode ?? "single",
		agent: node.agent,
		label: node.label,
		runType,
		cwd,
		acpxBackend: "acpx",
		model,
		acpxSessionName: sessionName,
		traceId: mainTrace?.traceId,
		spanId: mainTrace?.turnSpan?.spanContext().spanId ?? mainTrace?.spanId,
		correlationId: mainTrace?.correlationId,
	});
	const artifacts = createRunArtifacts({
		workflowId: run.workflowId,
		runId: run.id,
		agent: node.agent,
		cwd,
		prompt: node.prompt,
		runType,
		acpxSessionName: sessionName,
		traceId: run.traceId,
		spanId: run.spanId,
		correlationId: run.correlationId,
		startedAt,
	});
	registry.setArtifacts(run.id, artifacts);
	options.onSnapshot?.(run);

	const result = await runner({
		agent: node.agent,
		prompt: node.prompt,
		cwd,
		runType,
		sessionId,
		model,
		maxTurns: node.maxTurns,
		permissions: node.permissions,
		timeoutSeconds: node.timeoutSeconds,
		ttlSeconds: node.ttlSeconds,
		signal: options.signal,
		onOutput: (stream, chunk) => {
			registry.appendOutput(run.id, stream, chunk);
			const updated = registry
				.snapshots()
				.flatMap((snapshot) => snapshot.runs)
				.find((candidate) => candidate.id === run.id);
			if (updated) options.onSnapshot?.(updated);
		},
		onStatus: (status) => {
			const updated = registry.updateStatus(run.id, status);
			if (updated) options.onSnapshot?.(updated);
		},
	});
	registry.finishRun(run.id, finalStatus(result));
	const sessionFile = sessionName ? findAcpxSessionFileByName(sessionName) : undefined;
	registry.setAcpxSessionFile(run.id, sessionFile);
	const sessionRecordId = sessionFile?.match(/([^/]+)\.json$/)?.[1];
	finalizeRunArtifacts({
		workflowId: run.workflowId,
		runId: run.id,
		agent: node.agent,
		cwd,
		prompt: node.prompt,
		runType,
		acpxSessionName: sessionName,
		acpxSessionFile: sessionFile,
		acpxSessionRecordId: sessionRecordId,
		traceId: run.traceId,
		spanId: run.spanId,
		correlationId: run.correlationId,
		startedAt,
		artifacts,
		result,
		completedAt: Date.now(),
	});
	const finalRun =
		registry
			.snapshots()
			.flatMap((snapshot) => snapshot.runs)
			.find((candidate) => candidate.id === run.id) ?? run;
	return { run: finalRun, result, artifactsDir: artifacts.dir };
}

export async function runPantheonParallelWorkflow(
	nodes: PantheonWorkflowNode[],
	options: PantheonWorkflowOptions = {},
) {
	const workflowId = options.workflowId ?? `wf-${Date.now().toString(36)}`;
	const nodeCount = nodes.length || 1;
	const concurrency = Math.max(1, Math.min(options.concurrency ?? nodeCount, nodeCount));
	const results: PantheonWorkflowRunResult[] = [];
	let next = 0;
	async function worker() {
		while (next < nodes.length) {
			const index = next++;
			const node = nodes[index];
			if (!node) continue;
			results[index] = await runPantheonWorkflowNode(node, { ...options, workflowId, mode: "parallel" });
		}
	}
	await Promise.all(Array.from({ length: concurrency }, () => worker()));
	return results;
}

export async function runPantheonChainWorkflow(nodes: PantheonWorkflowNode[], options: PantheonWorkflowOptions = {}) {
	const workflowId = options.workflowId ?? `wf-${Date.now().toString(36)}`;
	const results: PantheonWorkflowRunResult[] = [];
	for (let index = 0; index < nodes.length; index += 1) {
		const node = nodes[index];
		if (!node) continue;
		const prior = results.at(-1);
		const prompt = prior?.artifactsDir
			? `${node.prompt}\n\nPrevious step artifact directory: ${prior.artifactsDir}`
			: node.prompt;
		results.push(await runPantheonWorkflowNode({ ...node, prompt }, { ...options, workflowId, mode: "chain" }));
	}
	return results;
}
