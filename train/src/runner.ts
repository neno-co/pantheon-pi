// SDK-backed stage runner.
//
// The orchestrator drives an in-process Claude Agent SDK session per stage,
// forces a structured result via `outputFormat`, and reads the outcome
// directly — the agent never has to remember to "report back". Every message is
// streamed to a per-stage JSONL log so unattended runs are debuggable after the
// fact.

import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { StageOutcomeSchema, type StageOutcome as StageResult } from "./core.ts";

export type StageRunResult = StageResult & {
	// Execution metadata (filled in by the runner, not the agent).
	subtype: string;
	sessionId?: string;
	costUsd?: number;
	numTurns?: number;
	logPath: string;
};

// JSON Schema handed to the SDK. The agent is forced to emit an object of this
// shape as its final result, which the orchestrator parses into a transition.
const OUTPUT_SCHEMA: Record<string, unknown> = {
	type: "object",
	properties: {
		status: {
			type: "string",
			enum: ["success", "blocked", "failed"],
			description:
				"success = the stage completed and any required PR/commits exist; blocked = a decision needs a human; failed = the stage could not be completed.",
		},
		prUrl: { type: "string", description: "URL of the PR opened or updated by this stage, if any." },
		reason: {
			type: "string",
			description: "One-line summary of the outcome (or the blocking question / failure cause).",
		},
	},
	required: ["status", "reason"],
	additionalProperties: false,
};

// Even with bypassPermissions we keep a deny-list for irrecoverable operations.
// The worktree bounds the blast radius; this guards the shared repo/remote.
const DESTRUCTIVE_DENY = [
	"Bash(rm -rf /*)",
	"Bash(rm -rf ~*)",
	"Bash(git push --force*)",
	"Bash(git push -f*)",
	"Bash(git reset --hard origin*)",
];

// Max times a turn-capped stage is resumed to continue (beyond the initial run).
// Bounds worst-case spend: total turns ≤ maxTurns × (1 + MAX_CONTINUATIONS).
const MAX_CONTINUATIONS = 2;

type TextSink = (line: string) => void;

function blockSummary(message: unknown): string | null {
	const content = (message as { message?: { content?: unknown } })?.message?.content;
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const block of content) {
		const b = block as { type?: string; name?: string; text?: string };
		if (b.type === "tool_use" && b.name) parts.push(`→ ${b.name}`);
		else if (b.type === "text" && b.text?.trim()) parts.push(b.text.trim().slice(0, 120).replace(/\s+/g, " "));
	}
	return parts.length ? parts.join("  ") : null;
}

export async function runStageWithSdk(opts: {
	prompt: string;
	cwd: string;
	model: string;
	taskId: string;
	stage: string;
	logDir: string;
	maxTurns: number;
	timeoutMs: number;
	bypassPermissions: boolean;
	onText?: TextSink;
}): Promise<StageRunResult> {
	const log: TextSink = opts.onText ?? ((line) => console.log(line));

	mkdirSync(opts.logDir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const logPath = join(opts.logDir, `${opts.taskId}-${opts.stage}-${stamp}.jsonl`);
	const logFd = openSync(logPath, "a");
	const encoder = new TextEncoder();
	const writeLine = (obj: unknown) => {
		writeSync(logFd, encoder.encode(`${JSON.stringify(obj)}\n`));
	};

	let structured: unknown = null;
	let resultSubtype = "unknown";
	let resultText = "";
	let sessionId: string | undefined;
	let costUsd = 0;
	let numTurns = 0;
	let resultErrors: string[] = [];
	let timedOut = false;

	// A genuinely large stage can exhaust its turn budget mid-task. Rather than
	// discard the work, resume the SAME session (which retains the full prior
	// conversation and the files already written) and let it finish — bounded so
	// a stuck task can't run away.
	for (let attempt = 0; ; attempt++) {
		const resuming = attempt > 0;
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), opts.timeoutMs);
		resultErrors = [];
		try {
			for await (const message of query({
				prompt: resuming
					? "You hit a turn limit mid-task; your prior work is already saved in this worktree. Continue exactly where you left off, finish the stage, and return your structured result."
					: opts.prompt,
				options: {
					cwd: opts.cwd,
					model: opts.model,
					abortController: abort,
					maxTurns: opts.maxTurns,
					// Resume the prior session on continuation runs so the full context
					// and committed/working files carry over.
					...(resuming && sessionId ? { resume: sessionId } : {}),
					// Project settings + skills must be loaded explicitly in the SDK,
					// otherwise CLAUDE.md and the /implement-linear family of slash
					// commands are invisible to the agent.
					settingSources: ["user", "project", "local"],
					skills: "all",
					permissionMode: opts.bypassPermissions ? "bypassPermissions" : "acceptEdits",
					allowDangerouslySkipPermissions: opts.bypassPermissions,
					disallowedTools: DESTRUCTIVE_DENY,
					outputFormat: { type: "json_schema", schema: OUTPUT_SCHEMA },
					stderr: (d: string) => writeLine({ type: "stderr", data: d }),
				},
			})) {
				writeLine(message);

				if (message.type === "system" && message.subtype === "init") {
					sessionId = message.session_id;
					log(
						`  [session ${message.session_id.slice(0, 8)}${resuming ? " resumed" : ""}] model=${opts.model} cwd=${opts.cwd}`,
					);
				} else if (message.type === "assistant") {
					const summary = blockSummary(message);
					if (summary) log(`  ${summary}`);
				} else if (message.type === "result") {
					resultSubtype = message.subtype;
					sessionId = message.session_id;
					costUsd += message.total_cost_usd ?? 0;
					numTurns += message.num_turns ?? 0;
					if (message.subtype === "success") {
						structured = message.structured_output;
						resultText = message.result;
					} else {
						resultErrors = (message as { errors?: string[] }).errors ?? [];
					}
				}
			}
		} catch (error) {
			timedOut = abort.signal.aborted;
			resultSubtype = timedOut ? "error_timeout" : "error_exception";
			resultErrors = [error instanceof Error ? error.message : String(error)];
			writeLine({ type: "runner_error", subtype: resultSubtype, message: resultErrors[0] });
		} finally {
			clearTimeout(timer);
		}

		// The SDK reports a turn-limit either as the error_max_turns result subtype
		// or (observed) as a thrown error whose message mentions it.
		const hitMaxTurns =
			resultSubtype === "error_max_turns" ||
			(resultSubtype === "error_exception" && resultErrors.some((e) => /maximum number of turns/i.test(e)));
		if (hitMaxTurns && attempt < MAX_CONTINUATIONS && sessionId && !timedOut) {
			log(
				`  [turn limit hit — resuming session ${sessionId.slice(0, 8)} (continuation ${attempt + 1}/${MAX_CONTINUATIONS})]`,
			);
			writeLine({ type: "runner_resume", continuation: attempt + 1, sessionId });
			continue;
		}
		break;
	}
	closeSync(logFd);

	const meta = { subtype: resultSubtype, sessionId, costUsd, numTurns, logPath };

	// Happy path: the SDK enforced our schema, so parse it into a transition.
	const parsed = StageOutcomeSchema.safeParse(structured);
	if (resultSubtype === "success" && parsed.success) {
		return { ...parsed.data, ...meta };
	}

	// Anything else (exhausted continuations, exception, timeout, malformed/missing
	// output) is a block — surfaced to the human with the real cause and a log.
	const detail = resultErrors.length ? resultErrors.join("; ") : resultText || "no structured output returned";
	return {
		status: "blocked",
		reason: `Stage ended as ${resultSubtype}: ${detail} (log: ${logPath})`,
		...meta,
	};
}
