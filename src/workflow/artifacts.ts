import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AcpxRunResult, AcpxRunType } from "../runner/index.ts";
import type { PantheonRunArtifacts, PantheonWorkflowStatus } from "./types.ts";

export const PANTHEON_ARTIFACT_SCHEMA_VERSION = 1;
const PREVIEW_LIMIT = 4000;
const SECRET_PATTERN =
	/(authorization\s*[:=]\s*bearer\s+\S+|bearer\s+\S+|api[\s_-]*key\s*[:=]\s*\S+|token\s*[:=]\s*\S+|cookie\s*[:=]\s*\S+|password\s*[:=]\s*\S+|secret\s*[:=]\s*\S+)/gi;
const SECRET_ARG_PATTERN = /^(--?(?:api[-_]?key|token|authorization|cookie|secret|password))(?:=.*)?$/i;

function writePrivateFile(filePath: string, content: string) {
	writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
	chmodSync(filePath, 0o600);
}

function defaultArtifactsRoot() {
	return process.env.PANTHEON_ARTIFACTS_DIR ?? path.join(os.homedir(), ".pi", "agent", "pantheon", "artifacts");
}

function dateSegment(now = new Date()) {
	return now.toISOString().slice(0, 10);
}

function safePathSegment(value: string) {
	return (
		value
			.replace(/[^a-zA-Z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 120) || "unknown"
	);
}

function requireArtifactId(label: "workflowId" | "runId", value: string) {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${label} is required for Pantheon run artifacts`);
	return trimmed;
}

export function redactText(value: string) {
	let redactionCount = 0;
	const redacted = value.replace(SECRET_PATTERN, (match) => {
		redactionCount += 1;
		const label = match.split(/\s|[:=]/)[0] || "secret";
		return `[REDACTED_${label.toUpperCase()}]`;
	});
	return { redacted, redactionCount };
}

export function redactArgv(args: string[]) {
	const redacted: string[] = [];
	const labels: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		const lower = arg.toLowerCase();
		if (lower === "--append-system-prompt") {
			redacted.push(arg, "[REDACTED_APPEND_SYSTEM_PROMPT]");
			labels.push("append-system-prompt");
			index += 1;
			continue;
		}
		const secretFlag = arg.match(SECRET_ARG_PATTERN);
		if (secretFlag) {
			redacted.push(`${secretFlag[1]}=[REDACTED_ARG]`);
			labels.push("secret-arg");
			if (!arg.includes("=") && index + 1 < args.length) index += 1;
			continue;
		}
		const { redacted: safe, redactionCount } = redactText(arg);
		if (redactionCount > 0) labels.push("secret-pattern");
		redacted.push(safe);
	}
	return { argv: redacted, redactions: labels };
}

export interface CreateArtifactsInput {
	workflowId: string;
	runId: string;
	agent: string;
	cwd: string;
	prompt: string;
	runType: AcpxRunType;
	acpxSessionName?: string;
	acpxSessionFile?: string;
	acpxSessionRecordId?: string;
	traceId?: string;
	spanId?: string;
	correlationId?: string;
	startedAt: number;
}

export function createRunArtifacts(input: CreateArtifactsInput): PantheonRunArtifacts {
	const workflowId = requireArtifactId("workflowId", input.workflowId);
	const runId = requireArtifactId("runId", input.runId);
	const dir = path.join(defaultArtifactsRoot(), dateSegment(), safePathSegment(workflowId), safePathSegment(runId));
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const artifacts = {
		dir,
		promptPath: path.join(dir, "prompt.md"),
		outputPath: path.join(dir, "output.md"),
		stderrPath: path.join(dir, "stderr.log"),
		metadataPath: path.join(dir, "metadata.json"),
		telemetryPath: path.join(dir, "telemetry.json"),
	};
	const prompt = redactText(input.prompt);
	writePrivateFile(artifacts.promptPath, prompt.redacted);
	writePrivateFile(artifacts.outputPath, "");
	writePrivateFile(artifacts.stderrPath, "");
	writePrivateFile(
		artifacts.telemetryPath,
		`${JSON.stringify(
			{
				schemaVersion: PANTHEON_ARTIFACT_SCHEMA_VERSION,
				pantheonWorkflowId: workflowId,
				pantheonRunId: runId,
				traceId: input.traceId,
				spanId: input.spanId,
				correlationId: input.correlationId,
				acpxSessionName: input.acpxSessionName,
				acpxSessionFile: input.acpxSessionFile,
				acpxSessionRecordId: input.acpxSessionRecordId,
			},
			null,
			2,
		)}\n`,
	);
	writePrivateFile(
		artifacts.metadataPath,
		`${JSON.stringify(
			{
				schemaVersion: PANTHEON_ARTIFACT_SCHEMA_VERSION,
				pantheonWorkflowId: workflowId,
				pantheonRunId: runId,
				agent: input.agent,
				cwd: input.cwd,
				acpxRunType: input.runType,
				acpxSessionName: input.acpxSessionName,
				acpxSessionFile: input.acpxSessionFile,
				acpxSessionRecordId: input.acpxSessionRecordId,
				startedAt: new Date(input.startedAt).toISOString(),
				traceId: input.traceId,
				spanId: input.spanId,
				correlationId: input.correlationId,
				artifacts,
				redactions: { prompt: prompt.redactionCount },
			},
			null,
			2,
		)}\n`,
	);
	return artifacts;
}

function statusFromResult(result: AcpxRunResult): PantheonWorkflowStatus {
	if (result.timedOut) return "timeout";
	if (result.aborted) return "cancelled";
	return result.success ? "completed" : "failed";
}

export interface FinalizeArtifactsInput extends CreateArtifactsInput {
	artifacts: PantheonRunArtifacts;
	result: AcpxRunResult;
	completedAt: number;
}

export function finalizeRunArtifacts(input: FinalizeArtifactsInput) {
	const workflowId = requireArtifactId("workflowId", input.workflowId);
	const runId = requireArtifactId("runId", input.runId);
	const output = redactText(input.result.fullTranscript || input.result.finalAnswer || "");
	const stderr = redactText(input.result.stderr ?? "");
	const argv = redactArgv(input.result.args);
	const status = statusFromResult(input.result);
	writePrivateFile(input.artifacts.outputPath, output.redacted);
	writePrivateFile(input.artifacts.stderrPath, stderr.redacted);
	const metadata = {
		schemaVersion: PANTHEON_ARTIFACT_SCHEMA_VERSION,
		pantheonWorkflowId: workflowId,
		pantheonRunId: runId,
		agent: input.agent,
		cwd: input.cwd,
		command: {
			binary: path.basename(input.result.command),
			argvShape: argv.argv,
		},
		acpxRunType: input.runType,
		acpxBackend: "acpx",
		acpxSessionName: input.acpxSessionName,
		acpxSessionFile: input.acpxSessionFile,
		acpxSessionRecordId: input.acpxSessionRecordId,
		startedAt: new Date(input.startedAt).toISOString(),
		completedAt: new Date(input.completedAt).toISOString(),
		durationMs: input.result.durationMs,
		status,
		exitCode: input.result.exitCode,
		signal: input.result.signal,
		timedOut: input.result.timedOut,
		aborted: input.result.aborted,
		error: input.result.error,
		traceId: input.traceId,
		spanId: input.spanId,
		correlationId: input.correlationId,
		promptPreview: redactText(input.prompt).redacted.slice(0, PREVIEW_LIMIT),
		outputPreview: output.redacted.slice(0, PREVIEW_LIMIT),
		stderrPreview: stderr.redacted.slice(0, PREVIEW_LIMIT),
		artifacts: input.artifacts,
		redactions: {
			argv: argv.redactions,
			output: output.redactionCount,
			stderr: stderr.redactionCount,
		},
	};
	writePrivateFile(input.artifacts.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
	return metadata;
}
