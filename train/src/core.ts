// Pure orchestration core: schemas, the stage state machine, and prompt
// rendering. Nothing in this module touches the filesystem, the shell, or the
// Agent SDK, so every transition is unit-testable in isolation. Side effects
// (reading/writing state, appending questions, running stages) live in
// commands.ts and runner.ts.

import { z } from "zod";

// The ordered pipeline a ticket walks: implement → review → address →
// awaiting_human (the only human gate) → merge. TERMINAL states end a task.
export const STAGES = ["implementing", "reviewing", "addressing", "awaiting_human", "merging"] as const;
export const TERMINAL = ["done", "blocked", "failed"] as const;
export const STATUSES = ["queued", ...STAGES, ...TERMINAL] as const;

export type StageName = "implement" | "review" | "address" | "merge";

export const TaskInputSchema = z.object({
	id: z.string().min(1),
	title: z.string().min(1),
	linearUrl: z.string().url().optional(),
	repo: z.string().min(1).optional(),
});

export const StageMapSchema = z.object({
	implement: z.string().default("sonnet"),
	review: z.string().default("opus"),
	address: z.string().default("sonnet"),
	merge: z.string().default("opus"),
});

export const DEFAULT_STAGE_MODELS: z.infer<typeof StageMapSchema> = {
	implement: "sonnet",
	review: "opus",
	address: "sonnet",
	merge: "opus",
};

// Queue file authored by a human (or a planning agent) and fed to
// `train bootstrap`/`train init`. `repoPath` is the local checkout of the
// target git repo the stages run against — the train no longer lives inside
// that repo, so the path is explicit. `worktreeSetup` overrides the default
// worktree-creation command (see DEFAULT_WORKTREE_SETUP).
export const QueueSchema = z.object({
	project: z.string().min(1),
	baseBranch: z.string().min(1),
	repoPath: z.string().min(1).optional(),
	worktreeSetup: z.string().min(1).nullable().optional(),
	stageModels: StageMapSchema.partial().optional(),
	tasks: z.array(TaskInputSchema).min(1),
});

export const TaskStateSchema = z.object({
	id: z.string(),
	title: z.string(),
	linearUrl: z.string().optional(),
	repo: z.string().optional(),
	branch: z.string(),
	prUrl: z.string().optional(),
	worktreePath: z.string().optional(),
	status: z.enum(STATUSES),
	attempts: z.number().int().nonnegative().default(0),
	blockedStage: z.string().optional(),
	blockedQuestion: z.string().optional(),
	blockedAnswer: z.string().optional(),
	blockedAt: z.string().optional(),
	blockedBy: z.string().optional(),
	updatedAt: z.string(),
	notes: z.array(z.string()).default([]),
});

export const StateSchema = z.object({
	project: z.string(),
	baseBranch: z.string(),
	repoPath: z.string(),
	worktreeSetup: z.string().nullable().default(null),
	createdAt: z.string(),
	updatedAt: z.string(),
	activeTaskId: z.string().nullable(),
	stageModels: StageMapSchema,
	tasks: z.array(TaskStateSchema),
});

export type TaskInput = z.infer<typeof TaskInputSchema>;
export type Queue = z.infer<typeof QueueSchema>;
export type TaskState = z.infer<typeof TaskStateSchema>;
export type TrainState = z.infer<typeof StateSchema>;
export type TaskStatus = TaskState["status"];

// The structured result every stage session is forced to return. The agent
// never mutates train state itself — the orchestrator reads this and owns the
// transition.
export const StageOutcomeSchema = z.object({
	status: z.enum(["success", "blocked", "failed"]),
	prUrl: z.string().optional(),
	reason: z.string(),
});
export type StageOutcome = z.infer<typeof StageOutcomeSchema>;

// Per-stage caps for the SDK runner. A whole-ticket implementation is many
// turns; review/merge are lighter. The timeout is a wall-clock backstop.
export const STAGE_MAX_TURNS: Record<StageName, number> = { implement: 80, review: 25, address: 40, merge: 15 };
export const STAGE_TIMEOUT_MS: Record<StageName, number> = {
	implement: 45 * 60_000,
	review: 20 * 60_000,
	address: 30 * 60_000,
	merge: 15 * 60_000,
};

