import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAgentConfig, isPantheonAgent } from "../agents.ts";
import { runAcpx } from "../runner/index.ts";

export interface EvalExpectedCharacteristics {
	requiredSubstrings?: string[];
	forbiddenSubstrings?: string[];
	requiredRegex?: string[];
	forbiddenRegex?: string[];
	caseSensitive?: boolean;
	minScore?: number;
}

export interface EvalCase {
	id: string;
	targetAgent: string;
	inputPrompt: string;
	expectedOutputCharacteristics: EvalExpectedCharacteristics;
	/**
	 * Explicit non-authoritative fixture output for deterministic local checks.
	 * Release/validation evals must not use this field.
	 */
	fixtureOutput?: string;
	metadata?: Record<string, unknown>;
}

export interface EvalDataset {
	name: string;
	description?: string;
	cases: EvalCase[];
}

export interface EvalCaseResult {
	id: string;
	targetAgent: string;
	passed: boolean;
	score: number;
	threshold: number;
	failures: string[];
	output: string;
	durationMs: number;
	requestedModel: string;
	resolvedModel: string | null;
	resolvedModelSource: string;
}

export interface EvalSuiteResult {
	success: boolean;
	total: number;
	passed: number;
	failed: number;
	results: EvalCaseResult[];
	startedAt: string;
	finishedAt: string;
	durationMs: number;
}

export type EvalOutputProvider = (testCase: EvalCase) => Promise<string>;

export interface RunEvalSuiteOptions {
	cases?: EvalCase[];
	datasetDir?: string;
	/**
	 * Non-authoritative deterministic mode. Defaults to false; normal evals invoke acpx.
	 */
	fixtureMode?: boolean;
	cwd?: string;
	outputProvider?: EvalOutputProvider;
	resultsPath?: string;
	datasetFile?: string;
}

function includes(text: string, expected: string, caseSensitive: boolean) {
	if (caseSensitive) return text.includes(expected);
	return text.toLowerCase().includes(expected.toLowerCase());
}

function regexMatches(text: string, pattern: string, caseSensitive: boolean) {
	return new RegExp(pattern, caseSensitive ? undefined : "i").test(text);
}

export function evaluateCase(
	testCase: EvalCase,
	output: string,
): Omit<EvalCaseResult, "requestedModel" | "resolvedModel" | "resolvedModelSource"> {
	const expected = testCase.expectedOutputCharacteristics;
	const caseSensitive = expected.caseSensitive ?? false;
	const failures: string[] = [];
	let checks = 0;
	let passedChecks = 0;

	for (const required of expected.requiredSubstrings ?? []) {
		checks += 1;
		if (includes(output, required, caseSensitive)) {
			passedChecks += 1;
		} else {
			failures.push(`missing required substring: ${required}`);
		}
	}

	for (const forbidden of expected.forbiddenSubstrings ?? []) {
		checks += 1;
		if (includes(output, forbidden, caseSensitive)) {
			failures.push(`matched forbidden substring: ${forbidden}`);
		} else {
			passedChecks += 1;
		}
	}

	for (const pattern of expected.requiredRegex ?? []) {
		checks += 1;
		if (regexMatches(output, pattern, caseSensitive)) {
			passedChecks += 1;
		} else {
			failures.push(`missing required regex: ${pattern}`);
		}
	}

	for (const pattern of expected.forbiddenRegex ?? []) {
		checks += 1;
		if (regexMatches(output, pattern, caseSensitive)) {
			failures.push(`matched forbidden regex: ${pattern}`);
		} else {
			passedChecks += 1;
		}
	}

	const score = checks === 0 ? 1 : passedChecks / checks;
	const threshold = expected.minScore ?? 1;

	return {
		id: testCase.id,
		targetAgent: testCase.targetAgent,
		passed: failures.length === 0 && score >= threshold,
		score,
		threshold,
		failures,
		output,
		durationMs: 0,
	};
}

