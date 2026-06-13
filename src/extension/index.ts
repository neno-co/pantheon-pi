import {
	appendFileSync,
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	getMarkdownTheme,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getAcpxBackend, PANTHEON_AGENTS } from "../agents.ts";
import {
	endMainAgentTrace,
	endMainToolSpan,
	endMainTurn,
	getCurrentMainTraceState,
	startMainAgentTrace,
	startMainToolSpan,
	startMainTurn,
} from "../langwatch/index.ts";
import { DEFAULT_ACPX_BIN, resolveAcpxBinary, runAcpx } from "../runner/index.ts";
import {
	createRunArtifacts,
	finalizeRunArtifacts,
	findAcpxSessionFileByName,
	PantheonAgentExplorer,
	type PantheonWorkflowStatus,
	pantheonWorkflowRegistry,
	renderPantheonWorkflows,
	sanitizeAcpxSessionName,
} from "../workflow/index.ts";
import {
	applyHashlineEdit,
	computeHashlines,
	formatDiagnostics,
	resolveInsideCwd,
	runBoundedCommand,
	runDiagnostics,
	structuralReplace,
	structuralSearch,
} from "./pantheon-tooling/index.ts";

function readContextString(ctx: unknown, keys: string[]) {
	if (typeof ctx !== "object" || ctx === null) return undefined;
	const record = ctx as Record<string, unknown>;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	const trace = record.trace;
	if (typeof trace === "object" && trace !== null) {
		const traceRecord = trace as Record<string, unknown>;
		for (const key of keys) {
			const value = traceRecord[key];
			if (typeof value === "string" && value.length > 0) return value;
		}
	}
	return undefined;
}

function getSessionManager(ctx: unknown) {
	if (typeof ctx !== "object" || ctx === null) return undefined;
	return (
		ctx as { sessionManager?: { getSessionFile?: () => string | undefined; getLeafId?: () => string | undefined } }
	).sessionManager;
}

async function openPantheonAgentExplorer(ctx: {
	hasUI?: boolean;
	ui: {
		custom: <T>(
			factory: (
				tui: { requestRender: () => void },
				theme: unknown,
				keybindings: unknown,
				done: (value: T) => void,
			) => unknown,
			options?: unknown,
		) => Promise<T>;
	};
}) {
	if (!ctx.hasUI) return;
	let timer: ReturnType<typeof setInterval> | undefined;
	await ctx.ui
		.custom<void>(
			(tui, _theme, _keybindings, done) => {
				const explorer = new PantheonAgentExplorer(() => pantheonWorkflowRegistry.snapshots(), {
					onClose: () => done(undefined),
					requestRender: () => tui.requestRender(),
				});
				timer = setInterval(() => tui.requestRender(), 1000);
				timer.unref?.();
				return explorer;
			},
			{
				overlay: true,
				overlayOptions: {
					width: "95%",
					minWidth: 80,
					maxHeight: "90%",
					margin: 1,
				},
			},
		)
		.finally(() => {
			if (timer) clearInterval(timer);
		});
}

function getSessionFilePath(ctx: unknown) {
	return getSessionManager(ctx)?.getSessionFile?.();
}

function getSessionKey(ctx: unknown) {
	const sessionManager = getSessionManager(ctx);
	return sessionManager?.getSessionFile?.() ?? sessionManager?.getLeafId?.();
}

export interface CanonicalTelemetryHeaderInput {
	traceId?: string;
	spanId?: string;
	sessionHash?: string;
	correlationId?: string;
	startedAt?: number;
	agentName?: string;
}

export interface TelemetryHeaderOptions {
	homeDir?: string;
	safeRoots?: string[];
}

const TELEMETRY_HEADER_TYPE = "pantheon_telemetry_header";
const TELEMETRY_HEADER_EVENT = "pantheon.telemetry.header";
const TELEMETRY_HEADER_SCHEMA_VERSION = 1;
const TELEMETRY_HEADER_SCAN_BYTES = 64 * 1024;

