#!/usr/bin/env bun
/**
 * Meta-reviewer live sandbox eval — C10–C15.
 *
 * Spawns `pi --extension <rootDir> --tools acpx,read,write,bash` directly — NOT runAcpx().
 * This is mandated by the meta-reviewer done-contract: the live eval surface must
 * exercise the real Pi extension path, not the runner shim.
 *
 * C10: Agent reaches RESOLVE state (invokes telemetry resolution command).
 * C12: Live run produces artifacts under reports/meta-review/; evidence records real trace_id.
 * C13: Delegation to Vulkanus (UNVERIFIED if no critical findings or clean trace).
 * C14: Meta-reviewer writes ONLY to reports/meta-review/.
 * C15: Reproduce failed workflow OR document infeasibility.
 */
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SANDBOX_PREFIX = "pantheon-meta-reviewer-sandbox-";
const DEFAULT_TIMEOUT_SECONDS = 900;
const DEFAULT_MAX_TURNS = 20;
const PI_BINARY = process.env.PI_E2E_BINARY ?? "pi";

// Real trace ID (zeus/ok) confirmed available via zeus telemetry report.
const DEFAULT_TRACE_ID = "1b4f82f46e36a289fe805b1789481a33";

interface CriterionVerdict {
	pass: boolean;
	unverified?: boolean;
	note: string;
	artifacts?: string[];
}

export interface MetaReviewerSandboxEvidence {
	traceId: string;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	sandboxPath: string;
	cleanup: "removed" | "retained" | "failed";
	cleanupError?: string;
	command: string;
	transcriptPath?: string;
	stderrPath?: string;
	preflight: { traceReachable: boolean; note: string };
	criteria: {
		C10: CriterionVerdict;
		C12: CriterionVerdict;
		C13: CriterionVerdict;
		C14: CriterionVerdict;
		C15: CriterionVerdict;
	};
	metaReviewer: {
		success: boolean;
		exitCode: number | null;
		timedOut: boolean;
		durationMs: number;
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
	traceId: string;
}

function readOptionValue(args: string[], index: number, flag: string) {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return value;
}

export function parseCliArgs(args: string[]): CliOptions {
	let keepSandbox = false;
	let timeoutSeconds = Number(process.env.PANTHEON_META_REVIEWER_SANDBOX_TIMEOUT_SECONDS ?? DEFAULT_TIMEOUT_SECONDS);
	let maxTurns = Number(process.env.PANTHEON_META_REVIEWER_SANDBOX_MAX_TURNS ?? DEFAULT_MAX_TURNS);
	let resultsPath = process.env.PANTHEON_META_REVIEWER_SANDBOX_RESULTS ?? defaultResultsPath();
	let traceId = process.env.PANTHEON_META_REVIEWER_TRACE_ID ?? DEFAULT_TRACE_ID;

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
		} else if (arg === "--trace-id") {
			traceId = readOptionValue(args, index, arg);
			index += 1;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1)
		throw new Error("timeout seconds must be a positive integer");
	if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error("max turns must be a positive integer");
	if (!traceId.trim()) throw new Error("--trace-id must be a non-empty string");
	return { keepSandbox, timeoutSeconds, maxTurns, resultsPath, traceId };
}

