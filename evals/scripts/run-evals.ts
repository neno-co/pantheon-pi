#!/usr/bin/env bun
import { formatEvalSummary, runEvalSuite } from "../../src/evals/index.ts";

function isFixtureMode(value: string | undefined) {
	return value === "fixtures" || value === "fixture";
}

const fixtureMode = isFixtureMode(process.env.PANTHEON_EVAL_MODE);
const datasetDir = process.env.PANTHEON_EVAL_DATASET_DIR ?? (fixtureMode ? "evals/fixtures" : "evals/datasets");
const datasetFile = process.env.PANTHEON_EVAL_DATASET_FILE;
const resultsPath = process.env.PANTHEON_EVAL_RESULTS;

const suite = await runEvalSuite({ datasetDir, datasetFile, fixtureMode, resultsPath });

console.log(formatEvalSummary(suite));
if (resultsPath) console.log(`Structured results written to ${resultsPath}`);
if (fixtureMode) {
	console.log("Fixture eval mode: using explicit fixtureOutput values. This is not valid release evidence.");
} else {
	console.log("Live eval mode: invoking real Pantheon agents through acpx.");
}

if (!suite.success) process.exit(1);