function debugTelemetryHeaderWarning(message: string) {
	if (process.env.PANTHEON_TELEMETRY_DEBUG === "true") {
		console.warn(`Pantheon telemetry header skipped: ${message}`);
	}
}

function canonicalPath(value: string) {
	return path.resolve(value);
}

function defaultTelemetrySessionRoots(homeDir = os.homedir()) {
	return [path.join(homeDir, ".pi/agent/sessions"), path.join(homeDir, ".acpx/sessions")];
}

function realPathForSafety(targetPath: string) {
	try {
		if (existsSync(targetPath)) return realpathSync(targetPath);
		const parent = path.dirname(targetPath);
		if (!existsSync(parent)) return canonicalPath(targetPath);
		return path.join(realpathSync(parent), path.basename(targetPath));
	} catch {
		return canonicalPath(targetPath);
	}
}

function isPathInsideRoot(targetPath: string, rootPath: string) {
	const relative = path.relative(rootPath, targetPath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isSafeTelemetrySessionFile(sessionFile: string | undefined, options: TelemetryHeaderOptions = {}) {
	if (!sessionFile || !path.isAbsolute(sessionFile) || path.extname(sessionFile) !== ".jsonl") return false;
	const targetPath = realPathForSafety(sessionFile);
	const roots = (options.safeRoots ?? defaultTelemetrySessionRoots(options.homeDir)).map(realPathForSafety);
	return roots.some((root) => isPathInsideRoot(targetPath, root));
}

function telemetryAgentRole(agentName: string) {
	if (agentName === "athena") return "primary-builder-orchestrator";
	if (agentName === "zeus") return "orchestrator";
	return "specialist";
}

function mainAgentName(value?: string) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : "athena";
}

export function buildCanonicalTelemetryHeader(input: CanonicalTelemetryHeaderInput) {
	if (!input.traceId || !input.correlationId || !input.sessionHash) return undefined;
	const agentName = mainAgentName(input.agentName ?? process.env.PANTHEON_MAIN_AGENT);
	return {
		type: TELEMETRY_HEADER_TYPE,
		event: TELEMETRY_HEADER_EVENT,
		kind: "telemetry_metadata",
		schema_version: TELEMETRY_HEADER_SCHEMA_VERSION,
		trace_id: input.traceId,
		correlation_id: input.correlationId,
		session_id_hash: input.sessionHash,
		...(input.spanId ? { span_id: input.spanId } : {}),
		agent_name: agentName,
		agent_role: telemetryAgentRole(agentName),
		started_at: new Date(input.startedAt ?? Date.now()).toISOString(),
	};
}

function readTelemetryHeaderScanWindow(sessionFile: string) {
	const stats = statSync(sessionFile);
	if (stats.size <= TELEMETRY_HEADER_SCAN_BYTES * 2) return readFileSync(sessionFile, "utf8");
	const fd = openSync(sessionFile, "r");
	try {
		const head = Buffer.alloc(TELEMETRY_HEADER_SCAN_BYTES);
		const tail = Buffer.alloc(TELEMETRY_HEADER_SCAN_BYTES);
		const headBytes = readSync(fd, head, 0, TELEMETRY_HEADER_SCAN_BYTES, 0);
		const tailBytes = readSync(fd, tail, 0, TELEMETRY_HEADER_SCAN_BYTES, stats.size - TELEMETRY_HEADER_SCAN_BYTES);
		return `${head.subarray(0, headBytes).toString("utf8")}\n${tail.subarray(0, tailBytes).toString("utf8")}`;
	} finally {
		closeSync(fd);
	}
}

function hasCanonicalTelemetryHeader(sessionFile: string, header: ReturnType<typeof buildCanonicalTelemetryHeader>) {
	if (!header || !existsSync(sessionFile)) return false;
	const window = readTelemetryHeaderScanWindow(sessionFile);
	for (const line of window.split("\n")) {
		if (!line.includes(TELEMETRY_HEADER_TYPE) && !line.includes(TELEMETRY_HEADER_EVENT)) continue;
		try {
			const row = JSON.parse(line) as Record<string, unknown>;
			if (
				(row.type === TELEMETRY_HEADER_TYPE || row.event === TELEMETRY_HEADER_EVENT) &&
				row.trace_id === header.trace_id &&
				row.correlation_id === header.correlation_id &&
				row.session_id_hash === header.session_id_hash
			)
				return true;
		} catch {
			// Ignore malformed rows while scanning for idempotency.
		}
	}
	return false;
}

export function appendCanonicalTelemetryHeader(
	sessionFile: string | undefined,
	input: CanonicalTelemetryHeaderInput,
	options: TelemetryHeaderOptions = {},
) {
	try {
		if (!isSafeTelemetrySessionFile(sessionFile, options)) {
			debugTelemetryHeaderWarning("session file path is outside known safe roots or is not an absolute .jsonl path");
			return false;
		}
		const header = buildCanonicalTelemetryHeader(input);
		if (!header) {
			debugTelemetryHeaderWarning("trace state is missing canonical triple fields");
			return false;
		}
		// Never create Pi's session file ourselves. Pi 0.78+ flushes the session transcript
		// lazily with an exclusive `openSync(file, "wx")`; if we pre-create the file via
		// appendFileSync, that flush throws EEXIST. Only annotate a session file that Pi has
		// already created — the ingest scanner finds the header regardless of its line position.
		if (!existsSync(sessionFile)) {
			debugTelemetryHeaderWarning("session file does not exist yet; deferring header until Pi creates it");
			return false;
		}
		if (hasCanonicalTelemetryHeader(sessionFile, header)) return false;
		appendFileSync(sessionFile, `${JSON.stringify(header)}\n`, { encoding: "utf8" });
		return true;
	} catch (error) {
		debugTelemetryHeaderWarning(error instanceof Error ? error.message : String(error));
		return false;
	}
}

function summarizeEventOutput(event: unknown) {
	if (typeof event !== "object" || event === null) return String(event ?? "");
	const record = event as Record<string, unknown>;
	for (const key of ["message", "messages", "toolResults", "result"]) {
		const value = record[key];
		if (value !== undefined) return typeof value === "string" ? value : JSON.stringify(value);
	}
	return JSON.stringify(record);
}

function summarizeEventError(event: unknown) {
	if (typeof event !== "object" || event === null) return undefined;
	const record = event as Record<string, unknown>;
	return record.isError === true ? summarizeEventOutput(event) : undefined;
}

function readToolInputPath(input: unknown) {
	if (typeof input !== "object" || input === null) return undefined;
	const record = input as Record<string, unknown>;
	for (const key of ["path", "filePath", "targetPath"]) {
		const value = record[key];
		if (typeof value === "string") return value;
	}
	return undefined;
}

function resultText(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text", text }], details };
}

function schedulePostRunTelemetryIngest() {
	// Telemetry ingest depends on bun:sqlite and only runs under the Bun runtime.
	// Pi loads this extension under Node, where importing the ingest module would crash.
	const isBun = typeof process.versions === "object" && typeof process.versions.bun === "string";
	if (!isBun) {
		if (process.env.PANTHEON_TELEMETRY_DEBUG === "true") {
			console.warn("Pantheon telemetry post-run ingest skipped: requires Bun runtime (bun:sqlite).");
		}
		return;
	}

	const run = async () => {
		try {
			const { ingestTelemetry } = await import("../telemetry/ingest/index.ts");
			await ingestTelemetry({ source: "all" });
		} catch (error) {
			if (process.env.PANTHEON_TELEMETRY_DEBUG === "true") {
				const message = error instanceof Error ? error.message : String(error);
				console.warn(`Pantheon telemetry post-run ingest failed: ${message}`);
			}
		}
	};

	// best-effort post-run ingest must never block or hard-fail agent exit.
	const timer = setTimeout(() => void run(), 0);
	timer.unref?.();
}

let processTelemetryIngestHookRegistered = false;

function registerProcessTelemetryIngestHook() {
	if (processTelemetryIngestHookRegistered) return;
	processTelemetryIngestHookRegistered = true;
	process.once("beforeExit", schedulePostRunTelemetryIngest);
}

export default function registerPantheonExtension(pi: ExtensionAPI) {
	registerProcessTelemetryIngestHook();
	// Pi creates its session .jsonl lazily and flushes it with an exclusive `openSync(file, "wx")`.
	// We must not write the canonical telemetry header until Pi has created that file, or the flush
	// throws EEXIST (see pantheon-pi-0tr). We capture the header + stable session path in
	// before_agent_start (where ctx is guaranteed) and flush, best-effort, once the file exists.
	let pendingTelemetryHeader: CanonicalTelemetryHeaderInput | undefined;
	let pendingTelemetrySessionFile: string | undefined;
	let telemetryHeaderResolved = false;

	function flushPendingTelemetryHeader() {
		if (telemetryHeaderResolved || !pendingTelemetryHeader || !pendingTelemetrySessionFile) return;
		// existsSync gate: only annotate after Pi's first flush has created the file.
		if (!existsSync(pendingTelemetrySessionFile)) return;
		appendCanonicalTelemetryHeader(pendingTelemetrySessionFile, pendingTelemetryHeader);
		telemetryHeaderResolved = true;
		pendingTelemetryHeader = undefined;
	}

	pi.on("before_agent_start", async (event, ctx) => {
		const agentName = mainAgentName(process.env.PANTHEON_MAIN_AGENT);
		const traceState = await startMainAgentTrace({
			prompt: typeof event.prompt === "string" ? event.prompt : JSON.stringify(event.prompt ?? ""),
			sessionId: getSessionKey(ctx),
			cwd: ctx.cwd,
			source: "pi.before_agent_start",
			agentId: agentName,
		});
		if (traceState) {
			pendingTelemetryHeader = {
				traceId: traceState.traceId,
				spanId: traceState.spanId,
				sessionHash: traceState.sessionHash,
				correlationId: traceState.correlationId,
				startedAt: traceState.startedAt,
				agentName: traceState.agentId,
			};
			pendingTelemetrySessionFile = getSessionFilePath(ctx);
			telemetryHeaderResolved = false;
			// Resumed sessions already have a file on disk — try immediately; otherwise defer.
			flushPendingTelemetryHeader();
		}
	});

	pi.on("turn_start", async (event) => {
		startMainTurn({ turnIndex: event.turnIndex, timestamp: event.timestamp });
	});

	pi.on("tool_execution_start", async (event) => {
		startMainToolSpan({ toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
	});

	pi.on("tool_execution_end", async (event) => {
		endMainToolSpan({ toolCallId: event.toolCallId, result: event.result, isError: event.isError });
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError || !["write", "edit"].includes(event.toolName)) return;
		const targetPath = readToolInputPath(event.input);
		const diagnostics = await runDiagnostics(ctx.cwd, targetPath, 20_000);
		const existing = Array.isArray(event.content) ? event.content : [];
		return {
			content: [...existing, { type: "text", text: `\n\n${formatDiagnostics(diagnostics)}` }],
			details: { ...(event.details ?? {}), pantheonDiagnostics: diagnostics },
		};
	});

	pi.on("turn_end", async (event) => {
		// By turn_end Pi has written at least one assistant message, so its session file exists.
		flushPendingTelemetryHeader();
		endMainTurn(summarizeEventOutput(event), summarizeEventError(event));
	});

	pi.on("agent_end", async (event) => {
		// Final attempt before post-run ingest reads the session files.
		flushPendingTelemetryHeader();
		await endMainAgentTrace(summarizeEventOutput(event));
		schedulePostRunTelemetryIngest();
	});

	pi.registerTool({
		name: "code_exec",
		label: "Code Exec",
		description:
			"Run a bounded shell command from the current workspace. Uses cwd confinement, timeout, stdout/stderr truncation, and explicit tool-call visibility.",
		promptSnippet: "Execute bounded local commands with timeout and truncated stdout/stderr",
		promptGuidelines: [
			"Use code_exec for small, explicit local checks or scripts when the user has allowed command execution.",
			"Set cwd to a subdirectory of the session cwd only; commands outside the workspace are rejected.",
			"Prefer focused commands and modest timeouts; this tool is not a background job runner.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to execute via bash -lc." }),
			cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to Pi's cwd; must stay inside it." })),
			timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 300, description: "Default 30." })),
			maxBytes: Type.Optional(
				Type.Integer({ minimum: 1024, maximum: 200000, description: "Per-stream truncation cap." }),
			),
		}),
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("code_exec"))} ${theme.fg("muted", args.command)}`, 0, 0);
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cwd = resolveInsideCwd(ctx.cwd, params.cwd ?? ".");
			const result = await runBoundedCommand({
				command: params.command,
				cwd,
				timeoutSeconds: params.timeoutSeconds,
				maxBytes: params.maxBytes,
				signal,
			});
			const text = [
				`exitCode: ${result.exitCode}${result.timedOut ? " (timeout)" : ""}${result.truncated ? " (truncated)" : ""}`,
				result.stdout ? `stdout:\n${result.stdout}` : "stdout: (empty)",
				result.stderr ? `stderr:\n${result.stderr}` : "stderr: (empty)",
			].join("\n\n");
			return resultText(text, { ...result, cwd });
		},
	});

	pi.registerTool({
		name: "hashline",
		label: "Hashline",
		description:
			"Preview line content hashes or edit lines only when expected hashes match current content. Detects stale context before writing.",
		promptSnippet: "Use hashline to list per-line hashes and apply stale-safe line edits by expected hash",
		promptGuidelines: [
			"First call action=list for the target file and capture the line hashes you intend to edit.",
			"Call action=apply with line, expectedHash, and newText. The tool refuses all edits if any hash is stale.",
			"Successful writes run post-write diagnostics when a strategy is available.",
		],
		parameters: Type.Object({
			action: StringEnum(["list", "apply"] as const, { description: "List hashes or apply stale-safe edits." }),
			path: Type.String({ description: "File path relative to cwd." }),
			edits: Type.Optional(
				Type.Array(
					Type.Object({
						line: Type.Integer({ minimum: 1 }),
						expectedHash: Type.String(),
						newText: Type.String(),
					}),
				),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const filePath = resolveInsideCwd(ctx.cwd, params.path);
			if (params.action === "list") {
				const lines = await computeHashlines(filePath);
				return resultText(lines.map((line) => `${line.line}:${line.hash}: ${line.text}`).join("\n"), { lines });
			}
			const edits = params.edits ?? [];
			const result = await applyHashlineEdit({ cwd: ctx.cwd, path: params.path, edits });
			if (!result.applied)
				return resultText(`Hashline edit refused: stale context\n${JSON.stringify(result.stale, null, 2)}`, result);
			const diagnostics = await runDiagnostics(ctx.cwd, params.path);
			return resultText(`Hashline edit applied.\n\n${formatDiagnostics(diagnostics)}`, { ...result, diagnostics });
		},
	});

	pi.registerTool({
		name: "structural_search",
		label: "Structural Search",
		description:
			"Pantheon-Pi bundled ast-grep structural search and replacement for supported code files. Supports $CAPTURE metavariables, search, dry-run replacement, and optional controlled writes.",
		promptSnippet: "Search or rewrite code structurally with ast-grep $CAPTURE metavariables; dry-run by default",
		promptGuidelines: [
			"Use action=search to inspect matches. Patterns support uppercase metavariables like console.log($ARG).",
			"Use action=replace with rewrite and dryRun=true first. Set dryRun=false only for intended writes.",
			"Successful replacements run post-write diagnostics when a strategy is available.",
		],
		parameters: Type.Object({
			action: StringEnum(["search", "replace"] as const),
			paths: Type.Array(Type.String(), { description: "Files or directories relative to cwd." }),
			pattern: Type.String({ description: "Structural pattern with optional $CAPTURE metavariables." }),
			rewrite: Type.Optional(Type.String({ description: "Replacement template for action=replace." })),
			dryRun: Type.Optional(Type.Boolean({ description: "Defaults true for replace." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.action === "search") {
				const matches = await structuralSearch({ cwd: ctx.cwd, paths: params.paths, pattern: params.pattern });
				return resultText(JSON.stringify(matches, null, 2), { matches });
			}
			if (!params.rewrite) throw new Error("rewrite is required for structural replacement");
			const dryRun = params.dryRun !== false;
			const result = await structuralReplace({
				cwd: ctx.cwd,
				paths: params.paths,
				pattern: params.pattern,
				rewrite: params.rewrite,
				dryRun,
			});
			const diagnostics = dryRun ? undefined : await runDiagnostics(ctx.cwd);
			const text = [`changedFiles: ${result.changedFiles.length}`, JSON.stringify(result.changedFiles, null, 2)]
				.concat(diagnostics ? [`\n${formatDiagnostics(diagnostics)}`] : [])
				.join("\n");
			return resultText(text, { ...result, diagnostics });
		},
	});

	pi.registerTool({
		name: "acpx",
		label: "ACPX",
		description:
			"Run an external ACP agent through acpx and return its final answer. Shows a live Subagent widget in Pi while the agent runs; the model only receives the final tool result, not the live stream. Output is truncated to 50KB/2000 lines.",
		promptSnippet: "Delegate a prompt to another ACP agent via acpx with a live Subagent widget",
		promptGuidelines: [
			"Use acpx when the user asks to consult or delegate to another agent, or when a specialized acpx agent such as codebase-locator/codebase-analyzer would help.",
			"Do not use acpx with the pi agent from inside Pi; that can recursively invoke Pi.",
		],
		parameters: Type.Object({
			agent: StringEnum(PANTHEON_AGENTS, {
				description: "The acpx agent to run. Prefer specialized agents for specialized tasks.",
			}),
			prompt: Type.String({ description: "Prompt to send to the selected ACP agent." }),
			cwd: Type.Optional(
				Type.String({ description: "Working directory for the delegated agent. Defaults to Pi's cwd." }),
			),
			model: Type.Optional(Type.String({ description: "Optional model id passed to acpx." })),
			runType: Type.Optional(
				StringEnum(["exec", "session"] as const, {
					description:
						"Execution mode. Defaults to session (stateful, resumable). Use exec only for one-shot stateless lookups that do not need resume.",
				}),
			),
			sessionId: Type.Optional(
				Type.String({
					description:
						"Named acpx session id for runType=session. Convention: <bead-id>-<agent>-<purpose> (e.g. neo-42-vulkanus-impl). Omit to generate a unique per-task id automatically.",
				}),
			),
			maxTurns: Type.Optional(
				Type.Integer({
					minimum: 1,
					description:
						"Optional maximum turns forwarded to acpx. Omit for implementation/grading agents (vulkanus, dike, argus, prometheus) — rely on timeoutSeconds instead. Only set low caps (<30) for scoped read-only lookups.",
				}),
			),
			permissions: Type.Optional(
				StringEnum(["deny-all", "approve-reads", "approve-all"] as const, {
					description:
						"Permission policy for delegated agent. Pantheon Claude Code agents run approve-all unless explicitly set to deny-all; other agents default to approve-reads.",
				}),
			),
			timeoutSeconds: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 1800,
					description: "Maximum wall-clock seconds. Defaults to agent config (Oracle: 600, otherwise 300).",
				}),
			),
			ttlSeconds: Type.Optional(
				Type.Integer({
					minimum: 0,
					maximum: 86400,
					description: "acpx session/queue idle TTL in seconds. 0 keeps alive.",
				}),
			),
		}),
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("acpx"))} ${theme.fg("muted", args.agent)} ${theme.fg("dim", args.runType ?? "exec")}`,
				0,
				0,
			);
		},
		renderResult(result, _options, _theme) {
			const text = result.content.find((part) => part.type === "text")?.text ?? "(no output)";
			return new Markdown(text, 0, 0, getMarkdownTheme());
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cwd = params.cwd ?? ctx.cwd;
			const mainTrace = getCurrentMainTraceState();
			const traceId = mainTrace?.traceId ?? readContextString(ctx, ["traceId", "trace_id"]);
			const parentSpanId =
				mainTrace?.turnSpan?.spanContext().spanId ??
				mainTrace?.spanId ??
				readContextString(ctx, ["parentSpanId", "parent_span_id"]);
			const requestedSessionId = params.sessionId;
			const runType = params.runType ?? "session";
			const sessionId = runType === "session" ? sanitizeAcpxSessionName(params.agent, requestedSessionId) : undefined;
			const acpxSessionName = runType === "session" ? sessionId : undefined;
			const startedAt = Date.now();
			const backend = getAcpxBackend(params.agent);
			const model = params.model ?? backend.model;
			let lastUiUpdate = 0;
			const run = pantheonWorkflowRegistry.startRun({
				agent: params.agent,
				runType,
				cwd,
				acpxBackend: "acpx",
				model,
				acpxSessionName,
				traceId,
				spanId: parentSpanId,
				correlationId: mainTrace?.correlationId,
			});
			const artifacts = createRunArtifacts({
				workflowId: run.workflowId,
				runId: run.id,
				agent: params.agent,
				cwd,
				prompt: params.prompt,
				runType,
				acpxSessionName,
				traceId,
				spanId: parentSpanId,
				correlationId: mainTrace?.correlationId,
				startedAt,
			});
			pantheonWorkflowRegistry.setArtifacts(run.id, artifacts);

			const updateUi = (status?: Parameters<typeof pantheonWorkflowRegistry.updateStatus>[1]) => {
				if (status) pantheonWorkflowRegistry.updateStatus(run.id, status);
				if (!ctx.hasUI) return;
				const now = Date.now();
				if (now - lastUiUpdate < 250 && (!status || status === "running")) return;
				lastUiUpdate = now;

				const snapshots = pantheonWorkflowRegistry.snapshots();
				const flatten = (runs: (typeof snapshots)[number]["runs"]): (typeof snapshots)[number]["runs"] =>
					runs.flatMap((snapshot) => [snapshot, ...flatten(snapshot.children ?? [])]);
				const active = snapshots
					.flatMap((snapshot) => flatten(snapshot.runs))
					.filter((snapshot) => snapshot.status === "running").length;
				ctx.ui.setStatus("acpx", active > 0 ? `${active} acpx run${active === 1 ? "" : "s"}` : "acpx complete");
				ctx.ui.setWidget(
					"acpx",
					() => ({
						render: (width: number) =>
							renderPantheonWorkflows(snapshots, {
								width,
								expanded: ctx.ui.getToolsExpanded?.() ?? false,
							}),
						invalidate: () => {},
					}),
					{ placement: "aboveEditor" },
				);
			};
			updateUi("starting");

			const result = await runAcpx({
				agent: params.agent,
				prompt: params.prompt,
				cwd,
				traceId,
				parentSpanId,
				runType,
				sessionId,
				model,
				maxTurns: params.maxTurns,
				permissions: params.permissions,
				timeoutSeconds: params.timeoutSeconds,
				ttlSeconds: params.ttlSeconds,
				signal,
				onOutput: (stream, chunk) => {
					pantheonWorkflowRegistry.appendOutput(run.id, stream, chunk);
					updateUi();
				},
				onStatus: updateUi,
			});
			const isMaxTurns =
				!result.success &&
				!result.timedOut &&
				!result.aborted &&
				/Reached maximum number of turns/i.test(`${result.stderr}\n${result.stdout}`);
			const finalStatus: PantheonWorkflowStatus = result.timedOut
				? "timeout"
				: result.aborted
					? "cancelled"
					: result.needsAttention || isMaxTurns
						? "needs_attention"
						: result.success
							? "completed"
							: "failed";
			pantheonWorkflowRegistry.finishRun(run.id, finalStatus);
			const acpxSessionFile = acpxSessionName ? findAcpxSessionFileByName(acpxSessionName) : undefined;
			pantheonWorkflowRegistry.setAcpxSessionFile(run.id, acpxSessionFile);
			const acpxSessionRecordId = acpxSessionFile?.match(/([^/]+)\.json$/)?.[1];
			finalizeRunArtifacts({
				workflowId: run.workflowId,
				runId: run.id,
				agent: params.agent,
				cwd,
				prompt: params.prompt,
				runType,
				acpxSessionName,
				acpxSessionFile,
				acpxSessionRecordId,
				traceId,
				spanId: parentSpanId,
				correlationId: mainTrace?.correlationId,
				startedAt,
				artifacts,
				result,
				completedAt: Date.now(),
			});
			updateUi();

			const truncated = truncateTail(result.finalAnswer, {
				maxBytes: DEFAULT_MAX_BYTES,
				maxLines: DEFAULT_MAX_LINES,
			});

			let text = truncated.content || "(no output)";
			text += `\n\nArtifacts: ${artifacts.dir}`;
			if (truncated.truncated) {
				text += `\n\n[Output truncated: ${truncated.outputLines} of ${truncated.totalLines} lines (${formatSize(
					truncated.outputBytes,
				)} of ${formatSize(truncated.totalBytes)}).]`;
			}

			if (ctx.hasUI) {
				setTimeout(() => {
					if (pantheonWorkflowRegistry.hasActiveRuns()) return;
					ctx.ui.setStatus("acpx", undefined);
					ctx.ui.setWidget("acpx", undefined);
				}, 2000);
			}

			if (!result.success) {
				const exitInfo = `acpx exited with code ${result.exitCode}${result.signal ? ` signal ${result.signal}` : ""}${
					result.timedOut ? " (timeout)" : ""
				}${result.aborted ? " (aborted)" : ""}${isMaxTurns ? " (max_turns)" : ""}${result.error ? `\n${result.error}` : ""}`;
				const resumeLines: string[] = [];
				if (runType === "session" && sessionId) {
					resumeLines.push(`Session-id: ${sessionId}`);
					if (acpxSessionFile) resumeLines.push(`Session-file: ${acpxSessionFile}`);
					resumeLines.push(
						`Resumable: call acpx again with runType=session, sessionId=${sessionId}, prompt="Continue from where you left off."`,
					);
				}
				throw new Error([exitInfo, text, ...resumeLines].filter(Boolean).join("\n"));
			}

			return {
				content: [{ type: "text", text }],
				details: {
					command: result.command,
					args: result.args,
					exitCode: result.exitCode,
					signal: result.signal,
					timedOut: result.timedOut,
					aborted: result.aborted,
					truncated: truncated.truncated,
					fullTranscript: result.fullTranscript,
					durationMs: result.durationMs,
					acpxSessionFile,
					acpxSessionRecordId,
				},
			};
		},
	});

	pi.registerCommand("acpx-monitor", {
		description: "Open the Pantheon ACPX Agent Explorer overlay",
		handler: async (_args, ctx) => openPantheonAgentExplorer(ctx),
	});

	pi.registerShortcut("ctrl+0", {
		description: "Open Pantheon Agent Explorer",
		handler: async (ctx) => openPantheonAgentExplorer(ctx),
	});

	pi.registerCommand("acpx", {
		description: "Show acpx path and usage hint",
		handler: async (_args, ctx) => {
			const command = resolveAcpxBinary();
			const pathNote = command === "acpx" ? `${DEFAULT_ACPX_BIN} not found; falling back to PATH` : command;
			ctx.ui.notify(
				`acpx: ${pathNote}. Tool registered as acpx with live Subagent widget. Use /reload if just installed.`,
				"info",
			);
		},
	});
}