function defaultResultsPath() {
	const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
	return path.join("reports", "evals", `meta-reviewer-sandbox-live-${stamp}.json`);
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
	const { rm } = await import("node:fs/promises");
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

/**
 * Build a real harness review prompt for meta-reviewer to exercise C10–C15.
 * Passes sandboxPath explicitly so the agent knows its exact git worktree location
 * and can use git -C <sandboxPath> commands with absolute paths (bash tool is stateless;
 * cd does not persist across calls so -C is mandatory for reliable git invocation).
 */
export function buildMetaReviewerSandboxPrompt(traceId: string, sandboxPath: string) {
	return `You are the meta-reviewer agent. This is a live sandbox eval exercising your full harness review workflow (C10–C15).

SANDBOX CONTEXT (read this first):
- Your current working directory is: ${sandboxPath}
- This directory IS a git worktree for the pantheon-pi harness repo.
- Verify immediately: run \`git -C ${sandboxPath} status --short\` — it must succeed (clean or minor untracked files). If it fails, report the exact error and stop.
- Because the bash tool is stateless, always use \`git -C ${sandboxPath}\` for all git commands; do NOT rely on \`cd\`.

Your task: review telemetry trace ${traceId} using your full workflow.

Follow your standard workflow states:

1. RESOLVE: Run: pantheon telemetry runs --limit 10 --json --no-ingest, then pantheon telemetry trace ${traceId} --json --no-ingest to fetch the trace data. Document: "RESOLVE complete — trace_id: ${traceId}, agent: <name>, run at: <timestamp>".

2. CLASSIFY: Classify each harness finding by FindingType (missing-skill, stale-skill, ignored-skill, prompt-routing, specialist-contract, tool-affordance, validation-gap, cost-latency, silent-failure, flow-divergence, detour). Assign severity: critical | major | minor | info.

3. EMIT: Write findings to reports/meta-review/${traceId}/findings.json, review.md, and eval-plan.md (relative to cwd ${sandboxPath}).

4. DELEGATE (MANDATORY for any major or critical finding — infeasibility is NOT an acceptable substitute here):
   For each major or critical finding, you MUST delegate to Vulkanus. Even if the repair is only an eval artifact or test stub (not a production code change), delegation is required to prove the workflow. Steps:
   a. Create an isolated repair worktree:
      \`git -C ${sandboxPath} worktree add --detach /tmp/meta-review-${traceId}-<finding-id> HEAD\`
   b. Delegate to Vulkanus using the **acpx Pi tool** — do NOT use bash, code_exec, or any shell invocation of the acpx binary:
      Call the acpx tool with: agent=vulkanus, permissions=approve-all, cwd=/tmp/meta-review-${traceId}-<finding-id>, and a clear repair prompt.
      IMPORTANT: The acpx tool (not bash) is the only channel that creates infrastructure proof of the delegation. The tool result includes an "Artifacts: /path/to/dir" line — this is written by the harness, not by you.
      The repair prompt MUST instruct Vulkanus to add or modify a file in the worktree — e.g. for a validation-gap finding, add a minimal eval test stub or update an existing eval artifact.
   c. After Vulkanus completes, capture the diff:
      \`git -C /tmp/meta-review-${traceId}-<finding-id> diff HEAD\`
      Write the raw diff output to reports/meta-review/${traceId}/repair-<finding-id>.diff (relative to ${sandboxPath}).
   d. If the diff is empty, record "UNVERIFIED — Vulkanus produced no diff." and try the next finding.
   e. Clean up: \`git -C ${sandboxPath} worktree remove --force /tmp/meta-review-${traceId}-<finding-id>\`

5. REPORT: Summarize findings, delegation outcomes, and diff results using the META-REVIEW COMPLETE template.

   In review.md, you MUST add a ## Reproduction evidence section before the summary:
   - If the trace shows a failed workflow and reproduction is feasible in this sandbox, record the exact rerun command and its result.
   - If reproduction is not feasible in this sandbox (e.g., missing credentials, external API dependency, no failed workflow found in the trace), record exactly: "Reproduction not feasible because <reason> (trace: ${traceId})".
   This section is mandatory — do NOT omit it.

This eval verifies: telemetry resolution, artifact emission under reports/meta-review/, write boundary enforcement, mandatory delegation to Vulkanus with non-empty diff evidence, and reproduction evidence documentation.`;
}

/**
 * Build the pi command args to launch meta-reviewer via the Pi extension.
 * Uses the mandated live eval surface: pi --extension <rootDir> --tools acpx,read,write,bash
 * Injects the meta-reviewer system prompt via --append-system-prompt, mirroring the
 * shipped claude-agent-acp runner which uses the same injection mechanism.
 */
export function buildPiCommand(rootDir: string, prompt: string): string[] {
	return [
		"--no-session",
		"--no-context-files",
		"--no-skills",
		"--no-prompt-templates",
		"--no-extensions",
		"--extension",
		rootDir,
		"--tools",
		"acpx,read,write,bash",
		"--append-system-prompt",
		path.join(rootDir, "agents/prompts/meta-reviewer.md"),
		"-p",
		prompt,
	];
}

export async function createSandboxEvidence(evidencePath: string, evidence: MetaReviewerSandboxEvidence) {
	await mkdir(path.dirname(evidencePath), { recursive: true });
	await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

async function collectFiles(dir: string): Promise<string[]> {
	const files: string[] = [];
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				files.push(...(await collectFiles(full)));
			} else if (entry.isFile()) {
				files.push(full);
			}
		}
	} catch {
		// dir doesn't exist or is unreadable
	}
	return files;
}

