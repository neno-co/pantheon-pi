import type { AcpxRunType, AcpxStatus } from "../runner/index.ts";
import { stripAnsi } from "../runner/index.ts";
import type {
	PantheonRunArtifacts,
	PantheonRunSnapshot,
	PantheonWorkflowSnapshot,
	PantheonWorkflowStatus,
} from "./types.ts";

const PREVIEW_LIMIT = 200;
const terminalStatuses = new Set<PantheonWorkflowStatus>(["completed", "failed", "timeout", "cancelled"]);

export function mapAcpxStatus(status: AcpxStatus): PantheonWorkflowStatus {
	switch (status) {
		case "starting":
		case "running":
			return "running";
		case "done":
			return "completed";
		case "timeout":
			return "timeout";
		case "aborting":
			return "cancelled";
		case "failed":
			return "failed";
	}
}

function nextId(prefix: string) {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function trimPreview(lines: string[]) {
	return lines.slice(-PREVIEW_LIMIT);
}

function appendPreviewLines(existing: string[] | undefined, lines: string[]) {
	return trimPreview([...(existing ?? []), ...lines.filter((line) => line.length > 0)]);
}

interface RunStreamState {
	stdoutRemainder: string;
	stderrRemainder: string;
	markerCount: number;
	turnCount: number;
	toolCount: number;
}

function splitCompleteLines(previousRemainder: string, chunk: string) {
	const text = `${previousRemainder}${stripAnsi(chunk).replace(/\r/g, "\n")}`;
	const parts = text.split("\n");
	const complete = parts.slice(0, -1).map((line) => line.trimEnd());
	const remainder = parts.at(-1) ?? "";
	return { complete, remainder };
}

function updateActivityFromLines(run: PantheonRunSnapshot, state: RunStreamState, lines: string[]) {
	for (const line of lines) {
		const tool = line.match(/^\[tool\]\s+(.+?)(?:\s+\((completed|failed|pending|running)\))?$/);
		if (tool) {
			state.markerCount += 1;
			if (tool[2] === "completed" || tool[2] === "failed") state.toolCount += 1;
			run.currentTool = tool[1];
			run.currentActivity = `tool: ${tool[1]}${tool[2] ? ` (${tool[2]})` : ""}`;
			continue;
		}
		const thinking = line.match(/^\[thinking\]/);
		if (thinking) {
			state.markerCount += 1;
			state.turnCount += 1;
			run.currentActivity = "thinking…";
			continue;
		}
		const client = line.match(/^\[client\]\s+(.+?)(?:\s+\((.+?)\))?$/);
		if (client) {
			state.markerCount += 1;
			run.currentActivity = `client: ${client[1]}${client[2] ? ` (${client[2]})` : ""}`;
			continue;
		}
		if (/^\[done\]/.test(line)) state.markerCount += 1;
	}
	run.turnCount = state.turnCount;
	run.toolCount = state.toolCount;
	run.activitySeed = state.markerCount + (run.stdoutPreview?.length ?? 0) + (run.stderrPreview?.length ?? 0);
}

function flattenRuns(runs: PantheonRunSnapshot[]): PantheonRunSnapshot[] {
	return runs.flatMap((run) => [run, ...flattenRuns(run.children ?? [])]);
}

function summarizeWorkflowStatus(runs: PantheonRunSnapshot[]): PantheonWorkflowStatus {
	const allRuns = flattenRuns(runs);
	if (allRuns.some((run) => run.status === "running" || run.status === "queued")) return "running";
	if (allRuns.some((run) => run.status === "timeout")) return "timeout";
	if (allRuns.some((run) => run.status === "failed")) return "failed";
	if (allRuns.some((run) => run.status === "cancelled")) return "cancelled";
	return "completed";
}

export interface StartRunInput {
	workflowId?: string;
	mode?: PantheonWorkflowSnapshot["mode"];
	parentId?: string;
	agent: string;
	label?: string;
	runType: AcpxRunType;
	cwd: string;
	acpxBackend?: string;
	model?: string;
	acpxSessionName?: string;
	acpxSessionFile?: string;
	acpxSessionRecordId?: string;
	traceId?: string;
	spanId?: string;
	correlationId?: string;
	artifacts?: PantheonRunArtifacts;
}

export class PantheonWorkflowRegistry {
	private workflows = new Map<string, PantheonWorkflowSnapshot>();
	private streamStates = new Map<string, RunStreamState>();

	startRun(input: StartRunInput) {
		const now = Date.now();
		const workflowId = input.workflowId ?? nextId("wf");
		let workflow = this.workflows.get(workflowId);
		if (!workflow) {
			workflow = {
				id: workflowId,
				mode: input.mode ?? "single",
				status: "running",
				createdAt: now,
				updatedAt: now,
				runs: [],
			};
			this.workflows.set(workflowId, workflow);
		}

		const acpxSessionName =
			input.acpxSessionName ?? (input.runType === "session" ? `pantheon-${input.agent}` : undefined);
		const run: PantheonRunSnapshot = {
			id: nextId("run"),
			parentId: input.parentId,
			workflowId,
			agent: input.agent,
			label: input.label,
			status: "running",
			runType: input.runType,
			acpxBackend: input.acpxBackend,
			model: input.model,
			acpxSessionName,
			acpxSessionFile: input.acpxSessionFile,
			acpxSessionRecordId: input.acpxSessionRecordId,
			cwd: input.cwd,
			startedAt: now,
			updatedAt: now,
			currentActivity: "starting…",
			activitySeed: 0,
			traceId: input.traceId,
			spanId: input.spanId,
			correlationId: input.correlationId,
			artifacts: input.artifacts,
		};
		const parent = input.parentId ? this.findRun(input.parentId) : undefined;
		if (parent) parent.children = [...(parent.children ?? []), run];
		else workflow.runs.push(run);
		this.streamStates.set(run.id, {
			stdoutRemainder: "",
			stderrRemainder: "",
			markerCount: 0,
			turnCount: 0,
			toolCount: 0,
		});
		this.touchWorkflow(workflowId);
		return run;
	}

	updateStatus(runId: string, acpxStatus: AcpxStatus) {
		const run = this.findRun(runId);
		if (!run) return undefined;
		const next = mapAcpxStatus(acpxStatus);
		if (terminalStatuses.has(run.status)) return run;
		run.status = next;
		const now = Date.now();
		run.updatedAt = now;
		if (terminalStatuses.has(run.status)) run.completedAt = now;
		this.touchWorkflow(run.workflowId);
		return run;
	}

	appendOutput(runId: string, stream: "stdout" | "stderr", chunk: string) {
		const run = this.findRun(runId);
		if (!run) return undefined;
		const state = this.streamStates.get(runId) ?? {
			stdoutRemainder: "",
			stderrRemainder: "",
			markerCount: 0,
			turnCount: 0,
			toolCount: 0,
		};
		this.streamStates.set(runId, state);
		const previousRemainder = stream === "stdout" ? state.stdoutRemainder : state.stderrRemainder;
		const { complete, remainder } = splitCompleteLines(previousRemainder, chunk);
		if (stream === "stdout") {
			state.stdoutRemainder = remainder;
			run.stdoutPreview = appendPreviewLines(run.stdoutPreview, complete);
		} else {
			state.stderrRemainder = remainder;
			run.stderrPreview = appendPreviewLines(run.stderrPreview, complete);
		}
		updateActivityFromLines(run, state, complete);
		run.updatedAt = Date.now();
		this.touchWorkflow(run.workflowId);
		return run;
	}

	finishRun(runId: string, status: PantheonWorkflowStatus) {
		if (!terminalStatuses.has(status)) throw new Error(`finishRun requires a terminal status, got ${status}`);
		const run = this.findRun(runId);
		if (!run) return undefined;
		run.status = status;
		run.updatedAt = Date.now();
		run.completedAt = run.updatedAt;
		this.touchWorkflow(run.workflowId);
		return run;
	}

	setArtifacts(runId: string, artifacts: PantheonRunArtifacts) {
		const run = this.findRun(runId);
		if (run) run.artifacts = artifacts;
		return run;
	}

	setAcpxSessionFile(runId: string, sessionFile: string | undefined) {
		const run = this.findRun(runId);
		if (!run || !sessionFile) return run;
		run.acpxSessionFile = sessionFile;
		const match = sessionFile.match(/([^/]+)\.json$/);
		if (match) run.acpxSessionRecordId = match[1];
		run.updatedAt = Date.now();
		this.touchWorkflow(run.workflowId);
		return run;
	}

	snapshots() {
		return [...this.workflows.values()].map((workflow) => ({
			...workflow,
			runs: workflow.runs.map((run) => this.cloneRun(run)),
		}));
	}

	hasActiveRuns() {
		const hasActive = (run: PantheonRunSnapshot): boolean =>
			!terminalStatuses.has(run.status) || (run.children ?? []).some(hasActive);
		return this.snapshots().some((workflow) => workflow.runs.some(hasActive));
	}

	clearCompleted(maxAgeMs: number) {
		const now = Date.now();
		for (const [id, workflow] of this.workflows.entries()) {
			const runs = flattenRuns(workflow.runs);
			const terminal = runs.every((run) => terminalStatuses.has(run.status));
			const newestCompletion = Math.max(...runs.map((run) => run.completedAt ?? run.updatedAt));
			if (terminal && now - newestCompletion >= maxAgeMs) this.workflows.delete(id);
		}
	}

	reset() {
		this.workflows.clear();
		this.streamStates.clear();
	}

	private cloneRun(run: PantheonRunSnapshot): PantheonRunSnapshot {
		return {
			...run,
			artifacts: run.artifacts ? { ...run.artifacts } : undefined,
			stdoutPreview: run.stdoutPreview ? [...run.stdoutPreview] : undefined,
			stderrPreview: run.stderrPreview ? [...run.stderrPreview] : undefined,
			children: run.children?.map((child) => this.cloneRun(child)),
		};
	}

	private findRun(runId: string) {
		const findIn = (runs: PantheonRunSnapshot[]): PantheonRunSnapshot | undefined => {
			for (const run of runs) {
				if (run.id === runId) return run;
				const child = findIn(run.children ?? []);
				if (child) return child;
			}
			return undefined;
		};
		for (const workflow of this.workflows.values()) {
			const run = findIn(workflow.runs);
			if (run) return run;
		}
		return undefined;
	}

	private touchWorkflow(workflowId: string) {
		const workflow = this.workflows.get(workflowId);
		if (!workflow) return;
		workflow.updatedAt = Date.now();
		workflow.status = summarizeWorkflowStatus(workflow.runs);
	}
}

export const pantheonWorkflowRegistry = new PantheonWorkflowRegistry();
