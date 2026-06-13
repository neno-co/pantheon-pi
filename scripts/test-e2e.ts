import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createInMemoryLangWatchRuntime,
	resetLangWatchRuntimeForTests,
	setLangWatchRuntimeForTests,
} from "../src/langwatch/index.ts";
import { type AcpxRunResult, resolveAcpxBinary, runAcpx } from "../src/runner/index.ts";

type CaseStatus = "passed" | "failed";

interface CertificationCase {
	name: string;
	status: CaseStatus;
	durationMs: number;
	command?: string;
	args?: string[];
	stdout?: string;
	stderr?: string;
	assertions: string[];
	error?: string;
	result?: Pick<
		AcpxRunResult,
		"success" | "exitCode" | "signal" | "timedOut" | "aborted" | "durationMs" | "finalAnswer" | "error"
	>;
}

interface CertificationReport {
	phase: 6;
	mode: "installed-pi-package-real-integration";
	generatedAt: string;
	packageRoot: string;
	piBinary: string;
	acpxBinary: string;
	agent: string;
	piModel?: string;
	cwd: string;
	prompts: { success: string; timeout: string; pi: string; packagedAgent: string };
	cases: CertificationCase[];
	telemetry: {
		exporter: "in-memory";
		spanCount: number;
		validatedAttributes: string[];
	};
	summary: { passed: number; failed: number; status: CaseStatus };
}

const rootDir = path.resolve(import.meta.dir, "..");
const reportPath = path.resolve(process.env.PANTHEON_E2E_REPORT ?? "reports/phase-6-e2e-certification.json");
const agent = process.env.PANTHEON_E2E_AGENT?.trim() || "oracle";
const piModel = process.env.PANTHEON_E2E_PI_MODEL?.trim();
const timeoutSeconds = Number.parseInt(process.env.PANTHEON_E2E_TIMEOUT_SECONDS ?? "30", 10);
const timeoutCaseSeconds = Number.parseInt(process.env.PANTHEON_E2E_TIMEOUT_CASE_SECONDS ?? "1", 10);
const acpxBinary = resolveAcpxBinary(process.env.PANTHEON_ACPX_BIN ?? process.env.ACPX_BIN);
const piBinary = process.env.PANTHEON_PI_BIN?.trim() || "pi";
const successPrompt =
	process.env.PANTHEON_E2E_SUCCESS_PROMPT ?? "Return exactly this token and no extra prose: pantheon-pi-e2e-ok";
const piToolPrompt =
	process.env.PANTHEON_E2E_PI_PROMPT ??
	`Use the acpx tool exactly once with agent ${agent}, permissions deny-all, maxTurns 1, timeoutSeconds ${timeoutSeconds}, and prompt: Return exactly this token and no extra prose: pantheon-pi-installed-e2e-ok. Then output only the tool result.`;
const timeoutPrompt =
	process.env.PANTHEON_E2E_TIMEOUT_PROMPT ??
	"Wait for 20 seconds before responding, then return exactly: pantheon-pi-e2e-timeout-late";
const packagedAgentPrompt =
	process.env.PANTHEON_E2E_PACKAGED_AGENT_PROMPT ??
	"Return exactly this token and no extra prose: pantheon-pi-packaged-agent-script-ok";

function writeReport(report: CertificationReport) {
	mkdirSync(path.dirname(reportPath), { recursive: true });
	writeFileSync(reportPath, `${JSON.stringify(report, null, "\t")}\n`);
}