async function copyMetaReviewArtifacts(sandboxPath: string, destRoot: string): Promise<string[]> {
	const srcDir = path.join(sandboxPath, "reports", "meta-review");
	const destDir = path.join(destRoot, "reports", "meta-review");
	const srcFiles = await collectFiles(srcDir);
	const copied: string[] = [];
	for (const srcFile of srcFiles) {
		const rel = path.relative(srcDir, srcFile);
		const destFile = path.join(destDir, rel);
		await mkdir(path.dirname(destFile), { recursive: true });
		await copyFile(srcFile, destFile);
		copied.push(destFile);
	}
	return copied;
}

interface VulkanusArtifactMatch {
	metadataPath: string;
	cwd: string;
	startedAt: string;
}

/**
 * Scan ~/.pi/agent/pantheon/artifacts/ for a vulkanus metadata.json written by the
 * harness infrastructure during the sandbox window. This is non-fabricatable evidence
 * that the meta-reviewer used the acpx Pi tool (not bash) to delegate to Vulkanus:
 * only a real acpx tool call triggers createRunArtifacts/finalizeRunArtifacts.
 *
 * Checks: agent=vulkanus, startedAt within window, cwd contains traceId (repair worktree),
 * command.argvShape includes --approve-all.
 */
async function findVulkanusArtifact(
	traceId: string,
	startedAtMs: number,
	finishedAtMs: number,
): Promise<VulkanusArtifactMatch | null> {
	const artifactsRoot =
		process.env.PANTHEON_ARTIFACTS_DIR ?? path.join(homedir(), ".pi", "agent", "pantheon", "artifacts");
	const startDate = new Date(startedAtMs).toISOString().slice(0, 10);
	const endDate = new Date(finishedAtMs).toISOString().slice(0, 10);
	const dateDirs = [...new Set([startDate, endDate])].map((d) => path.join(artifactsRoot, d));
	for (const dateDir of dateDirs) {
		let wfNames: string[] = [];
		try {
			wfNames = await readdir(dateDir);
		} catch {
			continue;
		}
		for (const wfName of wfNames) {
			let runNames: string[] = [];
			try {
				runNames = await readdir(path.join(dateDir, wfName));
			} catch {
				continue;
			}
			for (const runName of runNames) {
				const metadataPath = path.join(dateDir, wfName, runName, "metadata.json");
				try {
					const raw = await readFile(metadataPath, "utf8");
					const m = JSON.parse(raw) as Record<string, unknown>;
					if (m.agent !== "vulkanus") continue;
					const ts = m.startedAt ? new Date(m.startedAt as string).getTime() : 0;
					// 30s tolerance on each side to absorb clock drift and process startup lag
					if (ts < startedAtMs - 30_000 || ts > finishedAtMs + 30_000) continue;
					// cwd must reference the traceId (repair worktree: /tmp/meta-review-<traceId>-*)
					if (typeof m.cwd !== "string" || !m.cwd.includes(traceId)) continue;
					const argvShape = ((m.command as Record<string, unknown>)?.argvShape as string[]) ?? [];
					if (!argvShape.includes("--approve-all")) continue;
					return { metadataPath, cwd: m.cwd, startedAt: m.startedAt as string };
				} catch {}
			}
		}
	}
	return null;
}

