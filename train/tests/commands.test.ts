import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	cmdApprove,
	cmdBlock,
	cmdBootstrap,
	cmdHandoff,
	cmdRunStage,
	cmdUnblock,
	cmdUnlock,
	cmdUse,
} from "../src/commands.ts";
import type { TrainState } from "../src/core.ts";
import { acquireLock } from "../src/lock.ts";

// Each test gets an isolated data root + repo dir. TRAIN_HOME is read at call
// time, so setting it per test fully isolates project state.
let home: string;
let repo: string;
let queuePath: string;
const SLUG = "demo-stream";

function projectDir(): string {
	return path.join(home, "projects", SLUG);
}

function readState(): TrainState {
	return JSON.parse(readFileSync(path.join(projectDir(), "state.json"), "utf8"));
}

beforeEach(() => {
	home = mkdtempSync(path.join(os.tmpdir(), "train-home-"));
	repo = mkdtempSync(path.join(os.tmpdir(), "train-repo-"));
	process.env.TRAIN_HOME = home;
	queuePath = path.join(repo, "queue.json");
	writeFileSync(
		queuePath,
		JSON.stringify({
			project: "https://linear.app/acme/project/demo-stream-abcd1234ef56/overview",
			baseBranch: "feature/demo",
			worktreeSetup: null,
			tasks: [
				{ id: "T-1", title: "First task", linearUrl: "https://linear.app/acme/issue/T-1" },
				{ id: "T-2", title: "Second task", linearUrl: "https://linear.app/acme/issue/T-2" },
			],
		}),
	);
});

afterEach(() => {
	delete process.env.TRAIN_HOME;
});

async function bootstrap(): Promise<void> {
	await cmdBootstrap({ queue: queuePath, base: "feature/demo", repo });
}

describe("bootstrap", () => {
	test("creates a project under the derived slug, repoPath, and activates the first task", async () => {
		await bootstrap();
		const state = readState();
		expect(state.repoPath).toBe(repo);
		expect(state.baseBranch).toBe("feature/demo");
		expect(state.activeTaskId).toBe("T-1");
		expect(state.tasks[0].status).toBe("implementing");
		// active pointer written
		expect(JSON.parse(readFileSync(path.join(home, "active.json"), "utf8")).slug).toBe(SLUG);
	});

	test("rejects a repo path that does not exist", async () => {
		await expect(cmdBootstrap({ queue: queuePath, base: "feature/demo", repo: "/no/such/repo/path" })).rejects.toThrow(
			/Repo path does not exist/,
		);
	});
});

describe("manual handoff drives the full pipeline", () => {
	test("ok handoffs walk T-1 to awaiting_human, approve → merge → done advances to T-2", async () => {
		await bootstrap();
		await cmdHandoff({ task: "T-1", stage: "implement", status: "ok", pr: "https://github.com/acme/r/pull/1" });
		expect(readState().tasks[0].status).toBe("reviewing");

		await cmdHandoff({ task: "T-1", stage: "review", status: "ok" });
		expect(readState().tasks[0].status).toBe("addressing");

		await cmdHandoff({ task: "T-1", stage: "address", status: "ok" });
		expect(readState().tasks[0].status).toBe("awaiting_human");

		await cmdApprove({ task: "T-1" });
		expect(readState().tasks[0].status).toBe("merging");

		await cmdHandoff({ task: "T-1", stage: "merge", status: "ok", note: "merged abc123" });
		const state = readState();
		expect(state.tasks[0].status).toBe("done");
		expect(state.activeTaskId).toBe("T-2");
		expect(state.tasks[1].status).toBe("implementing");
	});

	test("approve before the human gate is rejected", async () => {
		await bootstrap();
		await expect(cmdApprove({ task: "T-1" })).rejects.toThrow(/expected awaiting_human/);
	});
});

describe("block / unblock", () => {
	test("block records a question file entry and unblock resumes with the answer", async () => {
		await bootstrap();
		await cmdBlock({ task: "T-1", stage: "implement", question: "Approach A or B?" });
		let state = readState();
		expect(state.tasks[0].status).toBe("blocked");
		const questions = readFileSync(path.join(projectDir(), "QUESTIONS.md"), "utf8");
		expect(questions).toContain("Approach A or B?");
		expect(questions).toContain("## T-1 (implement)");

		await cmdUnblock({ task: "T-1", answer: "Use A", resume: "implementing" });
		state = readState();
		expect(state.tasks[0].status).toBe("implementing");
		expect(state.tasks[0].blockedAnswer).toBe("Use A");
		expect(state.activeTaskId).toBe("T-1");
	});

	test("unblock requires a valid resume status", async () => {
		await bootstrap();
		await cmdBlock({ task: "T-1", stage: "implement", question: "?" });
		await expect(cmdUnblock({ task: "T-1", answer: "x", resume: "bogus" })).rejects.toThrow(/resume must be/);
	});
});

describe("run-stage", () => {
	test("dry-run prepares without invoking the SDK and respects the project lock", async () => {
		await bootstrap();
		// dry-run should not change task status (no transition without a real outcome)
		await cmdRunStage({ task: "T-1", stage: "implement", "dry-run": true, project: SLUG });
		expect(readState().tasks[0].status).toBe("implementing");
	});

	test("a held lock makes run-stage fail fast", async () => {
		await bootstrap();
		const release = acquireLock(path.join(projectDir(), ".lock"), "start");
		try {
			await expect(cmdRunStage({ task: "T-1", stage: "implement", "dry-run": true, project: SLUG })).rejects.toThrow(
				/already locked/,
			);
		} finally {
			release();
		}
	});

	test("run-stage rejects a stage that does not match the task status", async () => {
		await bootstrap();
		await expect(cmdRunStage({ task: "T-1", stage: "merge", "dry-run": true, project: SLUG })).rejects.toThrow(
			/expected stage: merge/,
		);
	});
});

describe("use + unlock", () => {
	test("use switches the active project and rejects unknown slugs", async () => {
		await bootstrap();
		await cmdUse({ _: [SLUG] });
		expect(JSON.parse(readFileSync(path.join(home, "active.json"), "utf8")).slug).toBe(SLUG);
		await expect(cmdUse({ _: ["nope"] })).rejects.toThrow(/No project "nope" found/);
	});

	test("unlock releases a held lock", async () => {
		await bootstrap();
		acquireLock(path.join(projectDir(), ".lock"), "start");
		await cmdUnlock({ project: SLUG });
		// acquiring again should now succeed (lock was released)
		const release = acquireLock(path.join(projectDir(), ".lock"), "start");
		release();
	});
});
