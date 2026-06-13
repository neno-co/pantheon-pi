#!/usr/bin/env bun
import { checkInstallPrerequisites } from "../src/install-check/index.ts";

const report = checkInstallPrerequisites({ requireAcpx: false });

if (!report.ok) {
	console.error("pantheon-pi build check failed");
	for (const failure of report.failures) console.error(`error: ${failure}`);
	process.exit(1);
}

console.log("pantheon-pi uses raw TypeScript Pi extension loading; no bundle artifact is required.");
console.log("Distribution manifest and package resources are valid.");
