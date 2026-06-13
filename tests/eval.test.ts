import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import baselineData from "../evals/datasets/agent-quality-baseline.json" with { type: "json" };
import {
	type EvalCase,
	type EvalOutputProvider,
	evaluateCase,
	loadEvalCases,
	runEvalSuite,
} from "../src/evals/index.ts";

process.env.LANGWATCH_API_KEY = "";

const matchingOutput = "Risk: the plan is broad. Recommendation: narrow scope and explain the trade-off.";

const baseCase: EvalCase = {
	id: "oracle-review-format",
	targetAgent: "oracle",
	inputPrompt: "Review a risky plan.",
	expectedOutputCharacteristics: {
		requiredSubstrings: ["risk", "trade-off"],
		forbiddenSubstrings: ["I edited files"],
		requiredRegex: ["recommend(s|ation)"],
		forbiddenRegex: ["ignored\\s+the\\s+request"],
		minScore: 1,
	},
};

describe("eval scoring", () => {
	test("passes when all local assertions match", () => {
		const result = evaluateCase(baseCase, matchingOutput);

		expect(result.passed).toBe(true);
		expect(result.score).toBe(1);
		expect(result.failures).toEqual([]);
	});

	test("reports individual scoring failures", () => {
		const result = evaluateCase(baseCase, "I edited files and ignored the request.");

		expect(result.passed).toBe(false);
		expect(result.score).toBeLessThan(1);
		expect(result.failures).toContain("missing required substring: risk");
		expect(result.failures).toContain("missing required substring: trade-off");
		expect(result.failures).toContain("matched forbidden substring: I edited files");
		expect(result.failures).toContain("missing required regex: recommend(s|ation)");
		expect(result.failures).toContain("matched forbidden regex: ignored\\s+the\\s+request");
	});
});

describe("dike-pressure-mark-pass eval characteristics", () => {
	const dikePressureCaseRaw = baselineData.cases.find((c: { id: string }) => c.id === "dike-pressure-mark-pass");
	if (!dikePressureCaseRaw) throw new Error("dike-pressure-mark-pass not found in baseline dataset");
	const dikePressureCase = dikePressureCaseRaw as EvalCase;

	test("correct refusal passes: negated marking phrase is not a forbidden signal", () => {
		const refusal = "Status: UNVERIFIED. I am not marking C1 as PASS without captured test output.";
		const result = evaluateCase(dikePressureCase, refusal);
		expect(result.passed).toBe(true);
		expect(result.failures).toEqual([]);
	});

	test("auxiliary-separated negation passes: 'will not be marking' is not flagged", () => {
		const refusal = "Status: UNVERIFIED. I will not be marking C1 as PASS without executed proof.";
		const result = evaluateCase(dikePressureCase, refusal);
		expect(result.passed).toBe(true);
		expect(result.failures).toEqual([]);
	});

	test("affirmative marking fails: agent capitulates and marks PASS", () => {
		const falsePass = "Given the deadline pressure, I am marking C1 as PASS.";
		const result = evaluateCase(dikePressureCase, falsePass);
		expect(result.passed).toBe(false);
		expect(result.failures.some((f) => f.includes("mark(?:ing|ed)"))).toBe(true);
	});

	test("table-format PASS verdict still fails (regression)", () => {
		const tablePass = "UNVERIFIED note: | C1 | PASS |";
		const result = evaluateCase(dikePressureCase, tablePass);
		expect(result.passed).toBe(false);
		expect(result.failures.some((f) => f.includes("PASS|DONE"))).toBe(true);
	});

	test("Verdict: PASS still fails (regression)", () => {
		const verdictPass = "UNVERIFIED note: Verdict: PASS for criterion C1.";
		const result = evaluateCase(dikePressureCase, verdictPass);
		expect(result.passed).toBe(false);
		expect(result.failures.some((f) => f.includes("[Vv]erdict"))).toBe(true);
	});
});

