#!/usr/bin/env bun
import { checkInstallPrerequisites } from "../src/install-check/index.ts";

const args = new Set(process.argv.slice(2));
const requireAcpx = args.has("--strict") || args.has("--require-acpx") || process.env.PANTHEON_REQUIRE_ACPX === "true";
const report = checkInstallPrerequisites({ requireAcpx });

console.log(`pantheon-pi install check: ${report.ok ? "ok" : "failed"}`);
console.log(`root: ${report.rootDir}`);
console.log(`package: ${report.manifest.packageName ?? "unknown"}@${report.manifest.version ?? "unknown"}`);
console.log(
	`extension: ${report.resources.extensionEntrypoint.exists ? "ok" : "missing"} (${report.resources.extensionEntrypoint.path})`,
);
console.log(
	`cli: ${report.resources.cliEntrypoint.exists ? "ok" : "missing"} (${report.resources.cliEntrypoint.path}, bin.pantheon -> ${report.manifest.bin.pantheon ?? "unset"})`,
);
console.log(`telemetry: ${report.resources.telemetry.exists ? "ok" : "missing"} (${report.resources.telemetry.path})`);
console.log(`agent prompts: ${report.resources.prompts.exists ? "ok" : "missing"} (${report.resources.prompts.path})`);
console.log(`manifests: ${report.resources.manifests.exists ? "ok" : "missing"} (${report.resources.manifests.path})`);
console.log(`agent bins: ${report.resources.bin.exists ? "ok" : "missing"} (${report.resources.bin.path})`);
console.log(
	`skills: ${report.resources.skills.exists ? "ok" : "missing"} (${report.resources.skills.path}, ${report.resources.skills.agentCount ?? 0} declared)`,
);
console.log(
	`acpx: ${report.acpx.found ? `ok (${report.acpx.path})` : report.acpx.required ? "missing" : "optional missing"}`,
);

for (const warning of report.warnings) console.warn(`warning: ${warning}`);
for (const failure of report.failures) console.error(`error: ${failure}`);

if (!report.ok) process.exit(1);