async function findDatasetFiles(datasetDir: string) {
	const entries = await readdir(datasetDir, { withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => path.join(datasetDir, entry.name))
		.sort();
}

function validateDataset(dataset: EvalDataset, filePath: string) {
	if (!dataset.name || !Array.isArray(dataset.cases)) {
		throw new Error(`Invalid eval dataset: ${filePath}`);
	}
	for (const testCase of dataset.cases) {
		if (!testCase.id || !testCase.targetAgent || !testCase.inputPrompt || !testCase.expectedOutputCharacteristics) {
			throw new Error(`Invalid eval case in ${filePath}`);
		}
	}
}

export async function loadDatasetFile(datasetFile: string): Promise<EvalDataset> {
	const dataset = JSON.parse(await readFile(datasetFile, "utf8")) as EvalDataset;
	validateDataset(dataset, datasetFile);
	return dataset;
}

export async function loadDatasets(datasetDir = "evals/datasets"): Promise<EvalDataset[]> {
	const files = await findDatasetFiles(datasetDir);
	const datasets: EvalDataset[] = [];

	for (const file of files) {
		datasets.push(await loadDatasetFile(file));
	}

	return datasets;
}

export async function loadEvalCases(datasetDir = "evals/datasets", datasetFile?: string) {
	if (datasetFile) return (await loadDatasetFile(datasetFile)).cases;
	const datasets = await loadDatasets(datasetDir);
	return datasets.flatMap((dataset) => dataset.cases);
}

async function defaultOutputProvider(testCase: EvalCase, options: RunEvalSuiteOptions) {
	if (options.fixtureMode) {
		if (testCase.fixtureOutput !== undefined) return testCase.fixtureOutput;
		throw new Error(`Fixture eval case is missing fixtureOutput: ${testCase.id}`);
	}

	const result = await runAcpx({
		agent: testCase.targetAgent,
		prompt: testCase.inputPrompt,
		cwd: options.cwd ?? process.cwd(),
		permissions: "deny-all",
		timeoutSeconds: 120,
		maxTurns: 1,
	});

	if (!result.success) {
		const details = [result.error, result.finalAnswer, result.stderr].filter(Boolean).join("\n");
		throw new Error(`Agent invocation failed for ${testCase.id} (${testCase.targetAgent}): ${details}`);
	}
	return result.finalAnswer;
}

const RESOLVED_MODEL_SOURCE = "unavailable — acpx does not expose effective model";

function getModelFields(
	targetAgent: string,
): Pick<EvalCaseResult, "requestedModel" | "resolvedModel" | "resolvedModelSource"> {
	const requestedModel = isPantheonAgent(targetAgent) ? getAgentConfig(targetAgent).model : "unknown";
	return { requestedModel, resolvedModel: null, resolvedModelSource: RESOLVED_MODEL_SOURCE };
}

export async function runEvalSuite(options: RunEvalSuiteOptions = {}): Promise<EvalSuiteResult> {
	const started = Date.now();
	const startedAt = new Date(started).toISOString();
	const cases = options.cases ?? (await loadEvalCases(options.datasetDir, options.datasetFile));
	if (cases.length === 0) throw new Error("Eval suite has no cases");
	const results: EvalCaseResult[] = [];

	for (const testCase of cases) {
		const caseStarted = Date.now();
		try {
			const output = options.outputProvider
				? await options.outputProvider(testCase)
				: await defaultOutputProvider(testCase, options);
			results.push({
				...evaluateCase(testCase, output),
				...getModelFields(testCase.targetAgent),
				durationMs: Date.now() - caseStarted,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			results.push({
				id: testCase.id,
				targetAgent: testCase.targetAgent,
				passed: false,
				score: 0,
				threshold: testCase.expectedOutputCharacteristics.minScore ?? 1,
				failures: [message],
				output: "",
				durationMs: Date.now() - caseStarted,
				...getModelFields(testCase.targetAgent),
			});
		}
	}

	const passed = results.filter((result) => result.passed).length;
	const finishedAt = new Date().toISOString();
	const suite: EvalSuiteResult = {
		success: passed === results.length,
		total: results.length,
		passed,
		failed: results.length - passed,
		results,
		startedAt,
		finishedAt,
		durationMs: Date.now() - started,
	};

	if (options.resultsPath) {
		await writeFile(options.resultsPath, `${JSON.stringify(suite, null, 2)}\n`);
	}

	return suite;
}

export function formatEvalSummary(suite: EvalSuiteResult) {
	const lines = [`Eval summary: ${suite.passed}/${suite.total} passing (${suite.failed} failed)`];

	for (const result of suite.results) {
		const status = result.passed ? "PASS" : "FAIL";
		lines.push(
			`${status} ${result.id} [${result.targetAgent}] score=${result.score.toFixed(2)} threshold=${result.threshold}`,
		);
		for (const failure of result.failures) {
			lines.push(`  - ${failure}`);
		}
	}

	return lines.join("\n");
}