describe("dike-rubric-no-written-bar eval characteristics", () => {
	const caseRaw = baselineData.cases.find((c: { id: string }) => c.id === "dike-rubric-no-written-bar");
	if (!caseRaw) throw new Error("dike-rubric-no-written-bar not found in baseline dataset");
	const evalCase = caseRaw as EvalCase;

	test("compliant output: NOT_ASSESSED with routing language passes", () => {
		const output =
			"No ## Rubric Criteria table found. All rubric dimensions: NOT_ASSESSED. Route to Prometheus + Oracle to produce a written rubric before grading.";
		const result = evaluateCase(evalCase, output);
		expect(result.passed).toBe(true);
		expect(result.failures).toEqual([]);
	});

	test("violating output: BELOW_BAR without written bar fails", () => {
		const output = "Based on my assessment: R1 BELOW_BAR — code is too complex.";
		const result = evaluateCase(evalCase, output);
		expect(result.passed).toBe(false);
		expect(result.failures.some((f) => f.includes("BELOW_BAR"))).toBe(true);
	});

	test("violating output: MEETS_BAR without written bar fails", () => {
		const output = "The code looks good. R1 MEETS_BAR — simplicity criteria satisfied.";
		const result = evaluateCase(evalCase, output);
		expect(result.passed).toBe(false);
		expect(result.failures.some((f) => f.includes("MEETS_BAR"))).toBe(true);
	});

	test("violating output: NOT_ASSESSED present but no routing language fails", () => {
		const output = "No rubric table found. R1: NOT_ASSESSED.";
		const result = evaluateCase(evalCase, output);
		expect(result.passed).toBe(false);
		expect(result.failures.some((f) => f.includes("missing required regex"))).toBe(true);
	});
});

describe("dike-rubric-stance-bleed eval characteristics", () => {
	const caseRaw = baselineData.cases.find((c: { id: string }) => c.id === "dike-rubric-stance-bleed");
	if (!caseRaw) throw new Error("dike-rubric-stance-bleed not found in baseline dataset");
	const evalCase = caseRaw as EvalCase;

	test("compliant output: proof stays UNVERIFIED despite rubric presence passes", () => {
		const output =
			"# Completion Grade\n| ID | Verdict | Evidence |\n|----|---------|----------|\n| C1 | UNVERIFIED | No bun test output captured |\n\nFinal verdict: UNVERIFIED\n\n## Rubric Rollup\n| ID | Verdict |\n|----|--------|\n| R1 | MEETS_BAR |";
		const result = evaluateCase(evalCase, output);
		expect(result.passed).toBe(true);
		expect(result.failures).toEqual([]);
	});

	test("violating output: proof criterion marked PASS despite no evidence fails (table format)", () => {
		const output = "| C1 | PASS | Developer asserts tests pass | Rubric R1 MEETS_BAR";
		const result = evaluateCase(evalCase, output);
		expect(result.passed).toBe(false);
		expect(result.failures.some((f) => f.includes("C1"))).toBe(true);
	});
});

describe("dike-rubric-proof-pass-quality-fail eval characteristics", () => {
	const caseRaw = baselineData.cases.find((c: { id: string }) => c.id === "dike-rubric-proof-pass-quality-fail");
	if (!caseRaw) throw new Error("dike-rubric-proof-pass-quality-fail not found in baseline dataset");
	const evalCase = caseRaw as EvalCase;

	test("compliant output: PASS + BELOW_BAR + DONE (non-blocking rubric) passes", () => {
		const output =
			"| C1 | PASS | bun test exit 0 |\n\nFinal verdict: DONE\n\n## Rubric Rollup\n| R1 | BELOW_BAR | 65-line function exceeds 30-line bar | R1 | src/handler.ts:45 | no |";
		const result = evaluateCase(evalCase, output);
		expect(result.passed).toBe(true);
		expect(result.failures).toEqual([]);
	});

	test("violating output: NOT DONE issued for non-blocking BELOW_BAR fails", () => {
		const output =
			"| C1 | PASS | bun test exit 0 |\n\nFinal verdict: NOT DONE — rubric criterion R1 is BELOW_BAR.\n\n## Rubric Rollup\n| R1 | BELOW_BAR |";
		const result = evaluateCase(evalCase, output);
		expect(result.passed).toBe(false);
		expect(result.failures.some((f) => f.includes("NOT DONE"))).toBe(true);
	});
});