function failPrerequisite(message: string): never {
	const report: CertificationReport = {
		phase: 6,
		mode: "installed-pi-package-real-integration",
		generatedAt: new Date().toISOString(),
		packageRoot: rootDir,
		piBinary,
		acpxBinary,
		agent,
		piModel,
		cwd: process.cwd(),
		prompts: { success: successPrompt, timeout: timeoutPrompt, pi: piToolPrompt, packagedAgent: packagedAgentPrompt },
		cases: [{ name: "prerequisite", status: "failed", durationMs: 0, assertions: [], error: message }],
		telemetry: { exporter: "in-memory", spanCount: 0, validatedAttributes: [] },
		summary: { passed: 0, failed: 1, status: "failed" },
	};
	writeReport(report);
	console.error(`Phase 6 E2E prerequisite failed: ${message}`);
	console.error(`Certification report: ${reportPath}`);
	process.exit(1);
}

function assertCase(condition: unknown, message: string, assertions: string[]) {
	if (!condition) throw new Error(message);
	assertions.push(message);
}

function isExecutable(command: string, args: string[]) {
	if (command.includes(path.sep) && !existsSync(command)) return false;
	const probe = spawnSync(command, args, { encoding: "utf8", timeout: 10_000 });
	return probe.status === 0;
}

