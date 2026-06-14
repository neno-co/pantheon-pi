import { describe, expect, test } from "bun:test";
import {
	activateNextQueuedTask,
	applyStageOutcome,
	blockTask,
	buildInitialState,
	DEFAULT_WORKTREE_SETUP,
	deriveSlug,
	findTask,
	type Queue,
	renderStagePrompt,
	slug,
	stageSkillCommand,
	stageToStatus,
	statusToStage,
	type TrainState,
} from "../src/core.ts";

const FIXED = "2026-06-13T00:00:00.000Z";

function makeQueue(overrides: Partial<Queue> = {}): Queue {
	return {
		project: "https://linear.app/acme/project/demo-stream-abcd1234ef56/overview",
		baseBranch: "feature/demo",
		tasks: [
			{ id: "T-1", title: "First task", linearUrl: "https://linear.app/acme/issue/T-1" },
			{ id: "T-2", title: "Second task", linearUrl: "https://linear.app/acme/issue/T-2" },
		],
		...overrides,
	};
}

function makeState(overrides: Partial<Queue> = {}): TrainState {
	const state = buildInitialState(makeQueue(overrides), "/repo", FIXED);
	activateNextQueuedTask(state, FIXED);
	return state;
}

describe("slug + deriveSlug", () => {
	test("slug normalizes to kebab", () => {
		expect(slug("Hello, World!")).toBe("hello-world");
		expect(slug("  --Edge-- ")).toBe("edge");
	});

	test("deriveSlug keeps the readable Linear project name and drops the hex id", () => {
		expect(deriveSlug("https://linear.app/acme/project/dynamic-tasks-5bd8c4c3eb2a/overview")).toBe("dynamic-tasks");
		expect(deriveSlug("https://linear.app/acme/project/demo-stream-abcd1234ef56/overview")).toBe("demo-stream");
	});

	test("deriveSlug falls back to slugging a plain reference", () => {
		expect(deriveSlug("My Project")).toBe("my-project");
	});
});

describe("stage <-> status maps", () => {
	test("stageToStatus advances the pipeline", () => {
		expect(stageToStatus("implement")).toBe("reviewing");
		expect(stageToStatus("review")).toBe("addressing");
		expect(stageToStatus("address")).toBe("awaiting_human");
		expect(stageToStatus("merge")).toBe("done");
	});

	test("statusToStage is the inverse for runnable statuses, null otherwise", () => {
		expect(statusToStage("implementing")).toBe("implement");
		expect(statusToStage("reviewing")).toBe("review");
		expect(statusToStage("addressing")).toBe("address");
		expect(statusToStage("merging")).toBe("merge");
		expect(statusToStage("awaiting_human")).toBeNull();
		expect(statusToStage("queued")).toBeNull();
		expect(statusToStage("done")).toBeNull();
		expect(statusToStage("blocked")).toBeNull();
	});
});

describe("buildInitialState", () => {
	test("queues every task and derives a branch per ticket", () => {
		const state = buildInitialState(makeQueue(), "/repo", FIXED);
		expect(state.repoPath).toBe("/repo");
		expect(state.baseBranch).toBe("feature/demo");
		expect(state.worktreeSetup).toBe(DEFAULT_WORKTREE_SETUP);
		expect(state.activeTaskId).toBeNull();
		expect(state.tasks.map((t) => t.status)).toEqual(["queued", "queued"]);
		expect(state.tasks[0].branch).toBe("joel/t-1-first-task");
	});

	test("honors an explicit null worktreeSetup and stageModels overrides", () => {
		const state = buildInitialState(
			makeQueue({ worktreeSetup: null, stageModels: { implement: "opus" } }),
			"/repo",
			FIXED,
		);
		expect(state.worktreeSetup).toBeNull();
		expect(state.stageModels.implement).toBe("opus");
		expect(state.stageModels.review).toBe("opus"); // default preserved
	});
});

describe("activateNextQueuedTask", () => {
	test("promotes the first queued task when idle", () => {
		const state = buildInitialState(makeQueue(), "/repo", FIXED);
		expect(activateNextQueuedTask(state, FIXED)).toBe(true);
		expect(state.activeTaskId).toBe("T-1");
		expect(findTask(state, "T-1").status).toBe("implementing");
	});

	test("does nothing when a task is already active", () => {
		const state = makeState();
		expect(activateNextQueuedTask(state, FIXED)).toBe(false);
		expect(state.activeTaskId).toBe("T-1");
	});
});