// Default worktree-creation command, run once before the implement stage. The
// `{branch}` and `{base}` placeholders are substituted at call time. This is the
// monorepo-core convention; override per project via the queue's `worktreeSetup`
// or set it to null to skip worktree creation entirely (the stage then runs in
// the repo root).
export const DEFAULT_WORKTREE_SETUP = "~/.deno/bin/deno run -A scripts/setup-worktree.ts {branch} --from origin/{base}";

export function nowIso(): string {
	return new Date().toISOString();
}

export function slug(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "");
}

// Derive a stable project slug from a Linear project reference, which is usually
// a URL like .../project/dynamic-tasks-5bd8c4c3eb2a/overview — keep the readable
// name, drop the trailing hex id.
export function deriveSlug(project: string): string {
	const match = project.match(/\/project\/([^/]+)/);
	const raw = (match ? match[1] : project).replace(/-[0-9a-f]{8,}$/i, "");
	return slug(raw) || slug(project);
}

export function findTask(state: TrainState, taskId: string): TaskState {
	const task = state.tasks.find((t) => t.id === taskId);
	if (!task) throw new Error(`Task not found: ${taskId}`);
	return task;
}

// On stage success, the task advances to the next status in the pipeline.
export function stageToStatus(stage: StageName): TaskStatus {
	switch (stage) {
		case "implement":
			return "reviewing";
		case "review":
			return "addressing";
		case "address":
			return "awaiting_human";
		case "merge":
			return "done";
	}
}

// Which stage a runnable status maps to (null for queued/terminal/awaiting_human).
export function statusToStage(status: TaskStatus): StageName | null {
	switch (status) {
		case "implementing":
			return "implement";
		case "reviewing":
			return "review";
		case "addressing":
			return "address";
		case "merging":
			return "merge";
		default:
			return null;
	}
}

export function stageSkillCommand(stage: StageName, task: TaskState): string {
	switch (stage) {
		case "implement":
			// Autopilot twin of /implement-linear: records the plan and proceeds
			// instead of blocking for interactive sign-off (the train's human gate
			// is at review/merge, plus genuine agent-raised blocks). See
			// commands/implement-linear-auto.md.
			return `/implement-linear-auto <${task.linearUrl ?? "LINEAR_URL"}>`;
		case "review":
			return `/review-pr <${task.prUrl ?? "PR_URL"}>`;
		case "address":
			return `/address-pr <${task.prUrl ?? "PR_URL"}>`;
		case "merge":
			return `/merge-pr <${task.prUrl ?? "PR_URL"}>`;
	}
}

export function renderStagePrompt(state: TrainState, task: TaskState, stage: StageName): string {
	const model = state.stageModels[stage];
	return (
		`${stageSkillCommand(stage, task)}\n\n` +
		"Task context:\n" +
		`- Task: ${task.id} - ${task.title}\n` +
		`- Stage model: ${model}\n` +
		`- Base branch: ${state.baseBranch}\n` +
		`- Working branch: ${task.branch}\n` +
		(task.worktreePath ? `- Worktree path: ${task.worktreePath}\n` : "") +
		(task.prUrl ? `- PR: ${task.prUrl}\n` : "") +
		(task.blockedAnswer
			? "\nDeveloper guidance on a question raised earlier in this task — follow it:\n" +
				(task.blockedQuestion ? `- Question: ${task.blockedQuestion}\n` : "") +
				`- Answer: ${task.blockedAnswer}\n`
			: "") +
		`\nIMPORTANT — pull request base: any PR you open, update, or merge MUST target the base branch "${state.baseBranch}", never main. When creating a PR, pass it explicitly: ` +
		`\`gh pr create --base ${state.baseBranch} --head ${task.branch}\`.\n` +
		"\nWhen the stage is complete, return your structured result:\n" +
		'- status "success" once the work is done and any required PR/commits exist (set prUrl to the PR you opened or updated).\n' +
		'- status "blocked" if you hit a decision that needs a developer; put the single clear question in reason.\n' +
		'- status "failed" if the stage cannot be completed; put the cause in reason.\n'
	);
}

