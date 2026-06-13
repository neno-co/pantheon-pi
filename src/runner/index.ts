import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CLAUDE_AGENT_ACP_COMMAND, DEFAULT_ACPX_TIMEOUT_SECONDS, getAcpxBackend, isPantheonAgent } from "../agents.ts";
import { getCurrentMainTraceEnv, traceAcpxRun } from "../langwatch/index.ts";
import { sanitizeAcpxSessionName } from "../workflow/session.ts";

export type AcpxRunType = "exec" | "session";
export type AcpxPermissionPolicy = "deny-all" | "approve-reads" | "approve-all";
export type AcpxStatus = "starting" | "running" | "timeout" | "aborting" | "done" | "failed" | "needs_attention";

export interface AcpxRunRequest {
	agent: string;
	prompt: string;
	runType?: AcpxRunType;
	cwd?: string;
	model?: string;
	maxTurns?: number;
	permissions?: AcpxPermissionPolicy;
	timeoutSeconds?: number;
	ttlSeconds?: number;
	traceId?: string;
	parentSpanId?: string;
	sessionId?: string;
	binaryPath?: string;
	signal?: AbortSignal;
	onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
	onStatus?: (status: AcpxStatus) => void;
}

export interface AcpxRunResult {
	success: boolean;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	aborted: boolean;
	command: string;
	args: string[];
	finalAnswer: string;
	fullTranscript: string;
	durationMs: number;
	error?: string;
	needsAttention?: boolean;
}

export const DEFAULT_ACPX_BIN = "/opt/homebrew/bin/acpx";
const HUMAN_WAIT_IDLE_RETURN_MS = 1_000;
const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

const ansiEscapePattern = new RegExp(`${String.fromCharCode(27)}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])`, "g");

export function stripAnsi(text: string) {
	return text.replace(ansiEscapePattern, "");
}