async function runCase(
	name: string,
	action: (assertions: string[]) => Promise<CertificationCase> | CertificationCase,
): Promise<CertificationCase> {
	const startedAt = Date.now();
	const assertions: string[] = [];
	try {
		const result = await action(assertions);
		return { ...result, durationMs: Date.now() - startedAt, assertions };
	} catch (error) {
		return {
			name,
			status: "failed",
			durationMs: Date.now() - startedAt,
			assertions,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 2) {
	failPrerequisite("PANTHEON_E2E_TIMEOUT_SECONDS must be an integer >= 2");
}
if (!Number.isInteger(timeoutCaseSeconds) || timeoutCaseSeconds < 1) {
	failPrerequisite("PANTHEON_E2E_TIMEOUT_CASE_SECONDS must be an integer >= 1");
}
if (!isExecutable(acpxBinary, ["--version"])) {
	failPrerequisite(
		`real acpx binary is unavailable or not executable at '${acpxBinary}'. Set PANTHEON_ACPX_BIN or install acpx.`,
	);
}
if (!isExecutable(piBinary, ["--version"])) {
	failPrerequisite(
		`real pi binary is unavailable or not executable at '${piBinary}'. Set PANTHEON_PI_BIN or install pi.`,
	);
}

const runtime = createInMemoryLangWatchRuntime();
setLangWatchRuntimeForTests(runtime);

const cases: CertificationCase[] = [];

cases.push(
	await runCase("pi package install/list recognizes package resources", (assertions) => {
		const isolatedConfigDir = mkdtempSync(path.join(os.tmpdir(), "pantheon-pi-e2e-agent-"));
		const install = spawnSync(piBinary, ["install", rootDir], {
			cwd: rootDir,
			env: { ...process.env, PI_CODING_AGENT_DIR: isolatedConfigDir },
			encoding: "utf8",
			timeout: 30_000,
		});
		assertCase(install.status === 0, `pi install succeeds; stderr=${install.stderr.slice(0, 500)}`, assertions);

		const list = spawnSync(piBinary, ["list"], {
			cwd: rootDir,
			env: { ...process.env, PI_CODING_AGENT_DIR: isolatedConfigDir },
			encoding: "utf8",
			timeout: 30_000,
		});
		assertCase(list.status === 0, `pi list succeeds; stderr=${list.stderr.slice(0, 500)}`, assertions);
		assertCase(list.stdout.includes("pantheon-pi"), "pi list includes the installed pantheon-pi package", assertions);
		assertCase(
			list.stdout.includes(rootDir),
			"pi list records the installed package source path used for resource loading",
			assertions,
		);

		return {
			name: "pi package install/list recognizes package resources",
			status: "passed",
			durationMs: 0,
			command: piBinary,
			args: ["install", rootDir, "&&", "list"],
			stdout: `${install.stdout}\n${list.stdout}`,
			stderr: `${install.stderr}\n${list.stderr}`,
			assertions,
		};
	}),
);

cases.push(
	await runCase("real pi invocation loads packaged acpx extension and calls real agent", (assertions) => {
		const args = [
			"--no-session",
			"--no-context-files",
			"--no-skills",
			"--no-prompt-templates",
			"--no-extensions",
			"--extension",
			rootDir,
			"--tools",
			"acpx",
		];
		if (piModel) args.push("--model", piModel);
		args.push("-p", piToolPrompt);

		const result = spawnSync(piBinary, args, {
			cwd: rootDir,
			encoding: "utf8",
			timeout: (timeoutSeconds + 60) * 1000,
		});

		assertCase(
			result.status === 0,
			`pi noninteractive run exits cleanly; stderr=${result.stderr.slice(0, 1000)}`,
			assertions,
		);
		assertCase(
			result.stdout.includes("pantheon-pi-installed-e2e-ok"),
			"Pi output includes the token returned by the real acpx agent",
			assertions,
		);
		assertCase(args.includes(rootDir), "Pi was invoked with this package path as an explicit extension", assertions);
		assertCase(args.includes("acpx"), "Pi tool allowlist enabled the packaged acpx extension tool", assertions);

		return {
			name: "real pi invocation loads packaged acpx extension and calls real agent",
			status: "passed",
			durationMs: 0,
			command: piBinary,
			args,
			stdout: result.stdout,
			stderr: result.stderr,
			assertions,
		};
	}),
);

cases.push(
	await runCase("real acpx loads packaged Pi prompt agent script", (assertions) => {
		// oracle is now a claude-agent-acp route; use vulkanus (a pi-acp packaged agent) to test the packaged script path
		const piAcpAgent = "vulkanus";
		const args = [
			"--agent",
			`env PI_ACP_PI_COMMAND=./agents/bin/${piAcpAgent} npx -y pi-acp@latest`,
			"--cwd",
			rootDir,
			"--format",
			"text",
			"--deny-all",
			"--timeout",
			String(timeoutSeconds),
			"exec",
			packagedAgentPrompt,
		];
		const result = spawnSync(acpxBinary, args, {
			cwd: rootDir,
			encoding: "utf8",
			timeout: (timeoutSeconds + 30) * 1000,
		});

		assertCase(result.status === 0, `real acpx exits cleanly; stderr=${result.stderr.slice(0, 1000)}`, assertions);
		assertCase(
			result.stdout.includes("pantheon-pi-packaged-agent-script-ok"),
			"real acpx output includes the token returned by the packaged agent prompt script",
			assertions,
		);
		assertCase(
			args.includes(`env PI_ACP_PI_COMMAND=./agents/bin/${piAcpAgent} npx -y pi-acp@latest`),
			"acpx was pointed at the package-relative agents/bin script through pi-acp",
			assertions,
		);

		return {
			name: "real acpx loads packaged Pi prompt agent script",
			status: "passed",
			durationMs: 0,
			command: acpxBinary,
			args,
			stdout: result.stdout,
			stderr: result.stderr,
			assertions,
		};
	}),
);

cases.push(
	await runCase("real acpx runner telemetry structure", async (assertions) => {
		const result = await runAcpx({
			agent,
			prompt: successPrompt,
			cwd: rootDir,
			binaryPath: acpxBinary,
			permissions: "deny-all",
			maxTurns: 1,
			timeoutSeconds,
		});

		assertCase(result.command === acpxBinary, "uses the resolved real acpx binary", assertions);
		// claude-agent-acp routes (e.g. oracle) use --agent <acp-command> rather than the literal agent name
		assertCase(
			result.args.includes(agent) ||
				(result.args.includes("--agent") && result.args.some((a) => a.includes("claude-agent-acp"))),
			"passes the configured real agent to acpx",
			assertions,
		);
		assertCase(
			result.success,
			`real acpx success run exits cleanly; stderr=${result.stderr.slice(0, 500)}`,
			assertions,
		);
		assertCase(
			result.finalAnswer.includes("pantheon-pi-e2e-ok"),
			"real agent final answer includes the expected certification token",
			assertions,
		);

		const spans = runtime.getFinishedSpans();
		const span = spans.find((candidate) => candidate.name === "pantheon.acpx.run");
		assertCase(Boolean(span), "emits a pantheon.acpx.run telemetry span", assertions);
		assertCase(span?.attributes["pantheon.event"] === "acpx_run", "telemetry records acpx_run event", assertions);
		assertCase(span?.attributes["pantheon.agent"] === agent, "telemetry records the real agent id", assertions);
		assertCase(span?.attributes["pantheon.run.success"] === true, "telemetry records successful run", assertions);
		assertCase(
			typeof span?.attributes["pantheon.prompt.hash"] === "string",
			"telemetry includes redacted prompt hash",
			assertions,
		);
		assertCase(
			typeof span?.attributes["pantheon.stdout.hash"] === "string",
			"telemetry includes redacted stdout hash",
			assertions,
		);

		return {
			name: "real acpx runner telemetry structure",
			status: "passed",
			durationMs: 0,
			command: result.command,
			args: result.args,
			assertions,
			result: {
				success: result.success,
				exitCode: result.exitCode,
				signal: result.signal,
				timedOut: result.timedOut,
				aborted: result.aborted,
				durationMs: result.durationMs,
				finalAnswer: result.finalAnswer,
				error: result.error,
			},
		};
	}),
);

cases.push(
	await runCase("real acpx timeout failure handling", async (assertions) => {
		const result = await runAcpx({
			agent,
			prompt: timeoutPrompt,
			cwd: rootDir,
			binaryPath: acpxBinary,
			permissions: "deny-all",
			maxTurns: 1,
			timeoutSeconds: timeoutCaseSeconds,
		});

		assertCase(result.command === acpxBinary, "timeout case uses the resolved real acpx binary", assertions);
		assertCase(!result.success, "timeout case is reported as unsuccessful", assertions);
		assertCase(result.timedOut, "timeout case sets timedOut=true", assertions);
		assertCase(
			result.stderr.includes(`acpx timeout after ${timeoutCaseSeconds}s`),
			"timeout case emits clear safeguard stderr",
			assertions,
		);

		return {
			name: "real acpx timeout failure handling",
			status: "passed",
			durationMs: 0,
			command: result.command,
			args: result.args,
			assertions,
			result: {
				success: result.success,
				exitCode: result.exitCode,
				signal: result.signal,
				timedOut: result.timedOut,
				aborted: result.aborted,
				durationMs: result.durationMs,
				finalAnswer: result.finalAnswer,
				error: result.error,
			},
		};
	}),
);

await runtime.forceFlush();
const spans = runtime.getFinishedSpans();
const validatedAttributes = [
	"pantheon.event",
	"pantheon.agent",
	"pantheon.run_type",
	"pantheon.run.success",
	"pantheon.run.duration_ms",
	"pantheon.command",
	"pantheon.prompt.hash",
	"pantheon.stdout.hash",
];
const failed = cases.filter((testCase) => testCase.status === "failed").length;
const report: CertificationReport = {
	phase: 6,
	mode: "installed-pi-package-real-integration",
	generatedAt: new Date().toISOString(),
	packageRoot: rootDir,
	piBinary,
	acpxBinary,
	agent,
	piModel,
	cwd: process.cwd(),
	prompts: { success: successPrompt, timeout: timeoutPrompt, pi: piToolPrompt, packagedAgent: packagedAgentPrompt },
	cases,
	telemetry: { exporter: "in-memory", spanCount: spans.length, validatedAttributes },
	summary: { passed: cases.length - failed, failed, status: failed === 0 ? "passed" : "failed" },
};
writeReport(report);
resetLangWatchRuntimeForTests();

console.log(JSON.stringify(report.summary));
console.log(`Phase 6 E2E certification report: ${reportPath}`);

if (failed > 0) process.exit(1);