// Promote the first queued task to implementing when the train is idle. Returns
// true if a task was activated.
export function activateNextQueuedTask(state: TrainState, now = nowIso()): boolean {
	if (state.activeTaskId) return false;
	const next = state.tasks.find((task) => task.status === "queued");
	if (!next) return false;
	next.status = "implementing";
	next.updatedAt = now;
	next.notes.push("Auto-started after previous task completed");
	state.activeTaskId = next.id;
	return true;
}

// A question that must be appended to QUESTIONS.md by the caller. Returned by the
// transition functions instead of writing it directly, keeping this module pure.
export type QuestionRecord = { task: TaskState; stage: string; question: string };

// The single place that maps a stage result to a state transition, used by both
// the SDK-driven loop and the manual `handoff` command. Mutates `state`/`task`
// in place and returns any question to log. The agent never mutates state — the
// orchestrator owns every transition.
export function applyStageOutcome(
	state: TrainState,
	task: TaskState,
	stage: StageName,
	outcome: { status: "success" | "blocked" | "failed"; prUrl?: string; reason: string; by?: string },
	now = nowIso(),
): QuestionRecord[] {
	if (outcome.prUrl) task.prUrl = outcome.prUrl;
	task.notes.push(`[${stage}] ${outcome.status}: ${outcome.reason}`);
	task.attempts += 1;
	task.updatedAt = now;

	if (outcome.status === "success") {
		// The stage succeeded, so any prior block on this task is resolved — clear
		// it so a one-time answer isn't re-injected as guidance into later stages.
		task.blockedStage = undefined;
		task.blockedQuestion = undefined;
		task.blockedAnswer = undefined;
		task.blockedAt = undefined;
		task.blockedBy = undefined;
		task.status = stageToStatus(stage);
		if (task.status === "awaiting_human") {
			// Keep the task active so the loop halts here until `approve`. Nulling
			// activeTaskId would make the next `start` iteration treat the train as
			// idle and skip ahead to the next queued ticket.
			state.activeTaskId = task.id;
			task.notes.push(`Paused for human approval. Run train approve --task ${task.id}`);
		} else if (task.status === "done" && state.activeTaskId === task.id) {
			// A completed ticket is the only thing that advances the train.
			state.activeTaskId = null;
			activateNextQueuedTask(state, now);
		} else {
			state.activeTaskId = task.id;
		}
		return [];
	}

	// Blocked/failed halt the train: the task stays active so the loop pauses on
	// it and a re-run of `start` resumes/respects it instead of skipping ahead.
	task.status = outcome.status;
	state.activeTaskId = task.id;
	if (outcome.status === "blocked") {
		task.blockedStage = stage;
		task.blockedQuestion = outcome.reason;
		task.blockedAt = now;
		task.blockedBy = outcome.by ?? "agent";
		return [{ task, stage, question: outcome.reason }];
	}
	return [];
}

// Mark a task blocked outside the normal stage flow (manual `block`, or an
// orchestration failure caught by `start`). Mutates in place, returns the
// question to log.
export function blockTask(
	state: TrainState,
	task: TaskState,
	stage: string,
	question: string,
	by: string,
	now = nowIso(),
): QuestionRecord {
	task.status = "blocked";
	task.blockedStage = stage;
	task.blockedQuestion = question;
	task.blockedAt = now;
	task.blockedBy = by;
	task.updatedAt = now;
	task.notes.push(`Blocked at ${stage}: ${question}`);
	if (state.activeTaskId === task.id) state.activeTaskId = null;
	return { task, stage, question };
}

// Build the initial state for a freshly bootstrapped/initialized project.
export function buildInitialState(queue: Queue, repoPath: string, now = nowIso()): TrainState {
	return {
		project: queue.project,
		baseBranch: queue.baseBranch,
		repoPath,
		worktreeSetup: queue.worktreeSetup === undefined ? DEFAULT_WORKTREE_SETUP : queue.worktreeSetup,
		createdAt: now,
		updatedAt: now,
		activeTaskId: null,
		stageModels: { ...DEFAULT_STAGE_MODELS, ...(queue.stageModels ?? {}) },
		tasks: queue.tasks.map((task) => ({
			...task,
			branch: `joel/${task.id.toLowerCase()}-${slug(task.title)}`,
			worktreePath: undefined,
			status: "queued" as const,
			attempts: 0,
			updatedAt: now,
			notes: [],
		})),
	};
}
