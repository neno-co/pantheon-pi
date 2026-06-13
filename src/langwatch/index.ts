import { createHash, randomUUID } from "node:crypto";
import {
	type Attributes,
	type Context,
	context,
	propagation,
	type Span,
	SpanKind,
	SpanStatusCode,
	trace,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
	BasicTracerProvider,
	BatchSpanProcessor,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { SEMRESATTRS_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { AcpxRunRequest, AcpxRunResult } from "../runner/index.ts";

export const DEFAULT_LANGWATCH_ENDPOINT = "https://app.langwatch.ai";
const DEFAULT_SERVICE_NAME = "pantheon-pi";
const TRACER_NAME = "pantheon-pi-langwatch";
const MAX_TRANSCRIPT_CHILD_SPANS = 300;
const DEFAULT_FLUSH_TIMEOUT_MS = 5000;

type EnvLike = Record<string, string | undefined>;
type AttributeValue = string | number | boolean;
type PantheonAttributes = Record<string, AttributeValue>;
type RedactionStyle = "hash" | "summary";

type SpanStatusDecision = { code: "OK" } | { code: "ERROR"; message: string };

const secretRedactionPatterns: Array<[RegExp, string]> = [
	[/\b(Authorization\s*:\s*Bearer\s+)[^\s\r\n]+/gi, "$1[REDACTED]"],
	[
		/\b((?:LANGWATCH|OPENAI|ANTHROPIC|GOOGLE|GITHUB|SLACK|LINEAR|PANTHEON)?_?API_?KEY\s*=\s*)[^\s\r\n]+/gi,
		"$1[REDACTED]",
	],
	[/\b((?:api[_-]?key|token|secret|password)\s*[:=]\s*)["']?[^"'\s,}]+["']?/gi, "$1[REDACTED]"],
];

export type AcpxTranscriptEventKind = "thinking" | "tool" | "client" | "done";

export interface AcpxTranscriptEvent {
	kind: AcpxTranscriptEventKind;
	index: number;
	line: string;
	label: string;
}

export interface LangWatchConfig {
	enabled: boolean;
	apiKey?: string;
	endpoint: string;
	captureContent: boolean;
	serviceName: string;
	redactionStyle: RedactionStyle;
	debug: boolean;
}

export interface TraceEnvelope {
	traceId?: string;
	sessionId?: string;
	parentSpanId?: string;
	turnId?: string;
	correlationId?: string;
	agentId: string;
	runType: "exec" | "session";
}

export interface LangWatchRuntime {
	startSpan(name: string, attributes?: PantheonAttributes, envelope?: TraceEnvelope): Span;
	startChildSpan(parent: Span, name: string, attributes?: PantheonAttributes): Span;
	forceFlush(): Promise<void>;
	shutdown(): Promise<void>;
}

export interface InMemoryLangWatchRuntime extends LangWatchRuntime {
	getFinishedSpans(): ReturnType<InMemorySpanExporter["getFinishedSpans"]>;
}

export interface MainTraceState {
	runtime: LangWatchRuntime;
	span: Span;
	agentId: string;
	traceId: string;
	spanId: string;
	sessionId: string;
	sessionHash: string;
	correlationId: string;
	prompt: string;
	startedAt: number;
	turnIndex?: number;
	turnId?: string;
	turnSpan?: Span;
	tools: Map<string, Span>;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function shortHash(value: string) {
	return sha256(value).slice(0, 16);
}

function normalizeEndpoint(endpoint: string) {
	return endpoint.replace(/\/+$/, "");
}

function parseRedactionStyle(_value: unknown): RedactionStyle {
	return "hash";
}

function parseBooleanFlag(value: unknown): boolean {
	if (typeof value !== "string") return false;
	return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function parseLangWatchConfig(env: EnvLike): LangWatchConfig {
	const apiKey = readString(env.LANGWATCH_API_KEY);
	return {
		enabled: Boolean(apiKey),
		apiKey,
		endpoint: normalizeEndpoint(readString(env.LANGWATCH_ENDPOINT) ?? DEFAULT_LANGWATCH_ENDPOINT),
		captureContent: true,
		serviceName: DEFAULT_SERVICE_NAME,
		redactionStyle: parseRedactionStyle(env.LANGWATCH_REDACTION_STYLE),
		debug: parseBooleanFlag(env.LANGWATCH_DEBUG) || parseBooleanFlag(env.PANTHEON_LANGWATCH_DEBUG),
	};
}

export function redactLangWatchContent(value: string): string {
	return secretRedactionPatterns.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

export function summarizeValue(value: unknown): Record<string, string | number | boolean> {
	if (typeof value === "string") return { type: "string", length: value.length, hash: sha256(value) };
	if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
		return { type: value === null ? "null" : typeof value };
	}
	if (Array.isArray(value)) {
		return { type: "array", length: value.length, hash: sha256(JSON.stringify(value.map(summarizeValue))) };
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).sort();
		return {
			type: "object",
			keys: keys.length,
			hash: sha256(JSON.stringify(keys.map((key) => [key, summarizeValue(record[key])]))),
		};
	}
	return { type: typeof value };
}

function addStringSummary(attrs: PantheonAttributes, prefix: string, value: string | undefined) {
	if (value === undefined) return;
	attrs[`${prefix}.length`] = value.length;
	attrs[`${prefix}.hash`] = sha256(value);
}

function truncateAttribute(value: string, max = 4000) {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function isValidTraceId(value: string | undefined) {
	return value !== undefined && /^[a-f0-9]{32}$/i.test(value);
}

function isValidSpanId(value: string | undefined) {
	return value !== undefined && /^[a-f0-9]{16}$/i.test(value);
}

function addMaybeContent(
	attrs: PantheonAttributes,
	key: string,
	summaryPrefix: string,
	value: string | undefined,
	_options: Pick<LangWatchConfig, "captureContent">,
) {
	if (value === undefined) return;
	const redacted = redactLangWatchContent(value);
	addStringSummary(attrs, summaryPrefix, redacted);
	attrs[key] = truncateAttribute(redacted);
	attrs[`${summaryPrefix}.truncated`] = redacted.length > 4000;
}

function parseBooleanSignal(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (value === 1) return true;
		if (value === 0) return false;
		return undefined;
	}
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (["true", "1", "yes", "error", "failed", "failure"].includes(normalized)) return true;
		if (["false", "0", "no", "ok", "unset", "null", "undefined", "none", ""].includes(normalized)) return false;
	}
	return undefined;
}

function toStatusMessage(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	const text = typeof value === "string" ? value : String(value);
	const normalized = text.trim();
	if (!normalized || ["null", "undefined", "false"].includes(normalized.toLowerCase())) return undefined;
	return truncateAttribute(normalized, 160);
}

export function parseAcpxTranscriptEvents(transcript: string): AcpxTranscriptEvent[] {
	const markerPattern = /^\[(thinking|tool|client|done)\](?:\s*(.*))?$/;
	return transcript
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.reduce<AcpxTranscriptEvent[]>((events, line) => {
			const match = markerPattern.exec(line);
			if (!match) return events;
			events.push({
				kind: match[1] as AcpxTranscriptEventKind,
				index: events.length + 1,
				line,
				label: match[2] ?? "",
			});
			return events;
		}, []);
}

function buildAcpxTranscriptEventAttributes(event: AcpxTranscriptEvent): PantheonAttributes {
	const attrs: PantheonAttributes = {
		"langwatch.span.type": event.kind === "tool" ? "tool" : "span",
		"pantheon.event": `acpx_${event.kind}`,
		"pantheon.event.kind": event.kind,
		"pantheon.event.index": event.index,
		"pantheon.event.line.length": event.line.length,
		"pantheon.event.line.hash": sha256(event.line),
	};
	if (event.label) {
		attrs["pantheon.event.label.length"] = event.label.length;
		attrs["pantheon.event.label.hash"] = sha256(event.label);
	}
	if (event.kind === "tool" && event.label) attrs["pantheon.tool.name"] = event.label.split(/\s+/, 1)[0];
	return attrs;
}

function recordAcpxTranscriptChildSpans(runtime: LangWatchRuntime, parent: Span, transcript: string) {
	for (const event of parseAcpxTranscriptEvents(transcript).slice(0, MAX_TRANSCRIPT_CHILD_SPANS)) {
		const child = runtime.startChildSpan(
			parent,
			`pantheon.acpx.event.${event.kind}`,
			buildAcpxTranscriptEventAttributes(event),
		);
		child.setStatus({ code: SpanStatusCode.OK });
		child.end();
	}
}

export type AcpxFailureClass =
	| "max_turns"
	| "timeout"
	| "auth"
	| "set_model_rejected"
	| "rate_limit"
	| "aborted"
	| "other";

export interface AcpxFailureClassification {
	class: AcpxFailureClass;
	maxTurnsCap?: number;
}

const MAX_TURNS_PATTERN = /Reached maximum number of turns \((\d+)\)/;

export function classifyAcpxFailure(
	result: Pick<AcpxRunResult, "timedOut" | "aborted" | "stdout" | "stderr">,
): AcpxFailureClassification {
	if (result.timedOut) return { class: "timeout" };
	if (result.aborted) return { class: "aborted" };
	const combined = `${result.stderr}\n${result.stdout}`;
	const maxTurnsMatch = MAX_TURNS_PATTERN.exec(combined);
	if (maxTurnsMatch) return { class: "max_turns", maxTurnsCap: parseInt(maxTurnsMatch[1], 10) };
	if (/Authentication required/i.test(combined)) return { class: "auth" };
	if (/session[/_-]set_model|set[_-]model[_-]rejected/i.test(combined)) return { class: "set_model_rejected" };
	if (/session\s+limit|rate[_-]?limit/i.test(combined)) return { class: "rate_limit" };
	return { class: "other" };
}

function buildFailureErrorMessage(result: AcpxRunResult): string {
	const parts: string[] = [];
	if (result.exitCode !== null && result.exitCode !== undefined && result.exitCode !== 0)
		parts.push(`exit ${result.exitCode}`);
	if (result.signal) parts.push(`signal ${result.signal}`);
	if (result.timedOut) parts.push("timed out");
	if (result.aborted) parts.push("aborted");
	const combined = `${result.stderr}\n${result.stdout}`;
	const lastLine =
		combined
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0)
			.pop() ?? "";
	if (lastLine) parts.push(truncateAttribute(lastLine, 160));
	return parts.join("; ") || "unknown failure";
}

function extractToolResultText(result: unknown): string | undefined {
	if (typeof result === "string") return result;
	if (result instanceof Error) return result.message;
	if (typeof result === "object" && result !== null) {
		const record = result as Record<string, unknown>;
		if (Array.isArray(record.content)) {
			for (const item of record.content) {
				if (typeof item === "object" && item !== null && (item as Record<string, unknown>).type === "text") {
					const text = (item as Record<string, unknown>).text;
					if (typeof text === "string") return text;
				}
			}
		}
		if (typeof record.message === "string") return record.message;
	}
	return undefined;
}

export function decideSpanStatus(attributes: Record<string, unknown>): SpanStatusDecision {
	const explicitError = parseBooleanSignal(attributes["pantheon.run.success"]);
	if (explicitError === true) return { code: "OK" };
	if (explicitError === false) {
		return { code: "ERROR", message: toStatusMessage(attributes["pantheon.error.message"]) ?? "operation failed" };
	}

	const toolError = parseBooleanSignal(attributes["pantheon.tool.error"]);
	if (toolError === true) {
		return { code: "ERROR", message: toStatusMessage(attributes["pantheon.tool.error.message"]) ?? "operation failed" };
	}
	return { code: "OK" };
}

export function buildTraceEnvelopeAttributes(envelope: TraceEnvelope): PantheonAttributes {
	const attrs: PantheonAttributes = {
		"langwatch.span.type": "tool",
		"pantheon.agent": envelope.agentId,
		"pantheon.run_type": envelope.runType,
	};
	if (isValidTraceId(envelope.traceId)) attrs["pantheon.trace_id"] = envelope.traceId;
	if (isValidSpanId(envelope.parentSpanId)) attrs["pantheon.parent_span_id"] = envelope.parentSpanId;
	if (envelope.sessionId) attrs["pantheon.session_id.hash"] = sha256(envelope.sessionId);
	if (envelope.turnId) attrs["pantheon.turn_id"] = envelope.turnId;
	if (envelope.correlationId) attrs["pantheon.correlation_id"] = envelope.correlationId;
	return attrs;
}

export function buildAcpxRunAttributes(
	request: Pick<
		AcpxRunRequest,
		| "agent"
		| "prompt"
		| "runType"
		| "cwd"
		| "model"
		| "maxTurns"
		| "permissions"
		| "timeoutSeconds"
		| "ttlSeconds"
		| "sessionId"
	>,
	result: AcpxRunResult,
	options: Pick<LangWatchConfig, "captureContent">,
): PantheonAttributes {
	const runType = request.runType ?? "exec";
	const turnCount = (result.stdout.match(/^\[thinking\]/gm) ?? []).length;
	const toolCount = (result.stdout.match(/^\[tool\]/gm) ?? []).length;
	const attrs: PantheonAttributes = {
		"langwatch.span.type": "tool",
		"pantheon.event": "acpx_run",
		"pantheon.agent": request.agent,
		"pantheon.run_type": runType,
		"pantheon.run.success": result.success,
		"pantheon.run.duration_ms": result.durationMs,
		"pantheon.run.timed_out": result.timedOut,
		"pantheon.run.aborted": result.aborted,
		"pantheon.command": result.command,
		"pantheon.turn_count": turnCount,
		"pantheon.tool_event_count": toolCount,
	};

	if (request.cwd) attrs["pantheon.cwd"] = request.cwd;
	if (request.model) attrs["pantheon.model"] = request.model;
	if (request.sessionId) attrs["pantheon.session_id.hash"] = sha256(request.sessionId);
	if (request.maxTurns) attrs["pantheon.max_turns"] = request.maxTurns;
	if (request.permissions) attrs["pantheon.permissions"] = request.permissions;
	if (request.timeoutSeconds) attrs["pantheon.timeout_seconds"] = request.timeoutSeconds;
	if (request.ttlSeconds !== undefined) attrs["pantheon.ttl_seconds"] = request.ttlSeconds;
	if (result.exitCode !== null) attrs["pantheon.run.exit_code"] = result.exitCode;
	if (result.signal) attrs["pantheon.run.signal"] = result.signal;

	if (!result.success) {
		const classification = classifyAcpxFailure(result);
		attrs["pantheon.failure.class"] = classification.class;
		if (classification.maxTurnsCap !== undefined) attrs["pantheon.failure.max_turns_cap"] = classification.maxTurnsCap;
		attrs["pantheon.error.message"] = truncateAttribute(result.error ?? buildFailureErrorMessage(result), 160);
	}

	addMaybeContent(attrs, "langwatch.input", "pantheon.prompt", request.prompt, options);
	addMaybeContent(attrs, "langwatch.output", "pantheon.stdout", result.stdout, options);
	addMaybeContent(attrs, "pantheon.stderr", "pantheon.stderr", result.stderr, options);
	addStringSummary(attrs, "pantheon.final_answer", result.finalAnswer);
	addStringSummary(attrs, "pantheon.transcript", result.fullTranscript);

	return attrs;
}

function filteredAttributes(attributes: PantheonAttributes): Attributes {
	return Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined)) as Attributes;
}