describe("renderStagePrompt", () => {
	test("includes the slash command, base-branch guard, and structured-result contract", () => {
		const state = makeState();
		const prompt = renderStagePrompt(state, findTask(state, "T-1"), "implement");
		expect(prompt).toContain("/implement-linear-auto <https://linear.app/acme/issue/T-1>");
		expect(prompt).toContain('MUST target the base branch "feature/demo"');
		expect(prompt).toContain("gh pr create --base feature/demo --head joel/t-1-first-task");
		expect(prompt).toContain('status "blocked"');
	});

	test("injects developer guidance when resuming after a block", () => {
		const state = makeState();
		const task = findTask(state, "T-1");
		task.blockedQuestion = "Approach A or B?";
		task.blockedAnswer = "Use A";
		const prompt = renderStagePrompt(state, task, "implement");
		expect(prompt).toContain("Developer guidance");
		expect(prompt).toContain("Use A");
	});

	test("stageSkillCommand maps each stage to its slash command", () => {
		const task = findTask(makeState(), "T-1");
		task.prUrl = "https://github.com/acme/repo/pull/9";
		expect(stageSkillCommand("review", task)).toBe("/review-pr <https://github.com/acme/repo/pull/9>");
		expect(stageSkillCommand("address", task)).toBe("/address-pr <https://github.com/acme/repo/pull/9>");
		expect(stageSkillCommand("merge", task)).toBe("/merge-pr <https://github.com/acme/repo/pull/9>");
	});
});

describe("applyStageOutcome", () => {
	test("success walks implement → review → address → awaiting_human and pauses", () => {
		const state = makeState();
		const task = findTask(state, "T-1");

		applyStageOutcome(state, task, "implement", { status: "success", reason: "done", prUrl: "PR1" }, FIXED);
		expect(task.status).toBe("reviewing");
		expect(task.prUrl).toBe("PR1");
		expect(state.activeTaskId).toBe("T-1");

		applyStageOutcome(state, task, "review", { status: "success", reason: "reviewed" }, FIXED);
		expect(task.status).toBe("addressing");

		const questions = applyStageOutcome(state, task, "address", { status: "success", reason: "addressed" }, FIXED);
		expect(task.status).toBe("awaiting_human");
		expect(state.activeTaskId).toBe("T-1"); // stays active so the loop halts
		expect(questions).toEqual([]);
		expect(task.notes.some((n) => n.includes("Run train approve"))).toBe(true);
	});

	test("merge success completes the task and auto-activates the next queued one", () => {
		const state = makeState();
		const task = findTask(state, "T-1");
		task.status = "merging"; // simulate post-approval
		applyStageOutcome(state, task, "merge", { status: "success", reason: "merged" }, FIXED);
		expect(findTask(state, "T-1").status).toBe("done");
		expect(state.activeTaskId).toBe("T-2"); // train advanced
		expect(findTask(state, "T-2").status).toBe("implementing");
	});

	test("blocked halts the train, records the question, and keeps the task active", () => {
		const state = makeState();
		const task = findTask(state, "T-1");
		const questions = applyStageOutcome(state, task, "implement", { status: "blocked", reason: "Which API?" }, FIXED);
		expect(task.status).toBe("blocked");
		expect(task.blockedStage).toBe("implement");
		expect(task.blockedQuestion).toBe("Which API?");
		expect(task.blockedBy).toBe("agent");
		expect(state.activeTaskId).toBe("T-1");
		expect(questions).toEqual([{ task, stage: "implement", question: "Which API?" }]);
	});

	test("a later success clears stale block fields so guidance is not re-injected", () => {
		const state = makeState();
		const task = findTask(state, "T-1");
		applyStageOutcome(state, task, "implement", { status: "blocked", reason: "Q?" }, FIXED);
		task.status = "implementing"; // simulate unblock
		task.blockedAnswer = "A";
		applyStageOutcome(state, task, "implement", { status: "success", reason: "done" }, FIXED);
		expect(task.blockedStage).toBeUndefined();
		expect(task.blockedQuestion).toBeUndefined();
		expect(task.blockedAnswer).toBeUndefined();
	});

	test("failed halts the train without recording a question", () => {
		const state = makeState();
		const task = findTask(state, "T-1");
		const questions = applyStageOutcome(state, task, "implement", { status: "failed", reason: "boom" }, FIXED);
		expect(task.status).toBe("failed");
		expect(state.activeTaskId).toBe("T-1");
		expect(questions).toEqual([]);
	});
});

describe("blockTask", () => {
	test("marks blocked, logs a note, and clears the active pointer", () => {
		const state = makeState();
		const task = findTask(state, "T-1");
		const q = blockTask(state, task, "implement", "stuck", "orchestrator", FIXED);
		expect(task.status).toBe("blocked");
		expect(task.blockedBy).toBe("orchestrator");
		expect(state.activeTaskId).toBeNull();
		expect(q.question).toBe("stuck");
	});
});
