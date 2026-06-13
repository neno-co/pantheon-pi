#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type AcpxRunResult, runAcpx } from "../../src/runner/index.ts";

const SANDBOX_PREFIX = "pantheon-argus-sandbox-";
const DEFAULT_TIMEOUT_SECONDS = 900;
const DEFAULT_MAX_TURNS = 20;

export interface ArgusSandboxEvidence {
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	sandboxPath: string;
	cleanup: "removed" | "retained" | "failed";
	cleanupError?: string;
	seededDiffSummary: string;
	command: string;
	transcriptPath?: string;
	stderrPath?: string;
	argus: {
		success: boolean;
		exitCode: number | null;
		timedOut: boolean;
		durationMs: number;
		finalAnswer: string;
		stdoutTail: string;
		stderrTail: string;
		error?: string;
	};
}

interface CliOptions {
	keepSandbox: boolean;
	timeoutSeconds: number;
	maxTurns: number;
	resultsPath: string;
}

function readOptionValue(args: string[], index: number, flag: string) {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return value;
}

export function parseCliArgs(args: string[]): CliOptions {
	let keepSandbox = false;
	let timeoutSeconds = Number(process.env.PANTHEON_ARGUS_SANDBOX_TIMEOUT_SECONDS ?? DEFAULT_TIMEOUT_SECONDS);
	let maxTurns = Number(process.env.PANTHEON_ARGUS_SANDBOX_MAX_TURNS ?? DEFAULT_MAX_TURNS);
	let resultsPath = process.env.PANTHEON_ARGUS_SANDBOX_RESULTS ?? defaultResultsPath();

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--keep-sandbox") {
			keepSandbox = true;
		} else if (arg === "--timeout-seconds") {
			timeoutSeconds = Number(readOptionValue(args, index, arg));
			index += 1;
		} else if (arg === "--max-turns") {
			maxTurns = Number(readOptionValue(args, index, arg));
			index += 1;
		} else if (arg === "--results") {
			resultsPath = readOptionValue(args, index, arg);
			index += 1;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1)
		throw new Error("timeout seconds must be a positive integer");
	if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error("max turns must be a positive integer");
	return { keepSandbox, timeoutSeconds, maxTurns, resultsPath };
}

function defaultResultsPath() {
	const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
	return path.join("reports", "evals", `argus-sandbox-evidence-${stamp}.json`);
}

function tail(text: string, maxChars = 20_000) {
	return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

function runCommand(command: string, args: string[], cwd = process.cwd()) {
	return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
		const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ stdout, stderr, code }));
	});
}

async function runRequired(command: string, args: string[], cwd = process.cwd()) {
	const result = await runCommand(command, args, cwd);
	if (result.code !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed with code ${result.code}\n${result.stderr || result.stdout}`);
	}
	return result;
}

export function isSafeSandboxPath(candidate: string) {
	const resolved = path.resolve(candidate);
	const tempRoot = path.resolve(tmpdir());
	const basename = path.basename(resolved);
	return resolved.startsWith(`${tempRoot}${path.sep}`) && basename.startsWith(SANDBOX_PREFIX) && resolved !== tempRoot;
}

export async function cleanupSandbox(sandboxPath: string) {
	if (!isSafeSandboxPath(sandboxPath)) throw new Error(`Refusing to clean unsafe sandbox path: ${sandboxPath}`);
	await rm(sandboxPath, { recursive: true, force: true });
}

export async function removeSandboxWorktree(sandboxPath: string) {
	if (!isSafeSandboxPath(sandboxPath)) throw new Error(`Refusing to remove unsafe sandbox path: ${sandboxPath}`);
	try {
		await runRequired("git", ["worktree", "remove", "--force", sandboxPath]);
	} finally {
		await cleanupSandbox(sandboxPath);
	}
}

export async function createSandboxWorktree() {
	const sandboxPath = await mkdtemp(path.join(tmpdir(), SANDBOX_PREFIX));
	try {
		await runRequired("git", ["worktree", "add", "--detach", sandboxPath, "HEAD"]);
		return sandboxPath;
	} catch (error) {
		await cleanupSandbox(sandboxPath);
		throw error;
	}
}

export async function seedSandboxDiff(sandboxPath: string) {
	const srcDir = path.join(sandboxPath, "src");
	await mkdir(srcDir, { recursive: true });
	await writeFile(
		path.join(srcDir, "argus-sandbox-target.ts"),
		`// ARGUS_SANDBOX_EVAL_MARKER: intentionally tiny live Argus dirty-diff target.\nexport function argusSandboxTarget(input: string) {\n\tif (input.length === 0) return "empty"\n\treturn input.trim()\n}\n`,
		"utf8",
	);
	await runRequired("git", ["add", "-N", "src/argus-sandbox-target.ts"], sandboxPath);
}