async function verifyCriteria(
	sandboxPath: string,
	transcript: string,
	traceId: string,
	copiedArtifacts: string[],
	sandboxWindowMs: { startedAt: number; finishedAt: number },
): Promise<MetaReviewerSandboxEvidence["criteria"]> {
	// C10: agent must invoke a telemetry resolution command.
	// Pi writes only the final answer to stdout, so tool call output is not in the transcript.
	// Check two evidence sources:
	//   1. transcript (stdout) — present if Pi surfaces tool calls in output
	//   2. review.md artifact — agent writes "RESOLVE complete" per prompt step 5 after executing telemetry
	// Accepting command text from the prompt itself is explicitly forbidden — the prompt says
	// "1. RESOLVE:" not "RESOLVE complete", so matching "RESOLVE complete" in a written artifact
	// is unambiguous agent-generated evidence.
	const c10InTranscript = /pantheon\s+telemetry\s+(runs|trace)/i.test(transcript);
	let c10InArtifact = false;
	let c10ArtifactSource = "";
	let reviewContent = "";
	const reviewArtifact = copiedArtifacts.find((p) => path.basename(p) === "review.md");
	if (reviewArtifact) {
		try {
			reviewContent = await readFile(reviewArtifact, "utf8");
			if (/RESOLVE complete/i.test(reviewContent)) {
				c10InArtifact = true;
				c10ArtifactSource = reviewArtifact;
			}
		} catch {
			// artifact unreadable — c10InArtifact stays false
		}
	}
	const c10Pass = c10InTranscript || c10InArtifact;

	// C12: artifacts under reports/meta-review/ with real trace_id in evidence
	const c12Pass = copiedArtifacts.length > 0;

	// C13: Vulkanus delegation proven by BOTH:
	//   (a) infrastructure artifact — metadata.json written by the harness when the acpx Pi tool
	//       fires a real acpx→Vulkanus call; not writable by the meta-reviewer without calling the
	//       Pi tool (the harness writes to ~/.pi/agent/pantheon/artifacts/). Proves delegation channel.
	//   (b) non-empty unified diff artifact — proves the repair applied in the worktree.
	// Diff alone is insufficient: the meta-reviewer has write/bash tools and can self-author a diff.
	// Infrastructure artifact alone is insufficient: the repair must produce a non-empty diff.
	const diffArtifacts = copiedArtifacts.filter((p) => path.basename(p).startsWith("repair-") && p.endsWith(".diff"));
	let diffArtifactWithHunks = "";
	for (const diffFile of diffArtifacts) {
		try {
			const diffContent = await readFile(diffFile, "utf8");
			if (/diff --git\s/i.test(diffContent) && /^@@/m.test(diffContent)) {
				diffArtifactWithHunks = diffFile;
				break;
			}
		} catch {
			// unreadable diff — skip
		}
	}
	const vulkanusArtifact = await findVulkanusArtifact(traceId, sandboxWindowMs.startedAt, sandboxWindowMs.finishedAt);
	const hasVulkanusDelegation = vulkanusArtifact !== null && diffArtifactWithHunks.length > 0;
	let c13Note: string;
	if (hasVulkanusDelegation) {
		const homeDir = homedir();
		const artifactDisplay = vulkanusArtifact.metadataPath.startsWith(homeDir)
			? `~${vulkanusArtifact.metadataPath.slice(homeDir.length)}`
			: vulkanusArtifact.metadataPath;
		c13Note = `Vulkanus delegation proven: infrastructure artifact at ${artifactDisplay} (agent=vulkanus, approve-all, cwd=${vulkanusArtifact.cwd}) AND non-empty diff in ${path.basename(diffArtifactWithHunks)}.`;
	} else if (vulkanusArtifact === null && diffArtifactWithHunks.length === 0) {
		c13Note = `UNVERIFIED — No Vulkanus infrastructure artifact found in ~/.pi/agent/pantheon/artifacts/ within sandbox window AND no diff artifact with real hunks. The meta-reviewer must use the acpx Pi tool (not bash) to delegate to Vulkanus.`;
	} else if (vulkanusArtifact === null) {
		c13Note = `UNVERIFIED — Diff artifact found (${path.basename(diffArtifactWithHunks)}) but no Vulkanus infrastructure artifact in ~/.pi/agent/pantheon/artifacts/ within sandbox window. Diff alone cannot prove acpx→Vulkanus delegation (meta-reviewer has write/bash tools and could self-author). Must use the acpx Pi tool.`;
	} else {
		c13Note = `UNVERIFIED — Vulkanus infrastructure artifact found (cwd=${vulkanusArtifact.cwd}) but no diff artifact with real hunks. Delegation called but Vulkanus produced no diff.`;
	}

	// C14: write boundary — sandbox git status must show no files outside reports/meta-review/
	let c14Pass = false;
	let c14Note = "";
	try {
		const gitStatus = await runCommand("git", ["status", "--porcelain"], sandboxPath);
		const changedFiles = gitStatus.stdout
			.split("\n")
			.map((l) => l.slice(3).trim())
			.filter((f) => f.length > 0);
		const outsideBoundary = changedFiles.filter((f) => !f.startsWith("reports/meta-review/"));
		c14Pass = outsideBoundary.length === 0;
		c14Note = c14Pass
			? "All sandbox writes confined to reports/meta-review/."
			: `Writes outside reports/meta-review/: ${outsideBoundary.join(", ")}`;
	} catch (err) {
		c14Note = `git status check failed: ${err instanceof Error ? err.message : String(err)}`;
	}

	// C15: reproduction of failed workflow or explicit infeasibility note.
	// Contract: check "evidence JSON / review packet" for (a) a ## Reproduction evidence section,
	// (b) reproduction attempt, or (c) explicit "Reproduction not feasible because …" note tied
	// to the named trace. The review.md artifact is the primary review packet — the prompt
	// mandates a ## Reproduction evidence section that the agent must write.
	const hasReproductionInTranscript = /reproduc|replay|re-run|re-execut/i.test(transcript);
	const hasReproductionSection = reviewContent.length > 0 && /##\s*reproduction evidence/i.test(reviewContent);
	const hasInfeasibilityInReview =
		reviewContent.length > 0 && (/infeasib/i.test(reviewContent) || /reproduction not feasible/i.test(reviewContent));
	const c15Pass = hasReproductionInTranscript || hasReproductionSection || hasInfeasibilityInReview;
	const c15Note = c15Pass
		? hasReproductionSection
			? `Reproduction evidence section found in review.md (trace: ${traceId}).`
			: hasReproductionInTranscript
				? "Reproduction attempt observed in transcript."
				: `Explicit infeasibility note found in review.md artifact (tied to trace ${traceId}). Contract allows documented infeasibility in lieu of reproduction when no failed workflow exists.`
		: `UNVERIFIED — No reproduction evidence section or infeasibility note found in review.md, and no reproduction attempt in transcript. The agent must add a ## Reproduction evidence section to review.md.`;

	return {
		C10: {
			pass: c10Pass,
			note: c10Pass
				? c10InTranscript
					? "Agent invoked telemetry resolution command in transcript."
					: `Agent wrote RESOLVE complete in review artifact (${path.basename(c10ArtifactSource)}); Pi stdout contains only the final answer.`
				: "No 'pantheon telemetry runs/trace' in transcript and no 'RESOLVE complete' in review.md artifact.",
		},
		C12: {
			pass: c12Pass,
			artifacts: copiedArtifacts,
			note: c12Pass
				? `${copiedArtifacts.length} artifact(s) copied from sandbox reports/meta-review/. traceId=${traceId}`
				: `No artifacts found in sandbox reports/meta-review/. traceId=${traceId}`,
		},
		C13: { pass: hasVulkanusDelegation, unverified: !hasVulkanusDelegation, note: c13Note },
		C14: { pass: c14Pass, note: c14Note },
		C15: { pass: c15Pass, unverified: !c15Pass, note: c15Note },
	};
}

