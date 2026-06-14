// Command handlers. This is the I/O orchestration layer: it loads/saves state,
// appends questions, acquires the per-project lock, prepares worktrees, and
// drives the SDK runner. All state-machine logic lives in core.ts; this module
// only sequences side effects around it.

import { resolve } from "node:path";
import {
	activateNextQueuedTask,
	applyStageOutcome,
	blockTask,
	buildInitialState,
	DEFAULT_WORKTREE_SETUP,
	findTask,
	nowIso,
	type QuestionRecord,
	QueueSchema,
	renderStagePrompt,
	STAGE_MAX_TURNS,
	STAGE_TIMEOUT_MS,
	type StageName,
	StateSchema,
	slug,
	statusToStage,
	type TrainState,
} from "./core.ts";
import { appendText, ensureDir, pathExists, readJson, writeJson } from "./io.ts";
import { acquireLock, forceUnlock, readLock } from "./lock.ts";
import {
	listProjectPaths,
	type ProjectPaths,
	projectPaths,
	readActiveSlug,
	resolveProject,
	resolveProjectForCreate,
	writeActiveSlug,
} from "./paths.ts";
import { runStageWithSdk } from "./runner.ts";
import { assertBaseOnOrigin, prepareWorktree, resolveRepoRoot } from "./worktree.ts";

export type Flags = Record<string, unknown>;

const STAGE_NAMES: StageName[] = ["implement", "review", "address", "merge"];

function asStage(value: string): StageName {
	if (!STAGE_NAMES.includes(value as StageName)) {
		throw new Error("stage must be implement|review|address|merge");
	}
	return value as StageName;
}

async function loadState(statePath: string): Promise<TrainState> {
	return await readJson(statePath, StateSchema);
}

async function saveState(statePath: string, state: TrainState): Promise<void> {
	state.updatedAt = nowIso();
	await writeJson(statePath, state);
}

async function appendQuestion(questionsPath: string, record: QuestionRecord): Promise<void> {
	const block = [
		`## ${record.task.id} (${record.stage})`,
		`- Time: ${nowIso()}`,
		`- Branch: ${record.task.branch}`,
		`- Question: ${record.question}`,
		"",
	].join("\n");
	await appendText(questionsPath, block);
}

async function flushQuestions(questionsPath: string, records: QuestionRecord[]): Promise<void> {
	for (const record of records) await appendQuestion(questionsPath, record);
}

// Resolve the local repo path for a create command: queue value wins, then
// --repo, then the current working directory. Resolved to an absolute path and
// verified to exist.
async function resolveRepoPath(flags: Flags, queueRepoPath?: string): Promise<string> {
	const raw = queueRepoPath || (flags.repo ? String(flags.repo) : "") || process.cwd();
	const abs = resolve(raw);
	if (!(await pathExists(abs))) throw new Error(`Repo path does not exist: ${abs} (set queue.repoPath or pass --repo)`);
	return abs;
}

// ---------------------------------------------------------------------------
// Project lifecycle
// ---------------------------------------------------------------------------

async function initProject(paths: ProjectPaths, state: TrainState, makeActive: boolean): Promise<void> {
	await ensureDir(paths.dir);
	await saveState(paths.statePath, state);
	if (makeActive) await writeActiveSlug(paths.slug);
	console.log(`Initialized train state at ${paths.statePath} (project: ${paths.slug})`);
}

export async function cmdInit(flags: Flags): Promise<void> {
	const queuePath = String(flags.queue ?? "");
	if (!queuePath) throw new Error("--queue is required");
	const queue = await readJson(queuePath, QueueSchema);
	const paths = await resolveProjectForCreate(flags, queue.project);
	const repoPath = await resolveRepoPath(flags, queue.repoPath);
	const state = buildInitialState(queue, repoPath);
	activateNextQueuedTask(state);
	await initProject(paths, state, true);
}

export async function cmdBootstrap(flags: Flags): Promise<void> {
	const queuePath = String(flags.queue ?? "");
	const baseBranch = String(flags.base ?? "");
	if (!queuePath) throw new Error("--queue is required");
	if (!baseBranch) throw new Error("--base is required");

	const queue = await readJson(queuePath, QueueSchema);
	const patchedQueue = { ...queue, baseBranch };
	const paths = await resolveProjectForCreate(flags, patchedQueue.project);
	const repoPath = await resolveRepoPath(flags, queue.repoPath);
	const state = buildInitialState(patchedQueue, repoPath);
	activateNextQueuedTask(state);

	await ensureDir(paths.dir);
	await writeJson(paths.bootstrapQueuePath, patchedQueue);
	await initProject(paths, state, true);
	console.log(`Bootstrap complete. Active project: ${paths.slug}`);
	await cmdNext({ project: paths.slug });
}