function stripPiStartupNoise(text: string) {
	return text
		.split("\n")
		.filter((line) => !/^New version available: v[^\s]+ \(installed v[^)]+\)\. Run: `[^`]+`$/.test(line.trim()))
		.join("\n");
}

export function extractFinalAnswer(transcript: string) {
	const text = stripPiStartupNoise(stripAnsi(transcript)).trim();
	if (!text) return "(no output)";

	const doneIndex = text.lastIndexOf("\n[done]");
	const end = doneIndex >= 0 ? doneIndex : text.length;
	const beforeDone = text.slice(0, end).trimEnd();

	const markerPatterns = ["[thinking]", "[tool]", "[client]"];
	const lastMarker = Math.max(
		...markerPatterns.map((marker) => {
			const atStart = beforeDone.startsWith(marker) ? 0 : -1;
			const afterNewline = beforeDone.lastIndexOf(`\n${marker}`);
			return Math.max(atStart, afterNewline >= 0 ? afterNewline + 1 : -1);
		}),
	);
	if (lastMarker < 0) return beforeDone;

	const markerLineEnd = beforeDone.indexOf("\n", lastMarker);
	if (markerLineEnd < 0) return beforeDone;

	const candidate = beforeDone.slice(markerLineEnd + 1).trim();
	return candidate || beforeDone;
}

export function resolveAcpxBinary(binaryPath = process.env.PANTHEON_ACPX_BIN ?? process.env.ACPX_BIN) {
	if (binaryPath) return binaryPath;
	if (existsSync(DEFAULT_ACPX_BIN)) return DEFAULT_ACPX_BIN;
	return "acpx";
}

function validateSafeguards(request: AcpxRunRequest, timeoutSeconds: number) {
	if (request.maxTurns !== undefined && (!Number.isInteger(request.maxTurns) || request.maxTurns < 1)) {
		return "maxTurns must be at least 1";
	}
	if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) return "timeoutSeconds must be at least 1";
	if (request.ttlSeconds !== undefined && (!Number.isInteger(request.ttlSeconds) || request.ttlSeconds < 0)) {
		return "ttlSeconds must be 0 or greater";
	}
	return undefined;
}

function hasHumanWaitFinalAnswer(transcript: string) {
	const finalAnswer = extractFinalAnswer(transcript);
	return /(?:\*\*)?Waiting for human:(?:\*\*)?\s*Yes\b/i.test(finalAnswer);
}

function shellQuote(value: string) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildPackagedPantheonAgentCommand(agent: string, model: string | undefined) {
	const launcher = path.join(PACKAGE_ROOT, "agents", "bin", agent);
	const modelEnv = model ? ` PANTHEON_PI_MODEL=${shellQuote(model)}` : "";
	return `env${modelEnv} PI_ACP_PI_COMMAND=${shellQuote(launcher)} npx -y pi-acp@latest`;
}

function readPackagedPrompt(promptFile: string) {
	return readFileSync(path.join(PACKAGE_ROOT, "agents", "prompts", `${promptFile}.md`), "utf8");
}

function buildAgentSelectorArgs(agent: string, backend: ReturnType<typeof getAcpxBackend>, model: string | undefined) {
	if (backend.kind === "claude-agent-acp") return ["--agent", CLAUDE_AGENT_ACP_COMMAND];
	if (!isPantheonAgent(agent)) return [agent];
	return ["--agent", buildPackagedPantheonAgentCommand(agent, model)];
}

function resolvePermissionPolicy(
	request: AcpxRunRequest,
	backend: ReturnType<typeof getAcpxBackend>,
): AcpxPermissionPolicy {
	if (backend.kind !== "claude-agent-acp") return request.permissions ?? "approve-reads";
	if (request.permissions === "deny-all") return "deny-all";
	return backend.permissions ?? "approve-all";
}

function buildBaseArgs(request: AcpxRunRequest, cwd: string, timeoutSeconds: number) {
	const backend = getAcpxBackend(request.agent);
	const permissionFlag = `--${resolvePermissionPolicy(request, backend)}`;
	const args = ["--cwd", cwd, "--format", "text", permissionFlag, "--timeout", String(timeoutSeconds)];

	if (request.ttlSeconds !== undefined) args.push("--ttl", String(request.ttlSeconds));
	const model = request.model ?? backend.model;
	if (model && (backend.kind === "claude-agent-acp" || !isPantheonAgent(request.agent))) args.push("--model", model);
	if (request.maxTurns) args.push("--max-turns", String(request.maxTurns));

	// Inject the packaged versioned prompt so the Claude Code route stays Pantheon-owned.
	if (backend.kind === "claude-agent-acp") args.push("--append-system-prompt", readPackagedPrompt(backend.promptFile));

	args.push(...buildAgentSelectorArgs(request.agent, backend, model));
	return args;
}

function buildExecArgs(request: AcpxRunRequest, cwd: string, timeoutSeconds: number) {
	return [...buildBaseArgs(request, cwd, timeoutSeconds), "exec", request.prompt];
}

function buildSessionEnsureArgs(request: AcpxRunRequest, cwd: string, timeoutSeconds: number, sessionId: string) {
	return [...buildBaseArgs(request, cwd, timeoutSeconds), "sessions", "ensure", "--name", sessionId];
}

function buildSessionPromptArgs(request: AcpxRunRequest, cwd: string, timeoutSeconds: number, sessionId: string) {
	return [...buildBaseArgs(request, cwd, timeoutSeconds), "prompt", "-s", sessionId, request.prompt];
}

function isSuccessfulAcpxProcess(completion: {
	code: number | null;
	timedOut: boolean;
	aborted: boolean;
	error?: string;
}) {
	return completion.code === 0 && !completion.timedOut && !completion.aborted && !completion.error;
}

function isMissingAcpxSessionFailure(result: { code: number | null; stdout: string; stderr: string; error?: string }) {
	const combined = `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`;
	return result.code === 4 && /(?:No acpx session found|NO_SESSION|Create one:)/i.test(combined);
}

/**
 * Thin acpx execution seam.
 *
 * Stateless `exec` remains the default. Stateful sessions are opt-in through
 * `runType: 'session'` and use the documented acpx session commands below.
 *
 * Binary resolution keeps the prototype's Homebrew path when present, while
 * allowing `PANTHEON_ACPX_BIN`/`ACPX_BIN`, explicit `binaryPath`, or PATH lookup.
 */
async function spawnAcpxCommand(
	command: string,
	args: string[],
	request: AcpxRunRequest,
	cwd: string,
	timeoutSeconds: number,
): Promise<{
	stdout: string;
	stderr: string;
	code: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	aborted: boolean;
	needsAttention: boolean;
	error?: string;
}> {
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	let aborted = false;
	let needsAttention = false;

	const completion = await new Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
		error?: string;
	}>((resolve) => {
		let settled = false;
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
		let humanWaitReturnTimeout: ReturnType<typeof setTimeout> | undefined;
		const traceEnv = getCurrentMainTraceEnv();
		const child = spawn(command, args, {
			cwd,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				...traceEnv,
				...(request.traceId ? { PANTHEON_TRACE_ID: request.traceId } : {}),
				...(request.parentSpanId ? { PANTHEON_PARENT_SPAN_ID: request.parentSpanId } : {}),
				...(request.sessionId ? { PANTHEON_SESSION_ID: request.sessionId } : {}),
			},
		});

		const killChild = (signal: NodeJS.Signals) => {
			if (child.pid && process.platform !== "win32") {
				try {
					process.kill(-child.pid, signal);
					return;
				} catch {
					// Fall back to killing only the child process below.
				}
			}
			child.kill(signal);
		};

		const terminateChild = () => {
			killChild("SIGTERM");
			forceKillTimeout = setTimeout(() => killChild("SIGKILL"), 250);
		};

		const detachTerminateChild = () => {
			killChild("SIGTERM");
			const force = setTimeout(() => killChild("SIGKILL"), 250);
			force.unref?.();
		};

		const abort = () => {
			aborted = true;
			const message = "\n[pi] acpx aborted by user; terminating subagent\n";
			stderr += message;
			request.onOutput?.("stderr", message);
			request.onStatus?.("aborting");
			terminateChild();
		};

		const settle = (result: { code: number | null; signal: NodeJS.Signals | null; error?: string }) => {
			if (settled) return;
			settled = true;
			if (heartbeat) clearInterval(heartbeat);
			if (timeout) clearTimeout(timeout);
			if (forceKillTimeout) clearTimeout(forceKillTimeout);
			if (humanWaitReturnTimeout) clearTimeout(humanWaitReturnTimeout);
			request.signal?.removeEventListener("abort", abort);
			resolve(result);
		};

		const scheduleHumanWaitReturnIfReady = () => {
			if (settled || !hasHumanWaitFinalAnswer(stdout)) {
				if (humanWaitReturnTimeout) clearTimeout(humanWaitReturnTimeout);
				humanWaitReturnTimeout = undefined;
				return;
			}
			if (humanWaitReturnTimeout) clearTimeout(humanWaitReturnTimeout);
			humanWaitReturnTimeout = setTimeout(() => {
				if (settled || !hasHumanWaitFinalAnswer(stdout)) return;
				needsAttention = true;
				const message =
					"\n[pi] acpx returned a final human-wait response but did not finish the prompt; returning needs_attention and terminating idle adapter\n";
				stderr += message;
				request.onOutput?.("stderr", message);
				request.onStatus?.("needs_attention");
				detachTerminateChild();
				settle({ code: 0, signal: null });
			}, HUMAN_WAIT_IDLE_RETURN_MS);
		};

		heartbeat = setInterval(() => request.onStatus?.("running"), 1000);
		timeout = setTimeout(() => {
			timedOut = true;
			const message = `\n[pi] acpx timeout after ${timeoutSeconds}s; terminating subagent\n`;
			stderr += message;
			request.onOutput?.("stderr", message);
			request.onStatus?.("timeout");
			terminateChild();
		}, timeoutSeconds * 1000);

		if (request.signal?.aborted) abort();
		request.signal?.addEventListener("abort", abort, { once: true });

		child.stdout.on("data", (chunk) => {
			const text = chunk.toString();
			stdout += text;
			request.onOutput?.("stdout", text);
			request.onStatus?.("running");
			scheduleHumanWaitReturnIfReady();
		});

		child.stderr.on("data", (chunk) => {
			const text = chunk.toString();
			stderr += text;
			request.onOutput?.("stderr", text);
			request.onStatus?.("running");
			scheduleHumanWaitReturnIfReady();
		});

		child.on("error", (error) => {
			const message = `${error.name}: ${error.message}`;
			stderr += stderr ? `\n${message}` : message;
			settle({ code: 1, signal: null, error: message });
		});

		child.on("close", (code, childSignal) => {
			settle({ code, signal: childSignal });
		});
	});

	return { stdout, stderr, timedOut, aborted, needsAttention, ...completion };
}

/**
 * Stateful session CLI contract (Phase 4 MVP):
 * 1. `acpx <global-options> <agent-selector> sessions ensure --name <sessionId>`
 * 2. `acpx <global-options> <agent-selector> prompt -s <sessionId> <prompt>`
 *
 * Pantheon-packaged agents use an explicit `--agent <pi-acp command>` selector so
 * stale user-global acpx named-agent registries cannot break packaged routing.
 * Non-Pantheon external agents continue to use acpx named-agent routing.
 *
 * This delegates persistence and turn execution to acpx. `timeoutSeconds` is a
 * local wall-clock kill switch for each acpx process; `ttlSeconds` is forwarded
 * to acpx as queue/session idle TTL; `maxTurns` is forwarded to acpx so capable
 * adapters can stop runaway agent loops deterministically.
 */
async function runAcpxUntraced(request: AcpxRunRequest): Promise<AcpxRunResult> {
	const runType = request.runType ?? "exec";
	const cwd = request.cwd ?? process.cwd();
	const requestBackend = getAcpxBackend(request.agent);
	const timeoutSeconds = request.timeoutSeconds ?? requestBackend.defaultTimeoutSeconds ?? DEFAULT_ACPX_TIMEOUT_SECONDS;
	const command = resolveAcpxBinary(request.binaryPath);
	const startedAt = Date.now();
	const validationError = validateSafeguards(request, timeoutSeconds);

	if (validationError) {
		return {
			success: false,
			stdout: "",
			stderr: validationError,
			exitCode: 1,
			signal: null,
			timedOut: false,
			aborted: false,
			needsAttention: false,
			command,
			args: [],
			finalAnswer: "(no output)",
			fullTranscript: validationError,
			durationMs: Date.now() - startedAt,
			error: validationError,
		};
	}

	request.onStatus?.("starting");

	const sessionId = runType === "session" ? sanitizeAcpxSessionName(request.agent, request.sessionId) : undefined;
	const args =
		runType === "session"
			? buildSessionPromptArgs(request, cwd, timeoutSeconds, sessionId ?? "")
			: buildExecArgs(request, cwd, timeoutSeconds);
	let stdout = "";
	let stderr = "";
	let completion: {
		code: number | null;
		signal: NodeJS.Signals | null;
		timedOut: boolean;
		aborted: boolean;
		needsAttention: boolean;
		error?: string;
	};

	if (runType === "session") {
		// Resume-first: completed Claude-backed sessions can reject `sessions ensure` because acpx attempts
		// `session/set_model` on reconnect while claude-agent-acp does not implement that ACP method. Prompting
		// an existing session directly avoids the unsupported set_model path; only create the session when acpx
		// reports that the named session does not exist.
		const prompt = await spawnAcpxCommand(command, args, request, cwd, timeoutSeconds);
		if (isSuccessfulAcpxProcess(prompt) || !isMissingAcpxSessionFailure(prompt)) {
			stdout += prompt.stdout;
			stderr += prompt.stderr;
			completion = prompt;
		} else {
			const ensureArgs = buildSessionEnsureArgs(request, cwd, timeoutSeconds, sessionId ?? "");
			const ensure = await spawnAcpxCommand(command, ensureArgs, request, cwd, timeoutSeconds);
			stdout += ensure.stdout;
			stderr += ensure.stderr;

			if (!isSuccessfulAcpxProcess(ensure)) {
				completion = ensure;
			} else {
				const retry = await spawnAcpxCommand(command, args, request, cwd, timeoutSeconds);
				stdout += retry.stdout;
				stderr += retry.stderr;
				completion = retry;
			}
		}
	} else {
		completion = await spawnAcpxCommand(command, args, request, cwd, timeoutSeconds);
		stdout = completion.stdout;
		stderr = completion.stderr;
	}

	const success = completion.code === 0 && !completion.timedOut && !completion.aborted && !completion.error;
	request.onStatus?.(completion.needsAttention ? "needs_attention" : success ? "done" : "failed");

	const silentFailureHint =
		!success && !stdout.trim() && !stderr.trim()
			? `acpx produced no output while launching ${request.agent}; if this is a Pantheon agent, the packaged explicit agent command was used, so check acpx/pi-acp availability and agent launcher executability.`
			: undefined;
	if (silentFailureHint) stderr = silentFailureHint;
	const error = completion.error ?? silentFailureHint;

	const fullTranscript = stripPiStartupNoise(
		stripAnsi(
			[stdout.trimEnd(), stderr.trimEnd() ? `stderr:\n${stderr.trimEnd()}` : undefined].filter(Boolean).join("\n\n"),
		),
	);
	const finalAnswer = extractFinalAnswer(stdout);

	return {
		success,
		stdout,
		stderr,
		exitCode: completion.code,
		signal: completion.signal,
		timedOut: completion.timedOut,
		aborted: completion.aborted,
		needsAttention: completion.needsAttention,
		command,
		args,
		finalAnswer,
		fullTranscript,
		durationMs: Date.now() - startedAt,
		error,
	};
}

export async function runAcpx(request: AcpxRunRequest): Promise<AcpxRunResult> {
	return traceAcpxRun(request, () => runAcpxUntraced(request));
}