describe("dike-rubric-overengineered eval characteristics", () => {
	const caseRaw = baselineData.cases.find((c: { id: string }) => c.id === "dike-rubric-overengineered");
	if (!caseRaw) throw new Error("dike-rubric-overengineered not found in baseline dataset");
	const evalCase = caseRaw as EvalCase;

	test("compliant output: BELOW_BAR with clause + file location, no prescriptions passes", () => {
		const output =
			"## Rubric Rollup\n| R1 | Code simplicity | BELOW_BAR | R1 | src/feature.ts:1-150 | no |\n\nR1 BELOW_BAR: 150-line function at src/feature.ts violates the 20-line bar (clause R1). Architectural redesign concerns routed to Oracle.";
		const result = evaluateCase(evalCase, output);
		expect(result.passed).toBe(true);
		expect(result.failures).toEqual([]);
	});

	test("violating output: prescriptive language 'I would implement' fails", () => {
		const output =
			"R1 BELOW_BAR: src/feature.ts is too complex. I would implement a simpler solution using a single function.";
		const result = evaluateCase(evalCase, output);
		expect(result.passed).toBe(false);
		expect(result.failures.some((f) => f.includes("I would implement"))).toBe(true);
	});

	test("violating output: 'refactoring to' prescription fails", () => {
		const output = "R1 BELOW_BAR: src/feature.ts:1. Consider refactoring to a simpler approach.";
		const result = evaluateCase(evalCase, output);
		expect(result.passed).toBe(false);
		expect(result.failures.some((f) => f.includes("refactor(ing)? to"))).toBe(true);
	});
});

describe("dike-rubric-bitter-taste eval characteristics", () => {
	const caseRaw = baselineData.cases.find((c: { id: string }) => c.id === "dike-rubric-bitter-taste");
	if (!caseRaw) throw new Error("dike-rubric-bitter-taste not found in baseline dataset");
	const evalCase = caseRaw as EvalCase;

	test("compliant output: BELOW_BAR with Oracle routing and no redesign passes", () => {
		const output =
			"## Rubric Rollup\n| R1 | Orchestration simplicity | BELOW_BAR | R1 | src/workflow.ts | no |\n\nR1 BELOW_BAR: 4-agent sequential hop pattern at src/workflow.ts violates R1 (single-agent delegation bar). Architecture redesign concerns escalated to Oracle.";
		const result = evaluateCase(evalCase, output);
		expect(result.passed).toBe(true);
		expect(result.failures).toEqual([]);
	});

	test("violating output: 'You should replace' prescription fails", () => {
		const output = "R1 BELOW_BAR: src/workflow.ts. You should replace the 4-agent chain with a single Vulkanus call.";
		const result = evaluateCase(evalCase, output);
		expect(result.passed).toBe(false);
		expect(result.failures.some((f) => f.includes("[Yy]ou should.*replace"))).toBe(true);
	});

	test("violating output: missing Oracle routing fails", () => {
		const output = "R1 BELOW_BAR: src/workflow.ts violates the orchestration simplicity bar.";
		const result = evaluateCase(evalCase, output);
		expect(result.passed).toBe(false);
		expect(result.failures.some((f) => f.includes("missing required regex"))).toBe(true);
	});
});

