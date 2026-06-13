import type { AcpxRunType } from "../runner/index.ts";

export type PantheonWorkflowStatus =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "timeout"
	| "cancelled"
	| "needs_attention";

export interface PantheonRunArtifacts {
	dir: string;
	promptPath: string;
	outputPath: string;
	stderrPath: string;
	metadataPath: string;
	telemetryPath: string;
}

export interface PantheonRunSnapshot {
	id: string;
	parentId?: string;
	workflowId: string;
	agent: string;
	label?: string;
	status: PantheonWorkflowStatus;
	runType: AcpxRunType;
	acpxBackend?: string;
	model?: string;
	acpxSessionName?: string;
	acpxSessionFile?: string;
	acpxSessionRecordId?: string;
	cwd: string;
	startedAt: number;
	updatedAt: number;
	completedAt?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentActivity?: string;
	turnCount?: number;
	toolCount?: number;
	tokenCount?: number;
	activitySeed?: number;
	stdoutPreview?: string[];
	stderrPreview?: string[];
	sessionName?: string;
	sessionFile?: string;
	traceId?: string;
	spanId?: string;
	correlationId?: string;
	depth?: number;
	artifacts?: PantheonRunArtifacts;
	children?: PantheonRunSnapshot[];
}

export interface PantheonWorkflowSnapshot {
	id: string;
	mode: "single" | "parallel" | "chain" | "review-loop" | "ad-hoc";
	status: PantheonWorkflowStatus;
	createdAt: number;
	updatedAt: number;
	runs: PantheonRunSnapshot[];
}