function parentContext(envelope?: TraceEnvelope): Context | undefined {
	if (!isValidTraceId(envelope?.traceId) || !isValidSpanId(envelope?.parentSpanId)) return undefined;

	const parent = trace.wrapSpanContext({
		traceId: envelope.traceId,
		spanId: envelope.parentSpanId,
		traceFlags: 1,
		isRemote: true,
	});
	return trace.setSpan(context.active(), parent);
}

function createRuntime(provider: BasicTracerProvider): LangWatchRuntime {
	const tracer = provider.getTracer(TRACER_NAME);
	return {
		startSpan(name, attributes = {}, envelope) {
			return tracer.startSpan(
				name,
				{
					kind: SpanKind.CLIENT,
					attributes: filteredAttributes({
						...buildTraceEnvelopeAttributes(envelope ?? { agentId: "unknown", runType: "exec" }),
						...attributes,
					}),
				},
				parentContext(envelope),
			);
		},
		startChildSpan(parent, name, attributes = {}) {
			return tracer.startSpan(
				name,
				{ kind: SpanKind.INTERNAL, attributes: filteredAttributes(attributes) },
				trace.setSpan(context.active(), parent),
			);
		},
		forceFlush: () => provider.forceFlush(),
		shutdown: () => provider.shutdown(),
	};
}