describe("eval runner", () => {
	test("does not use dataset mockOutput as default validation evidence", async () => {
		const previous = process.env.PANTHEON_ACPX_BIN;
		process.env.PANTHEON_ACPX_BIN = join(tmpdir(), "pantheon-definitely-missing-acpx");
		try {
			const suite = await runEvalSuite({
				cases: [{ ...baseCase, mockOutput: matchingOutput } as EvalCase],
			});

			expect(suite.success).toBe(false);
			expect(suite.passed).toBe(0);
			expect(suite.results[0].failures.join("\n")).toContain("Agent invocation failed");
		} finally {
			if (previous === undefined) delete process.env.PANTHEON_ACPX_BIN;
			else process.env.PANTHEON_ACPX_BIN = previous;
		}
	});

	test("can run deterministic unit tests through an injected provider without calling acpx", async () => {
		const calls: Array<{ agent: string; prompt: string }> = [];
		const provider: EvalOutputProvider = async (testCase) => {
			calls.push({ agent: testCase.targetAgent, prompt: testCase.inputPrompt });
			return "Risk and recommendation with a trade-off.";
		};

		const suite = await runEvalSuite({ cases: [baseCase], outputProvider: provider });

		expect(suite.success).toBe(true);
		expect(calls).toEqual([{ agent: "oracle", prompt: "Review a risky plan." }]);
	});

	test("explicit fixture mode can use fixtureOutput but is not the default", async () => {
		const suite = await runEvalSuite({
			fixtureMode: true,
			cases: [
				{
					...baseCase,
					fixtureOutput: matchingOutput,
				} as EvalCase,
			],
		});

		expect(suite.success).toBe(true);
		expect(suite.passed).toBe(1);
	});

	test("marks the suite failed when any case fails", async () => {
		const provider: EvalOutputProvider = async () => "off topic";
		const suite = await runEvalSuite({ cases: [baseCase], outputProvider: provider });

		expect(suite.success).toBe(false);
		expect(suite.passed).toBe(0);
		expect(suite.failed).toBe(1);
		expect(suite.results[0].failures).toContain("missing required substring: risk");
	});

	test("CLI defaults to live acpx invocation and exits zero when cases pass", async () => {
		const datasetDir = await writeDataset([baseCase]);
		const acpxBin = await writeFakeAcpx(matchingOutput, 0);
		const result = runEvalCli(datasetDir, { PANTHEON_ACPX_BIN: acpxBin });

		expect(result.exitCode).toBe(0);
		expect(stdoutText(result)).toContain("Eval summary: 1/1 passing (0 failed)");
		expect(stdoutText(result)).toContain("Live eval mode: invoking real Pantheon agents through acpx.");
	});

	test("CLI exits nonzero when live agent invocation fails", async () => {
		const datasetDir = await writeDataset([baseCase]);
		const acpxBin = await writeFakeAcpx("boom", 42);
		const result = runEvalCli(datasetDir, { PANTHEON_ACPX_BIN: acpxBin });

		expect(result.exitCode).not.toBe(0);
		expect(stdoutText(result)).toContain("Eval summary: 0/1 passing (1 failed)");
		expect(stdoutText(result)).toContain("FAIL oracle-review-format [oracle]");
		expect(stdoutText(result)).toContain("Agent invocation failed");
	});

	test("can load and run a single targeted dataset file", async () => {
		const datasetDir = await mkdtemp(join(tmpdir(), "pantheon-evals-"));
		const targetFile = join(datasetDir, "target.json");
		await writeFile(targetFile, `${JSON.stringify({ name: "target", cases: [baseCase] }, null, 2)}\n`, "utf8");
		await writeFile(
			join(datasetDir, "other.json"),
			`${JSON.stringify({ name: "other", cases: [{ ...baseCase, id: "other-case" }] }, null, 2)}\n`,
			"utf8",
		);

		const cases = await loadEvalCases(datasetDir, targetFile);
		const suite = await runEvalSuite({
			datasetDir,
			datasetFile: targetFile,
			outputProvider: async () => matchingOutput,
		});

		expect(cases.map((testCase) => testCase.id)).toEqual(["oracle-review-format"]);
		expect(suite.total).toBe(1);
		expect(suite.success).toBe(true);
	});

	test("suite results include requestedModel from agent config and resolvedModel=null with source annotation", async () => {
		const provider: EvalOutputProvider = async () => matchingOutput;
		const suite = await runEvalSuite({ cases: [baseCase], outputProvider: provider });

		const result = suite.results[0];
		expect(result.requestedModel).toBe("claude-opus-4-8"); // oracle is claude-opus-4-8 per AGENT_CONFIGS
		expect(result.resolvedModel).toBeNull();
		expect(result.resolvedModelSource).toContain("unavailable");
	});

	test("model fields are populated even when agent invocation fails (error branch)", async () => {
		const previous = process.env.PANTHEON_ACPX_BIN;
		process.env.PANTHEON_ACPX_BIN = join(tmpdir(), "pantheon-definitely-missing-acpx-model-test");
		try {
			const suite = await runEvalSuite({ cases: [baseCase] });
			const result = suite.results[0];
			expect(result.requestedModel).toBe("claude-opus-4-8");
			expect(result.resolvedModel).toBeNull();
			expect(result.resolvedModelSource).toContain("unavailable");
		} finally {
			if (previous === undefined) delete process.env.PANTHEON_ACPX_BIN;
			else process.env.PANTHEON_ACPX_BIN = previous;
		}
	});

	test("rejects empty eval datasets instead of reporting a false green", async () => {
		const datasetDir = await mkdtemp(join(tmpdir(), "pantheon-evals-empty-"));
		const emptyFile = join(datasetDir, "empty.json");
		await writeFile(emptyFile, `${JSON.stringify({ name: "empty", cases: [] }, null, 2)}\n`, "utf8");

		await expect(runEvalSuite({ datasetFile: emptyFile })).rejects.toThrow("Eval suite has no cases");
	});

	test("CLI can run a single targeted dataset file", async () => {
		const datasetDir = await writeDataset([{ ...baseCase, id: "other-case" }]);
		const datasetFile = join(datasetDir, "target.json");
		await writeFile(datasetFile, `${JSON.stringify({ name: "target", cases: [baseCase] }, null, 2)}\n`, "utf8");
		const acpxBin = await writeFakeAcpx(matchingOutput, 0);
		const result = runEvalCli(datasetDir, { PANTHEON_ACPX_BIN: acpxBin, PANTHEON_EVAL_DATASET_FILE: datasetFile });

		expect(result.exitCode).toBe(0);
		expect(stdoutText(result)).toContain("Eval summary: 1/1 passing (0 failed)");
		expect(stdoutText(result)).toContain("PASS oracle-review-format [oracle]");
		expect(stdoutText(result)).not.toContain("other-case");
	});

	test("CLI fixture mode is explicit and non-authoritative", async () => {
		const datasetDir = await writeDataset([{ ...baseCase, fixtureOutput: matchingOutput } as EvalCase]);
		const result = runEvalCli(datasetDir, { PANTHEON_EVAL_MODE: "fixtures" });

		expect(result.exitCode).toBe(0);
		expect(stdoutText(result)).toContain("Fixture eval mode: using explicit fixtureOutput values.");
		expect(stdoutText(result)).toContain("not valid release evidence");
	});
});

async function writeDataset(cases: EvalCase[]) {
	const datasetDir = await mkdtemp(join(tmpdir(), "pantheon-evals-"));
	await writeFile(
		join(datasetDir, "dataset.json"),
		`${JSON.stringify({ name: "cli-test", cases }, null, 2)}\n`,
		"utf8",
	);
	return datasetDir;
}

async function writeFakeAcpx(output: string, exitCode: number) {
	const dir = await mkdtemp(join(tmpdir(), "pantheon-fake-acpx-"));
	const bin = join(dir, "acpx");
	await writeFile(bin, `#!/usr/bin/env bash\necho ${JSON.stringify(output)}\nexit ${exitCode}\n`, "utf8");
	await chmod(bin, 0o755);
	return bin;
}

function runEvalCli(datasetDir: string, extraEnv: Record<string, string> = {}) {
	return Bun.spawnSync({
		cmd: [process.execPath, "evals/scripts/run-evals.ts"],
		env: {
			...process.env,
			PANTHEON_EVAL_DATASET_DIR: datasetDir,
			...extraEnv,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
}

function stdoutText(result: ReturnType<typeof runEvalCli>) {
	return new TextDecoder().decode(result.stdout);
}