// List every project with a one-line status — the cross-stream overview.
export async function cmdProjects(_flags: Flags): Promise<void> {
	const active = await readActiveSlug();
	const projects: unknown[] = [];
	for (const p of await listProjectPaths()) {
		try {
			const state = await loadState(p.statePath);
			const counts: Record<string, number> = {};
			for (const task of state.tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
			const lock = readLock(p.lockPath);
			projects.push({
				slug: p.slug,
				active: p.slug === active,
				running: lock ? `pid ${lock.pid} (${lock.command})` : null,
				project: state.project,
				baseBranch: state.baseBranch,
				activeTaskId: state.activeTaskId,
				tasks: state.tasks.length,
				counts,
			});
		} catch (error) {
			projects.push({
				slug: p.slug,
				active: p.slug === active,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	console.log(JSON.stringify({ active, projects }, null, 2));
}

// Set the active project so subsequent commands need no --project flag.
export async function cmdUse(flags: Flags): Promise<void> {
	const positional = (flags._ as unknown[] | undefined)?.[0];
	const target = slug(String(positional ?? flags.project ?? ""));
	if (!target) throw new Error("usage: train use <slug>   (run `train projects` to list)");
	const p = projectPaths(target);
	if (!(await pathExists(p.statePath))) {
		throw new Error(
			`No project "${target}" found (expected ${p.statePath}). Run \`train projects\` to list, or \`train bootstrap --project ${target} --queue <path> --base <branch>\`.`,
		);
	}
	await writeActiveSlug(target);
	console.log(`Active project: ${target}`);
}

// ---------------------------------------------------------------------------
// Read-only inspection
// ---------------------------------------------------------------------------

export async function cmdStatus(flags: Flags): Promise<void> {
	const paths = await resolveProject(flags);
	const state = await loadState(paths.statePath);
	const summary = state.tasks.map((task) => ({
		id: task.id,
		status: task.status,
		branch: task.branch,
		prUrl: task.prUrl ?? null,
		blockedStage: task.blockedStage ?? null,
		blockedQuestion: task.blockedQuestion ?? null,
	}));
	console.log(
		JSON.stringify(
			{
				slug: paths.slug,
				project: state.project,
				repoPath: state.repoPath,
				baseBranch: state.baseBranch,
				activeTaskId: state.activeTaskId,
				stageModels: state.stageModels,
				tasks: summary,
			},
			null,
			2,
		),
	);
}

export async function cmdPrompt(flags: Flags): Promise<void> {
	const paths = await resolveProject(flags);
	const taskId = String(flags.task ?? "");
	const stage = String(flags.stage ?? "");
	if (!taskId || !stage) throw new Error("--task and --stage are required");
	const state = await loadState(paths.statePath);
	const task = findTask(state, taskId);
	console.log(renderStagePrompt(state, task, asStage(stage)));
}

export async function cmdNext(flags: Flags): Promise<void> {
	const paths = await resolveProject(flags);
	const state = await loadState(paths.statePath);
	if (!state.activeTaskId) {
		console.log("No active task");
		return;
	}
	const task = findTask(state, state.activeTaskId);
	const stage = statusToStage(task.status);
	if (!stage) {
		console.log(`Active task has no runnable stage: ${task.status}`);
		return;
	}
	console.log(renderStagePrompt(state, task, stage));
}

export async function cmdRun(flags: Flags): Promise<void> {
	const paths = await resolveProject(flags);
	const state = await loadState(paths.statePath);
	const advanced = activateNextQueuedTask(state);
	await saveState(paths.statePath, state);
	console.log(
		advanced
			? `Activated next queued task: ${state.activeTaskId}`
			: "No queued tasks to activate (or active task already present)",
	);
}

// ---------------------------------------------------------------------------
// Stage execution
// ---------------------------------------------------------------------------

// Run a single stage end-to-end against an already-resolved project. Assumes the
// caller holds the project lock (cmdRunStage acquires it for a one-shot; cmdStart
// holds it for the whole loop). Owns the state transition from the structured
// result the SDK returns.
async function runStageOnce(paths: ProjectPaths, taskId: string, stage: StageName, dryRun: boolean): Promise<void> {
	const statePath = paths.statePath;
	const state = await loadState(statePath);
	const task = findTask(state, taskId);
	const expected = statusToStage(task.status);
	if (expected !== stage) throw new Error(`Task ${task.id} is in ${task.status} (expected stage: ${stage})`);

	const repoRoot = resolveRepoRoot(state.repoPath);
	if (!dryRun) assertBaseOnOrigin(repoRoot, state.baseBranch);

	if (stage === "implement") {
		const worktreePath = await prepareWorktree({
			repoRoot,
			branch: task.branch,
			base: state.baseBranch,
			setupTemplate: state.worktreeSetup,
			dryRun,
			log: (l) => console.log(l),
		});
		task.worktreePath = worktreePath;
		await saveState(statePath, state);
	}

	const prompt = renderStagePrompt(state, task, stage);
	// last-prompt.txt is a scratch file overwritten each run for debugging.
	await Bun.write(paths.lastPromptPath, prompt);

	const cwd = task.worktreePath ?? repoRoot;
	console.log(`Running stage ${stage} for ${task.id} (model ${state.stageModels[stage]}, cwd ${cwd})`);
	if (dryRun) {
		console.log(`[dry-run] would start an SDK session for stage ${stage}`);
		return;
	}

	const outcome = await runStageWithSdk({
		prompt,
		cwd,
		model: state.stageModels[stage],
		taskId: task.id,
		stage,
		logDir: paths.logDir,
		maxTurns: STAGE_MAX_TURNS[stage],
		timeoutMs: STAGE_TIMEOUT_MS[stage],
		bypassPermissions: true,
	});

	// Reload before applying: the worktree pre-step saved state, and we always
	// own the transition from the structured result the SDK returned.
	const after = await loadState(statePath);
	const afterTask = findTask(after, task.id);
	const questions = applyStageOutcome(after, afterTask, stage, outcome);
	await flushQuestions(paths.questionsPath, questions);
	await saveState(statePath, after);

	console.log(
		`Stage ${stage} → ${outcome.status} (${outcome.subtype}` +
			(outcome.costUsd != null ? `, $${outcome.costUsd.toFixed(4)}` : "") +
			(outcome.numTurns != null ? `, ${outcome.numTurns} turns` : "") +
			")",
	);
	console.log(`Log: ${outcome.logPath}`);
	if (outcome.status !== "success") console.log(`Reason: ${outcome.reason}`);
}

export async function cmdRunStage(flags: Flags): Promise<void> {
	const paths = await resolveProject(flags);
	const taskId = String(flags.task ?? "");
	const stage = String(flags.stage ?? "");
	const dryRun = Boolean(flags["dry-run"]);
	if (!taskId || !stage) throw new Error("--task and --stage are required");

	await ensureDir(paths.dir);
	const release = acquireLock(paths.lockPath, `run-stage ${taskId} ${stage}`);
	try {
		await runStageOnce(paths, taskId, asStage(stage), dryRun);
	} finally {
		release();
	}
}

export async function cmdStart(flags: Flags): Promise<void> {
	const paths = await resolveProject(flags);
	const dryRun = Boolean(flags["dry-run"]);
	const maxIterations = Number(flags["max-iterations"] ?? 100);
	const statePath = paths.statePath;

	await ensureDir(paths.dir);
	const release = acquireLock(paths.lockPath, "start");
	try {
		for (let i = 0; i < maxIterations; i++) {
			const state = await loadState(statePath);
			if (!state.activeTaskId) {
				const advanced = activateNextQueuedTask(state);
				await saveState(statePath, state);
				if (!advanced) {
					console.log("Train complete: no active or queued tasks remaining");
					return;
				}
				continue;
			}

			const task = findTask(state, state.activeTaskId);
			if (task.status === "awaiting_human") {
				console.log(`Paused: awaiting human approval for ${task.id} — run train approve --task ${task.id}`);
				return;
			}
			if (task.status === "blocked") {
				console.log(`Paused: blocked task ${task.id} — ${task.blockedQuestion ?? "(see QUESTIONS.md)"}`);
				return;
			}
			if (task.status === "failed") {
				console.log(`Paused: failed task ${task.id}`);
				return;
			}

			const stage = statusToStage(task.status);
			if (!stage) {
				console.log(`Paused: no runnable stage for ${task.id} (${task.status})`);
				return;
			}

			try {
				await runStageOnce(paths, task.id, stage, dryRun);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const after = await loadState(statePath);
				const afterTask = findTask(after, task.id);
				const q = blockTask(after, afterTask, stage, `Stage execution failed at ${stage}: ${message}`, "orchestrator");
				await appendQuestion(paths.questionsPath, q);
				await saveState(statePath, after);
				console.log(`Auto-blocked task ${task.id} after stage failure. See QUESTIONS.md.`);
				return;
			}

			// In dry-run no transition happens, so stop instead of spinning on the same stage.
			if (dryRun) {
				console.log("[dry-run] stopping after one stage");
				return;
			}
		}
		console.log(`Stopped: reached max iterations (${maxIterations})`);
	} finally {
		release();
	}
}

// ---------------------------------------------------------------------------
// Human gates and manual overrides
// ---------------------------------------------------------------------------

export async function cmdApprove(flags: Flags): Promise<void> {
	const paths = await resolveProject(flags);
	const taskId = String(flags.task ?? "");
	if (!taskId) throw new Error("--task is required");
	const state = await loadState(paths.statePath);
	const task = findTask(state, taskId);
	if (task.status !== "awaiting_human")
		throw new Error(`Task ${task.id} is in ${task.status}, expected awaiting_human`);
	task.status = "merging";
	task.updatedAt = nowIso();
	task.notes.push("Approved by human via train approve");
	state.activeTaskId = task.id;
	await saveState(paths.statePath, state);
	console.log(`Task ${task.id} approved and moved to merging`);
}

export async function cmdHandoff(flags: Flags): Promise<void> {
	const paths = await resolveProject(flags);
	const taskId = String(flags.task ?? "");
	const stage = String(flags.stage ?? "");
	const outcome = String(flags.status ?? "");
	const prUrl = flags.pr ? String(flags.pr) : undefined;
	const note = flags.note ? String(flags.note) : undefined;
	if (!taskId || !stage || !outcome) throw new Error("--task, --stage and --status are required");
	if (!["ok", "blocked", "failed"].includes(outcome)) throw new Error("status must be ok|blocked|failed");

	const state = await loadState(paths.statePath);
	const task = findTask(state, taskId);
	const status = outcome === "ok" ? "success" : outcome === "blocked" ? "blocked" : "failed";
	const questions = applyStageOutcome(state, task, asStage(stage), {
		status,
		prUrl,
		reason: note ?? `manual handoff: ${outcome}`,
		by: "human",
	});
	await flushQuestions(paths.questionsPath, questions);
	await saveState(paths.statePath, state);
	console.log(`Handoff accepted for ${task.id}. New status: ${task.status}`);
	if (task.status === "awaiting_human") console.log(`Awaiting human approval: run train approve --task ${task.id}`);
}

export async function cmdBlock(flags: Flags): Promise<void> {
	const paths = await resolveProject(flags);
	const taskId = String(flags.task ?? "");
	const stage = String(flags.stage ?? "");
	const question = String(flags.question ?? "");
	const by = String(flags.by ?? "agent");
	if (!taskId || !stage || !question) throw new Error("--task, --stage and --question are required");

	const state = await loadState(paths.statePath);
	const task = findTask(state, taskId);
	const q = blockTask(state, task, stage, question, by);
	await appendQuestion(paths.questionsPath, q);
	await saveState(paths.statePath, state);
	console.log(`Task ${task.id} blocked at ${stage}. Question logged to ${paths.questionsPath}`);
}

export async function cmdUnblock(flags: Flags): Promise<void> {
	const paths = await resolveProject(flags);
	const taskId = String(flags.task ?? "");
	const answer = String(flags.answer ?? "");
	const resumeStatus = String(flags.resume ?? "");
	if (!taskId || !answer || !resumeStatus) throw new Error("--task, --answer and --resume are required");
	if (!["implementing", "reviewing", "addressing", "awaiting_human", "merging"].includes(resumeStatus)) {
		throw new Error("resume must be implementing|reviewing|addressing|awaiting_human|merging");
	}

	const state = await loadState(paths.statePath);
	const task = findTask(state, taskId);
	if (task.status !== "blocked") throw new Error(`Task ${task.id} is in ${task.status}, expected blocked`);
	task.status = resumeStatus as TrainState["tasks"][number]["status"];
	task.blockedAnswer = answer;
	task.updatedAt = nowIso();
	task.notes.push(`Unblocked to ${resumeStatus}: ${answer}`);
	state.activeTaskId = task.id;
	await saveState(paths.statePath, state);
	console.log(`Task ${task.id} unblocked and resumed at ${resumeStatus}`);
}

// Release a stale lock left by a crashed loop (acquireLock already reclaims locks
// whose pid is dead; this is the manual escape hatch when needed).
export async function cmdUnlock(flags: Flags): Promise<void> {
	const paths = await resolveProject(flags);
	const lock = readLock(paths.lockPath);
	if (!lock) {
		console.log("No lock held for this project.");
		return;
	}
	const removed = forceUnlock(paths.lockPath);
	console.log(
		removed ? `Released lock previously held by pid ${lock.pid} (${lock.command}).` : "Failed to release lock.",
	);
}

export { DEFAULT_WORKTREE_SETUP };