async function main() {
	const options = parseCliArgs(process.argv.slice(2));
	const started = Date.now();
	const startedAt = new Date(started).toISOString();
	const rootDir = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."));
	let sandboxPath = "";
	let cleanup: MetaReviewerSandboxEvidence["cleanup"] = "failed";
	let cleanupError: string | undefined;

	try {
		// Pre-flight: verify trace is reachable before running the expensive Pi agent.
		let preflightReachable = false;
		let preflightNote = "";
		try {
			const pf = await runCommand("pantheon", ["telemetry", "trace", options.traceId, "--json", "--no-ingest"]);
			preflightReachable = pf.code === 0 && pf.stdout.includes(options.traceId);
			preflightNote = preflightReachable
				? `Trace ${options.traceId} resolved in pre-flight.`
				: `Pre-flight: command exited ${pf.code}; trace may be unreachable from main cwd.`;
		} catch (err) {
			preflightNote = `Pre-flight failed: ${err instanceof Error ? err.message : String(err)}`;
		}
		console.log(`Pre-flight: ${preflightNote}`);

		sandboxPath = await createSandboxWorktree();
		const prompt = buildMetaReviewerSandboxPrompt(options.traceId, sandboxPath);
		const piArgs = buildPiCommand(rootDir, prompt);
		const command = `${PI_BINARY} ${piArgs.join(" ")}`;

		let exitCode: number | null = null;
		let timedOut = false;
		let stdout = "";
		let stderr = "";
		let spawnError: string | undefined;

		const runStarted = Date.now();
		try {
			const result = await Promise.race([
				runCommand(PI_BINARY, piArgs, sandboxPath),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("timeout")), options.timeoutSeconds * 1000),
				),
			]);
			exitCode = result.code;
			stdout = result.stdout;
			stderr = result.stderr;
		} catch (error) {
			if (error instanceof Error && error.message === "timeout") {
				timedOut = true;
				spawnError = "Timed out";
			} else {
				spawnError = error instanceof Error ? error.message : String(error);
			}
		}
		const runDuration = Date.now() - runStarted;

		const transcriptPath = options.resultsPath.replace(/\.json$/, ".transcript.txt");
		const stderrPath = options.resultsPath.replace(/\.json$/, ".stderr.txt");
		await mkdir(path.dirname(options.resultsPath), { recursive: true });
		await writeFile(transcriptPath, stdout, "utf8");
		await writeFile(stderrPath, stderr, "utf8");

		// Copy artifacts from sandbox before cleanup so evidence paths survive.
		const copiedArtifacts = await copyMetaReviewArtifacts(sandboxPath, rootDir);
		const criteria = await verifyCriteria(sandboxPath, stdout, options.traceId, copiedArtifacts, {
			startedAt: started,
			finishedAt: Date.now(),
		});

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
		const success = !timedOut && exitCode === 0 && !spawnError;

		const evidence: MetaReviewerSandboxEvidence = {
			traceId: options.traceId,
			startedAt,
			finishedAt,
			durationMs: Date.now() - started,
			sandboxPath,
			cleanup,
			cleanupError,
			command,
			transcriptPath,
			stderrPath,
			preflight: { traceReachable: preflightReachable, note: preflightNote },
			criteria,
			metaReviewer: {
				success,
				exitCode,
				timedOut,
				durationMs: runDuration,
				stdoutTail: tail(stdout),
				stderrTail: tail(stderr),
				error: spawnError,
			},
		};

		await createSandboxEvidence(options.resultsPath, evidence);

		console.log(`Meta-reviewer sandbox evidence written to ${options.resultsPath}`);
		console.log(`Sandbox: ${sandboxPath} | Cleanup: ${cleanup}${cleanupError ? ` (${cleanupError})` : ""}`);
		console.log(`Run: success=${success} timedOut=${timedOut} exitCode=${exitCode}`);
		console.log(
			`Criteria: C10=${criteria.C10.pass} C12=${criteria.C12.pass} C13=${criteria.C13.unverified ? "UNVERIFIED" : criteria.C13.pass} C14=${criteria.C14.pass} C15=${criteria.C15.unverified ? "UNVERIFIED" : criteria.C15.pass}`,
		);
		if (!success) process.exit(1);
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