export function buildArgusSandboxPrompt() {
	return `Run adversarial review on the current sandbox dirty diff.

Context:
- This cwd is an isolated temporary git worktree created only for an Argus hunter-swarm eval.
- The seeded diff is intentionally tiny and located at src/argus-sandbox-target.ts.
- Use the normal Argus workflow: triage the diff, dispatch relevant hunters when warranted, run proof checks if findings are claimed, and return a verdict.

Must do:
- Inspect git diff -- src/argus-sandbox-target.ts before deciding which hunters are relevant.
- Report whether hunters were dispatched or whether triage skipped them.
- Include the final verdict and concise evidence.

Must not do:
- Do not clean or mutate any path outside this sandbox.
- Do not push, commit, or modify git state outside normal temporary Argus artifacts in this cwd.
- Do not fake hunter evidence if a hunter times out or fails.`;
}

function evidenceFromResult(params: {
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	sandboxPath: string;
	cleanup: ArgusSandboxEvidence["cleanup"];
	command: string;
	result: AcpxRunResult;
	transcriptPath?: string;
	stderrPath?: string;
	cleanupError?: string;
}): ArgusSandboxEvidence {
	return {
		startedAt: params.startedAt,
		finishedAt: params.finishedAt,
		durationMs: params.durationMs,
		sandboxPath: params.sandboxPath,
		cleanup: params.cleanup,
		cleanupError: params.cleanupError,
		seededDiffSummary: "Added src/argus-sandbox-target.ts with ARGUS_SANDBOX_EVAL_MARKER tiny TypeScript diff.",
		command: params.command,
		transcriptPath: params.transcriptPath,
		stderrPath: params.stderrPath,
		argus: {
			success: params.result.success,
			exitCode: params.result.exitCode,
			timedOut: params.result.timedOut,
			durationMs: params.result.durationMs,
			finalAnswer: params.result.finalAnswer,
			stdoutTail: tail(params.result.stdout),
			stderrTail: tail(params.result.stderr),
			error: params.result.error,
		},
	};
}

export async function createSandboxEvidence(evidencePath: string, evidence: ArgusSandboxEvidence) {
	await mkdir(path.dirname(evidencePath), { recursive: true });
	await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

async function main() {
	const options = parseCliArgs(process.argv.slice(2));
	const started = Date.now();
	const startedAt = new Date(started).toISOString();
	let sandboxPath = "";
	let cleanup: ArgusSandboxEvidence["cleanup"] = "failed";
	let cleanupError: string | undefined;
	let result: AcpxRunResult | undefined;

	try {
		sandboxPath = await createSandboxWorktree();
		await seedSandboxDiff(sandboxPath);
		const command = `bun run evals/scripts/run-argus-sandbox-eval.ts --results ${options.resultsPath}`;
		result = await runAcpx({
			agent: "argus",
			prompt: buildArgusSandboxPrompt(),
			cwd: sandboxPath,
			permissions: "approve-all",
			timeoutSeconds: options.timeoutSeconds,
			maxTurns: options.maxTurns,
		});

		const transcriptPath = options.resultsPath.replace(/\.json$/, ".transcript.txt");
		const stderrPath = options.resultsPath.replace(/\.json$/, ".stderr.txt");
		await mkdir(path.dirname(options.resultsPath), { recursive: true });
		await writeFile(transcriptPath, result.fullTranscript || result.stdout, "utf8");
		await writeFile(stderrPath, result.stderr, "utf8");

		if (options.keepSandbox) {
			cleanup = "retained";
		} else {
			try {
				await removeSandboxWorktree(sandboxPath);
				cleanup = "removed";
			} catch (error) {
				cleanup = "failed";
				cleanupError = error instanceof Error ? error.message : String(error);
			}
		}

		const finishedAt = new Date().toISOString();
		const evidence = evidenceFromResult({
			startedAt,
			finishedAt,
			durationMs: Date.now() - started,
			sandboxPath,
			cleanup,
			cleanupError,
			command,
			result,
			transcriptPath,
			stderrPath,
		});
		await createSandboxEvidence(options.resultsPath, evidence);

		console.log(`Argus sandbox evidence written to ${options.resultsPath}`);
		console.log(`Sandbox path: ${sandboxPath}`);
		console.log(`Cleanup: ${cleanup}${cleanupError ? ` (${cleanupError})` : ""}`);
		console.log(`Argus success: ${result.success}; timedOut: ${result.timedOut}; exitCode: ${result.exitCode}`);
		console.log(`Final answer:\n${result.finalAnswer}`);
		if (!result.success) process.exit(1);
	} catch (error) {
		if (sandboxPath && !options.keepSandbox) {
			try {
				await removeSandboxWorktree(sandboxPath);
			} catch {
				// Preserve the original failure below.
			}
		}
		console.error(error instanceof Error ? error.stack : String(error));
		process.exit(1);
	}
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
	await main();
}