export function createInMemoryLangWatchRuntime(): InMemoryLangWatchRuntime {
	const exporter = new InMemorySpanExporter();
	const provider = new BasicTracerProvider({
		resource: resourceFromAttributes({ [SEMRESATTRS_SERVICE_NAME]: "pantheon-pi-test" }),
		spanProcessors: [new SimpleSpanProcessor(exporter)],
	});
	const runtime = createRuntime(provider);
	return {
		...runtime,
		getFinishedSpans: () => exporter.getFinishedSpans(),
	};
}

let runtimePromise: Promise<LangWatchRuntime | undefined> | undefined;
let shutdownHooksRegistered = false;

function sanitizedErrorMessage(error: unknown) {
	return truncateAttribute(redactLangWatchContent(error instanceof Error ? error.message : String(error)), 300);
}

const timeoutSentinel = Symbol("langwatch-timeout");

async function withBoundedTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T | typeof timeoutSentinel> {
	let timeout: Timer | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<typeof timeoutSentinel>((resolve) => {
				timeout = setTimeout(() => resolve(timeoutSentinel), timeoutMs);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

async function flushLangWatchRuntime(
	runtime: LangWatchRuntime | undefined,
	config: Pick<LangWatchConfig, "debug">,
	operation = "forceFlush",
	timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
) {
	if (!runtime) return;
	try {
		const completed = await withBoundedTimeout(runtime.forceFlush(), timeoutMs);
		if (completed === timeoutSentinel && config.debug) {
			console.warn(`pantheon-pi langwatch ${operation} timed out after ${timeoutMs}ms`);
		}
	} catch (error) {
		if (config.debug) console.warn(`pantheon-pi langwatch ${operation} failed: ${sanitizedErrorMessage(error)}`);
	}
}

async function shutdownLangWatchRuntime(
	runtime: LangWatchRuntime,
	config: Pick<LangWatchConfig, "debug">,
	timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
) {
	try {
		const completed = await withBoundedTimeout(runtime.shutdown(), timeoutMs);
		if (completed === timeoutSentinel && config.debug) {
			console.warn(`pantheon-pi langwatch shutdown timed out after ${timeoutMs}ms`);
		}
	} catch (error) {
		if (config.debug) console.warn(`pantheon-pi langwatch shutdown failed: ${sanitizedErrorMessage(error)}`);
	}
}

function registerShutdownHooks(runtime: LangWatchRuntime, config: Pick<LangWatchConfig, "debug">) {
	if (shutdownHooksRegistered) return;
	shutdownHooksRegistered = true;
	process.once("beforeExit", async () => {
		await shutdownLangWatchRuntime(runtime, config);
	});
	const signalShutdown = (signal: NodeJS.Signals) => {
		void shutdownLangWatchRuntime(runtime, config).finally(() => {
			process.kill(process.pid, signal);
		});
	};
	process.once("SIGTERM", signalShutdown);
	process.once("SIGINT", signalShutdown);
}

export function resetLangWatchRuntimeForTests() {
	runtimePromise = undefined;
	shutdownHooksRegistered = false;
	currentMainTrace = undefined;
}

export function setLangWatchRuntimeForTests(runtime: LangWatchRuntime) {
	runtimePromise = Promise.resolve(runtime);
}

export function initLangWatchRuntime(
	config = parseLangWatchConfig(process.env),
): Promise<LangWatchRuntime | undefined> {
	if (runtimePromise) return runtimePromise;
	if (!config.enabled) return Promise.resolve(undefined);

	runtimePromise = Promise.resolve().then(() => {
		try {
			const exporter = new OTLPTraceExporter({
				url: `${config.endpoint}/api/otel/v1/traces`,
				headers: { Authorization: `Bearer ${config.apiKey}`, "X-Auth-Token": config.apiKey ?? "" },
			});
			const provider = new BasicTracerProvider({
				resource: resourceFromAttributes({
					[SEMRESATTRS_SERVICE_NAME]: config.serviceName,
					"telemetry.sdk.name": "pantheon-pi",
				}),
				spanProcessors: [new BatchSpanProcessor(exporter)],
			});

			trace.setGlobalTracerProvider(provider);
			propagation.setGlobalPropagator(new W3CTraceContextPropagator());
			const runtime = createRuntime(provider);
			registerShutdownHooks(runtime, config);
			if (config.debug) console.warn(`pantheon-pi langwatch enabled: ${config.endpoint}/api/otel/v1/traces`);
			return runtime;
		} catch (error) {
			if (config.debug) console.warn(`pantheon-pi langwatch initialization failed: ${sanitizedErrorMessage(error)}`);
			return undefined;
		}
	});

	return runtimePromise;
}

function safeJson(value: unknown, max = 4000) {
	try {
		return truncateAttribute(redactLangWatchContent(JSON.stringify(value)), max);
	} catch {
		return truncateAttribute(redactLangWatchContent(String(value)), max);
	}
}

function setSpanContent(span: Span, key: string, summaryPrefix: string, value: string | undefined) {
	if (value === undefined) return;
	const attrs: PantheonAttributes = {};
	addMaybeContent(attrs, key, summaryPrefix, value, { captureContent: true });
	span.setAttributes(filteredAttributes(attrs));
}

export function buildMainTraceEnv(state: MainTraceState): Record<string, string> {
	const spanId = state.turnSpan?.spanContext().spanId ?? state.spanId;
	return {
		TRACEPARENT: `00-${state.traceId}-${spanId}-01`,
		PANTHEON_TRACE_ID: state.traceId,
		PANTHEON_PARENT_SPAN_ID: spanId,
		PANTHEON_SESSION_ID: state.sessionId,
		PANTHEON_SESSION_HASH: state.sessionHash,
		PANTHEON_TURN_ID: state.turnId ?? `${state.correlationId}-turn-${state.turnIndex ?? 0}`,
		PANTHEON_CORRELATION_ID: state.correlationId,
	};
}

export function getCurrentMainTraceEnv(): Record<string, string> | undefined {
	return currentMainTrace ? buildMainTraceEnv(currentMainTrace) : undefined;
}

let currentMainTrace: MainTraceState | undefined;

export function getCurrentMainTraceState() {
	return currentMainTrace;
}

export async function startMainAgentTrace(input: {
	prompt: string;
	sessionId?: string;
	cwd?: string;
	source?: string;
	agentId?: string;
}) {
	const runtime = await initLangWatchRuntime();
	if (!runtime) return undefined;
	const sessionId = input.sessionId?.trim() || `ephemeral:${input.cwd ?? process.cwd()}`;
	const agentId = readString(input.agentId) ?? readString(process.env.PANTHEON_MAIN_AGENT) ?? "athena";
	const correlationId = `pantheon-${shortHash(`${sessionId}:${Date.now()}:${randomUUID()}`)}`;
	const attrs: PantheonAttributes = {
		"langwatch.span.type": "chain",
		"pantheon.event": "main_agent",
		"pantheon.agent": agentId,
		"pantheon.session_id.hash": sha256(sessionId),
		"pantheon.correlation_id": correlationId,
		"pantheon.source": input.source ?? "pi",
	};
	if (input.cwd) attrs["pantheon.cwd"] = input.cwd;
	addMaybeContent(attrs, "langwatch.input", "pantheon.prompt", input.prompt, { captureContent: true });
	const span = runtime.startSpan("pantheon.pi.main", attrs, {
		agentId,
		runType: "session",
		sessionId,
		correlationId,
	});
	currentMainTrace = {
		runtime,
		span,
		agentId,
		traceId: span.spanContext().traceId,
		spanId: span.spanContext().spanId,
		sessionId,
		sessionHash: sha256(sessionId),
		correlationId,
		prompt: input.prompt,
		startedAt: Date.now(),
		tools: new Map(),
	};
	return currentMainTrace;
}

export async function endMainAgentTrace(output: unknown, error?: unknown) {
	const state = currentMainTrace;
	if (!state) return;
	for (const toolSpan of state.tools.values()) toolSpan.end();
	state.tools.clear();
	if (state.turnSpan) {
		state.turnSpan.end();
		state.turnSpan = undefined;
	}
	state.span.setAttribute("pantheon.run.duration_ms", Date.now() - state.startedAt);
	setSpanContent(
		state.span,
		"langwatch.output",
		"pantheon.output",
		typeof output === "string" ? output : safeJson(output),
	);
	if (error) {
		const message = error instanceof Error ? error.message : String(error);
		state.span.setAttribute("pantheon.run.success", false);
		state.span.setAttribute("pantheon.error.message", truncateAttribute(redactLangWatchContent(message), 160));
		state.span.setStatus({
			code: SpanStatusCode.ERROR,
			message: truncateAttribute(redactLangWatchContent(message), 160),
		});
	} else {
		state.span.setAttribute("pantheon.run.success", true);
		state.span.setStatus({ code: SpanStatusCode.OK });
	}
	state.span.end();
	currentMainTrace = undefined;
	await flushLangWatchRuntime(state.runtime, parseLangWatchConfig(process.env), "main trace forceFlush");
}

export function startMainTurn(input: { turnIndex?: number; timestamp?: string | number }) {
	const state = currentMainTrace;
	if (!state) return;
	if (state.turnSpan) state.turnSpan.end();
	state.turnIndex = input.turnIndex ?? (state.turnIndex ?? 0) + 1;
	state.turnId = `${state.correlationId}-turn-${state.turnIndex}`;
	state.turnSpan = state.runtime.startChildSpan(state.span, "pantheon.pi.turn", {
		"langwatch.span.type": "chain",
		"pantheon.event": "main_turn",
		"pantheon.agent": state.agentId,
		"pantheon.turn_index": state.turnIndex,
		"pantheon.turn_id": state.turnId,
		"pantheon.session_id.hash": state.sessionHash,
		"pantheon.correlation_id": state.correlationId,
	});
}

export function endMainTurn(output: unknown, error?: unknown) {
	const state = currentMainTrace;
	if (!state?.turnSpan) return;
	const span = state.turnSpan;
	setSpanContent(
		span,
		"langwatch.output",
		"pantheon.turn.output",
		typeof output === "string" ? output : safeJson(output),
	);
	if (error) {
		const message = error instanceof Error ? error.message : String(error);
		span.setStatus({ code: SpanStatusCode.ERROR, message: truncateAttribute(redactLangWatchContent(message), 160) });
	} else {
		span.setStatus({ code: SpanStatusCode.OK });
	}
	span.end();
	state.turnSpan = undefined;
}

export function startMainToolSpan(input: { toolCallId: string; toolName: string; args?: unknown }) {
	const state = currentMainTrace;
	if (!state) return;
	const parent = state.turnSpan ?? state.span;
	const span = state.runtime.startChildSpan(parent, `pantheon.pi.tool.${input.toolName}`, {
		"langwatch.span.type": "tool",
		"pantheon.event": "main_tool",
		"pantheon.tool_call_id": input.toolCallId,
		"pantheon.tool.name": input.toolName,
		"pantheon.session_id.hash": state.sessionHash,
		"pantheon.turn_id": state.turnId,
		"pantheon.correlation_id": state.correlationId,
		"langwatch.input": input.args === undefined ? undefined : safeJson(input.args),
	});
	state.tools.set(input.toolCallId, span);
}

export function endMainToolSpan(input: { toolCallId: string; result?: unknown; isError?: boolean }) {
	const state = currentMainTrace;
	const span = state?.tools.get(input.toolCallId);
	if (!state || !span) return;
	if (input.result !== undefined) span.setAttribute("langwatch.output", safeJson(input.result));
	if (input.isError) {
		span.setAttribute("pantheon.tool.error", true);
		const errorText = extractToolResultText(input.result);
		if (errorText) span.setAttribute("pantheon.tool.error.message", truncateAttribute(errorText, 160));
		span.setStatus({
			code: SpanStatusCode.ERROR,
			message: errorText ? truncateAttribute(errorText, 160) : "tool error",
		});
	} else {
		span.setStatus({ code: SpanStatusCode.OK });
	}
	span.end();
	state.tools.delete(input.toolCallId);
}

export async function withLangWatchTrace<T>(
	envelope: TraceEnvelope,
	run: () => Promise<T>,
	options: { runtime?: LangWatchRuntime; attributes?: PantheonAttributes } = {},
): Promise<{ result: T; durationMs: number; envelope: TraceEnvelope }> {
	const startedAt = Date.now();
	const runtime = options.runtime ?? (await initLangWatchRuntime());
	const span = runtime?.startSpan("pantheon.acpx.run", options.attributes, envelope);

	try {
		const result = await run();
		span?.setAttribute("pantheon.run.success", true);
		span?.setAttribute("pantheon.run.duration_ms", Date.now() - startedAt);
		span?.setStatus({ code: SpanStatusCode.OK });
		return { result, durationMs: Date.now() - startedAt, envelope };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		span?.setAttribute("pantheon.run.success", false);
		span?.setAttribute("pantheon.run.duration_ms", Date.now() - startedAt);
		span?.setAttribute("pantheon.error.message", truncateAttribute(message, 160));
		span?.setStatus({ code: SpanStatusCode.ERROR, message: truncateAttribute(message, 160) });
		throw error;
	} finally {
		span?.end();
		await flushLangWatchRuntime(runtime, parseLangWatchConfig(process.env), "forceFlush");
	}
}

export async function traceAcpxRun(request: AcpxRunRequest, run: () => Promise<AcpxRunResult>): Promise<AcpxRunResult> {
	const config = parseLangWatchConfig(process.env);
	const mainTraceEnv = getCurrentMainTraceEnv();
	const envelope: TraceEnvelope = {
		agentId: request.agent,
		runType: request.runType ?? "exec",
		traceId:
			request.traceId ?? mainTraceEnv?.PANTHEON_TRACE_ID ?? process.env.PANTHEON_TRACE_ID ?? process.env.TRACE_ID,
		parentSpanId:
			request.parentSpanId ??
			mainTraceEnv?.PANTHEON_PARENT_SPAN_ID ??
			process.env.PANTHEON_PARENT_SPAN_ID ??
			process.env.PARENT_SPAN_ID,
		sessionId:
			request.sessionId ??
			mainTraceEnv?.PANTHEON_SESSION_ID ??
			process.env.PANTHEON_SESSION_ID ??
			process.env.PI_SESSION_ID,
		turnId: mainTraceEnv?.PANTHEON_TURN_ID ?? process.env.PANTHEON_TURN_ID,
		correlationId: mainTraceEnv?.PANTHEON_CORRELATION_ID ?? process.env.PANTHEON_CORRELATION_ID,
	};
	const runtime = await initLangWatchRuntime(config);
	if (!runtime) return run();

	let span: Span | undefined;
	const startedAt = Date.now();
	try {
		span = runtime.startSpan("pantheon.acpx.run", buildTraceEnvelopeAttributes(envelope), envelope);
		const result = await run();
		const attrs = buildAcpxRunAttributes(request, result, config);
		span.setAttributes(filteredAttributes(attrs));
		recordAcpxTranscriptChildSpans(runtime, span, result.stdout);
		const status = decideSpanStatus(attrs);
		span.setStatus(
			status.code === "OK" ? { code: SpanStatusCode.OK } : { code: SpanStatusCode.ERROR, message: status.message },
		);
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		span?.setAttributes({
			"pantheon.run.success": false,
			"pantheon.run.duration_ms": Date.now() - startedAt,
			"pantheon.error.message": truncateAttribute(message, 160),
		});
		span?.setStatus({ code: SpanStatusCode.ERROR, message: truncateAttribute(message, 160) });
		throw error;
	} finally {
		span?.end();
		await flushLangWatchRuntime(runtime, config, "acpx run forceFlush");
	}
}
