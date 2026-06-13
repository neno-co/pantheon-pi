import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	applyHashlineEdit,
	computeHashlines,
	runDiagnostics,
	structuralReplace,
	structuralSearch,
} from "../src/extension/pantheon-tooling/index.ts";

type CaseResult = {
	name: string;
	category: "diagnostics" | "ast" | "hashline";
	control?: unknown;
	treatment?: unknown;
	success: boolean;
	notes?: string[];
};

type RealCodeMetric = {
	name: string;
	dataset: string;
	operation: string;
	before?: unknown;
	after?: unknown;
	elapsedMs: number;
	success: boolean;
	notes?: string[];
};

type CommandEvidence = {
	name: string;
	command: string;
	args: string[];
	cwd: string;
	env?: Record<string, string>;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	durationMs: number;
	timedOut: boolean;
	status: "passed" | "failed" | "timeout";
	stdoutTail: string;
	stderrTail: string;
	outputArtifact: string;
};

type LangWatchInspection = {
	envPresent: boolean;
	endpoint: string;
	attempted: boolean;
	status?: number;
	ok?: boolean;
	responseTail?: string;
	error?: string;
};

const require = createRequire(import.meta.url);

function mean(values: number[]) {
	return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function tail(value: string, length = 8_000) {
	return value.slice(-length);
}

function redact(value: string) {
	return value
		.replace(/(LANGWATCH_API_KEY\s*=\s*)[^\s\r\n]+/gi, "$1[REDACTED]")
		.replace(/(Authorization:\s*Bearer\s+)[^\s\r\n]+/gi, "$1[REDACTED]")
		.replace(/(api[_-]?key["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, "$1[REDACTED]");
}

function redactedEnv(env: Record<string, string | undefined>) {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		out[key] = /KEY|TOKEN|SECRET|PASSWORD/i.test(key) ? "[REDACTED]" : value;
	}
	return out;
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>) {
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(env)) {
		previous.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await fn();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

async function measured<T>(fn: () => Promise<T>) {
	const startedAt = Date.now();
	const value = await fn();
	return { value, elapsedMs: Date.now() - startedAt };
}

async function runCapturedCommand(input: {
	name: string;
	command: string;
	args: string[];
	cwd: string;
	env?: Record<string, string | undefined>;
	timeoutMs: number;
	reportsDir: string;
	expect?: (result: { exitCode: number | null; stdout: string; stderr: string }) => boolean;
}): Promise<CommandEvidence> {
	const startedAt = Date.now();
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	const env = { ...process.env, ...(input.env ?? {}) };
	const child = spawn(input.command, input.args, {
		cwd: input.cwd,
		env,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const timer = setTimeout(() => {
		timedOut = true;
		if (child.pid) {
			child.kill("SIGTERM");
			setTimeout(() => {
				child.kill("SIGKILL");
			}, 2_000).unref();
		} else {
			child.kill("SIGTERM");
		}
	}, input.timeoutMs);

	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});

	const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.on("error", (error) => {
			stderr += `\nspawn error: ${error.message}`;
			resolve({ exitCode: 127, signal: null });
		});
		child.on("close", (exitCode, signal) => resolve({ exitCode: timedOut ? 124 : exitCode, signal }));
	});
	clearTimeout(timer);

	const slug = input.name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
	const outputArtifact = path.join(input.reportsDir, `${slug}.txt`);
	const evidence = [
		`$ ${input.command} ${input.args.join(" ")}`,
		`cwd: ${input.cwd}`,
		`env: ${JSON.stringify(redactedEnv(input.env ?? {}))}`,
		`exitCode: ${result.exitCode}`,
		`signal: ${result.signal ?? ""}`,
		`durationMs: ${Date.now() - startedAt}`,
		"--- stdout ---",
		redact(stdout),
		"--- stderr ---",
		redact(stderr),
	].join("\n");
	writeFileSync(outputArtifact, evidence);

	const didTimeOut = result.exitCode === 124;
	const passed =
		!didTimeOut && (input.expect ? input.expect({ exitCode: result.exitCode, stdout, stderr }) : result.exitCode === 0);
	return {
		name: input.name,
		command: input.command,
		args: input.args,
		cwd: input.cwd,
		env: redactedEnv(input.env ?? {}),
		exitCode: result.exitCode,
		signal: result.signal,
		durationMs: Date.now() - startedAt,
		timedOut: didTimeOut,
		status: didTimeOut ? "timeout" : passed ? "passed" : "failed",
		stdoutTail: redact(tail(stdout)),
		stderrTail: redact(tail(stderr)),
		outputArtifact: path.relative(path.resolve(import.meta.dir, ".."), outputArtifact),
	};
}

async function runDiagnosticsCase(input: { name: string; dir: string; targetPath: string }) {
	const control = await withEnv(
		{ PANTHEON_EXPERIMENTAL_LSP: undefined, PANTHEON_EXPERIMENTAL_LSP_COMMAND: undefined },
		() => runDiagnostics(input.dir, input.targetPath, 20_000),
	);
	const treatment = await withEnv(
		{ PANTHEON_EXPERIMENTAL_LSP: "1", PANTHEON_EXPERIMENTAL_LSP_COMMAND: undefined },
		() => runDiagnostics(input.dir, input.targetPath, 20_000),
	);
	return {
		name: input.name,
		category: "diagnostics" as const,
		control: control.metrics,
		treatment: treatment.metrics,
		success: !control.skipped && !treatment.skipped && treatment.metrics.source === "command",
		notes: [
			"Treatment attempted pi-lsp direct diagnostics. pi-lsp is installed as a bundled Pi extension but exposes no direct package diagnostics API, so Pantheon command diagnostics fallback was preserved.",
		],
	};
}

function resolvePiLspPackage() {
	const checked = ["pi-lsp", "@earendil-works/pi-lsp", "@earendil-works/pi-language-server"];
	for (const packageName of checked) {
		try {
			const packageJsonPath = require.resolve(`${packageName}/package.json`);
			const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
				version?: string;
				pi?: unknown;
				dependencies?: unknown;
			};
			const extensionPath = packageName === "pi-lsp" ? require.resolve("pi-lsp/extensions/pi-lsp/index.ts") : undefined;
			return {
				checked,
				installed: true,
				packageName,
				packageJsonPath,
				extensionPath,
				version: pkg.version,
				manifest: pkg.pi,
				dependencies: pkg.dependencies,
			};
		} catch {
			// Keep probing likely names.
		}
	}
	return { checked, installed: false };
}

async function inspectLangWatch(): Promise<LangWatchInspection> {
	const endpoint = (process.env.LANGWATCH_ENDPOINT ?? "https://app.langwatch.ai").replace(/\/+$/, "");
	const apiKey = process.env.LANGWATCH_API_KEY?.trim();
	if (!apiKey) return { envPresent: false, endpoint, attempted: false, error: "LANGWATCH_API_KEY is not present" };
	try {
		const response = await fetch(`${endpoint}/api/otel/v1/traces`, {
			method: "GET",
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(10_000),
		});
		const text = await response.text().catch(() => "");
		return {
			envPresent: true,
			endpoint,
			attempted: true,
			status: response.status,
			ok: response.ok,
			responseTail: redact(tail(text, 1_000)),
		};
	} catch (error) {
		return {
			envPresent: true,
			endpoint,
			attempted: true,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function main() {
	const repoRoot = path.resolve(import.meta.dir, "..");
	const reportsDir = path.join(repoRoot, "reports");
	const outputDir = path.join(reportsDir, "ahe-command-output");
	mkdirSync(outputDir, { recursive: true });
	const work = mkdtempSync(path.join(tmpdir(), "pantheon-ahe-"));
	const cases: CaseResult[] = [];
	const realCodeMetrics: RealCodeMetric[] = [];
	const commandEvidence: CommandEvidence[] = [];
	const piBinary = process.env.PANTHEON_PI_BIN?.trim() || "pi";
	const piModel = process.env.PANTHEON_AHE_PI_MODEL?.trim();
	const piLsp = resolvePiLspPackage();

	const tsDir = path.join(work, "ts");
	mkdirSync(tsDir);
	writeFileSync(path.join(tsDir, "app.ts"), "const answer: number = 'bad'\n");
	cases.push(
		await runDiagnosticsCase({
			name: "TypeScript diagnostics fallback with pi-lsp installed",
			dir: tsDir,
			targetPath: "app.ts",
		}),
	);

	const rustDir = path.join(work, "rust");
	mkdirSync(path.join(rustDir, "src"), { recursive: true });
	writeFileSync(path.join(rustDir, "Cargo.toml"), '[package]\nname = "ahe"\nversion = "0.0.0"\nedition = "2021"\n');
	writeFileSync(path.join(rustDir, "src/lib.rs"), "pub fn answer() -> i32 { 42 }\n");
	cases.push(
		await runDiagnosticsCase({
			name: "Rust diagnostics fallback with pi-lsp installed",
			dir: rustDir,
			targetPath: "src/lib.rs",
		}),
	);

	const astDir = path.join(work, "ast");
	mkdirSync(astDir);
	writeFileSync(path.join(astDir, "app.ts"), "const text = 'console.log(nope)'\nconsole.log(answer)\n");
	const astMatches = await structuralSearch({ cwd: astDir, paths: ["app.ts"], pattern: "console.log($ARG)" });
	const astReplacement = await structuralReplace({
		cwd: astDir,
		paths: ["app.ts"],
		pattern: "console.log($ARG)",
		rewrite: "logger.info($ARG)",
		dryRun: true,
	});
	cases.push({
		name: "AST structural correctness",
		category: "ast",
		control: { bundledAstGrepMatches: astMatches.length, firstCapture: astMatches[0]?.captures.ARG },
		treatment: { sameBundledTool: true, replacements: astReplacement.changedFiles[0]?.replacements ?? 0 },
		success: astMatches.length === 1 && astMatches[0]?.captures.ARG === "answer",
		notes: ["Treatment keeps Pantheon bundled ast-grep; pi-lsp is additive and does not replace structural_search."],
	});

	const hashDir = path.join(work, "hashline");
	mkdirSync(hashDir);
	writeFileSync(path.join(hashDir, "sample.ts"), "const answer = 41\n");
	const [line] = await computeHashlines(path.join(hashDir, "sample.ts"));
	writeFileSync(path.join(hashDir, "sample.ts"), "const answer = 42\n");
	const stale = await applyHashlineEdit({
		cwd: hashDir,
		path: "sample.ts",
		edits: [{ line: line.line, expectedHash: line.hash, newText: "const answer = 43" }],
	});
	cases.push({
		name: "Hashline stale edit correctness",
		category: "hashline",
		control: { bundledHashlineRefusedStaleEdit: !stale.applied, staleCount: stale.stale.length },
		treatment: { sameBundledTool: true, fileContent: readFileSync(path.join(hashDir, "sample.ts"), "utf8") },
		success: !stale.applied && readFileSync(path.join(hashDir, "sample.ts"), "utf8") === "const answer = 42\n",
		notes: ["Treatment keeps Pantheon bundled hashline; pi-lsp is additive and does not replace stale-safe edits."],
	});

	const repoDiagnosticsControl = await measured(() =>
		withEnv({ PANTHEON_EXPERIMENTAL_LSP: undefined, PANTHEON_EXPERIMENTAL_LSP_COMMAND: undefined }, () =>
			runDiagnostics(repoRoot, "src/extension/index.ts", 30_000),
		),
	);
	const repoDiagnosticsTreatment = await measured(() =>
		withEnv({ PANTHEON_EXPERIMENTAL_LSP: "1", PANTHEON_EXPERIMENTAL_LSP_COMMAND: undefined }, () =>
			runDiagnostics(repoRoot, "src/extension/index.ts", 30_000),
		),
	);
	realCodeMetrics.push({
		name: "Pantheon repo diagnostics before/after",
		dataset: "current Pantheon repo: src/extension/index.ts",
		operation: "runDiagnostics with command fallback; treatment additionally probes bundled pi-lsp package",
		before: repoDiagnosticsControl.value.metrics,
		after: repoDiagnosticsTreatment.value.metrics,
		elapsedMs: repoDiagnosticsControl.elapsedMs + repoDiagnosticsTreatment.elapsedMs,
		success: !repoDiagnosticsControl.value.skipped && !repoDiagnosticsTreatment.value.skipped,
		notes: [
			"Before disables experimental LSP probe. After enables it, verifies pi-lsp package resolution, then records command fallback because pi-lsp exposes Pi tools rather than a direct diagnostics API.",
		],
	});

	const repoStructural = await measured(() =>
		structuralSearch({ cwd: repoRoot, paths: ["src/extension"], pattern: "pi.registerTool($ARGS)" }),
	);
	realCodeMetrics.push({
		name: "Pantheon repo AST structural_search",
		dataset: "current Pantheon repo: src/extension",
		operation: "ast-grep pattern pi.registerTool($ARGS)",
		after: {
			matchCount: repoStructural.value.length,
			paths: [...new Set(repoStructural.value.map((match) => match.path))],
			firstMatch: repoStructural.value[0],
		},
		elapsedMs: repoStructural.elapsedMs,
		success: repoStructural.value.length >= 3,
	});

	const repoHashlines = await measured(() => computeHashlines(path.join(repoRoot, "src/extension/index.ts")));
	realCodeMetrics.push({
		name: "Pantheon repo hashline coverage",
		dataset: "current Pantheon repo: src/extension/index.ts",
		operation: "computeHashlines",
		after: {
			lineCount: repoHashlines.value.length,
			firstHash: repoHashlines.value[0]?.hash,
			lastHash: repoHashlines.value.at(-1)?.hash,
		},
		elapsedMs: repoHashlines.elapsedMs,
		success: repoHashlines.value.length > 0,
	});

	const e2eDir = path.join(work, "pi-e2e");
	mkdirSync(path.join(e2eDir, "src"), { recursive: true });
	writeFileSync(path.join(e2eDir, "sample.ts"), "const answer = 42\nconsole.log(answer)\n");
	writeFileSync(path.join(e2eDir, "app.ts"), "const text = 'console.log(nope)'\nconsole.log(answer)\n");
	writeFileSync(
		path.join(e2eDir, "Cargo.toml"),
		'[package]\nname = "ahe_pi_lsp"\nversion = "0.0.0"\nedition = "2021"\n',
	);
	writeFileSync(path.join(e2eDir, "src/lib.rs"), "pub fn answer() -> i32 { 42 }\n");

	const agentDir = path.join(work, "agent");
	mkdirSync(agentDir, { recursive: true });
	const rustAnalyzer = process.env.PANTHEON_AHE_RUST_ANALYZER ?? "rust-analyzer";
	writeFileSync(
		path.join(agentDir, "lsp.json"),
		`${JSON.stringify(
			{
				version: 1,
				servers: [
					{
						id: "rust-analyzer",
						enabled: true,
						include: ["**/*.rs"],
						rootMarkers: ["Cargo.toml"],
						bin: rustAnalyzer,
						args: [],
						cwd: "{root}",
						languageIdByExtension: { ".rs": "rust" },
						diagnosticsWaitMs: 1500,
					},
				],
			},
			null,
			2,
		)}\n`,
	);

	const basePiArgs = [
		"--no-session",
		"--no-context-files",
		"--no-skills",
		"--no-prompt-templates",
		"--no-extensions",
		"--extension",
		repoRoot,
		"--thinking",
		"off",
	];
	if (piModel) {
		basePiArgs.push("--model", piModel);
	}
	commandEvidence.push(
		await runCapturedCommand({
			name: "pi cli version preflight",
			command: piBinary,
			args: ["--version"],
			cwd: e2eDir,
			env: { PI_AGENT_DIR: agentDir },
			timeoutMs: 30_000,
			reportsDir: outputDir,
			expect: ({ exitCode }) => exitCode === 0,
		}),
	);
	commandEvidence.push(
		await runCapturedCommand({
			name: "pi cli help preflight",
			command: piBinary,
			args: ["--help"],
			cwd: e2eDir,
			env: { PI_AGENT_DIR: agentDir },
			timeoutMs: 30_000,
			reportsDir: outputDir,
			expect: ({ exitCode, stdout, stderr }) => exitCode === 0 && (stdout.length > 0 || stderr.length > 0),
		}),
	);
	commandEvidence.push(
		await runCapturedCommand({
			name: "pi hashline real e2e",
			command: piBinary,
			args: [
				...basePiArgs,
				"--tools",
				"hashline",
				"-p",
				"Use hashline list on sample.ts then answer exactly hashline-ok",
			],
			cwd: e2eDir,
			env: { PI_AGENT_DIR: agentDir },
			timeoutMs: 60_000,
			reportsDir: outputDir,
			expect: ({ exitCode, stdout }) => exitCode === 0 && stdout.includes("hashline-ok"),
		}),
	);
	commandEvidence.push(
		await runCapturedCommand({
			name: "pi structural_search real e2e",
			command: piBinary,
			args: [
				...basePiArgs,
				"--tools",
				"structural_search",
				"-p",
				"Use structural_search on app.ts for console.log($ARG) then answer exactly structural-ok ARG=answer",
			],
			cwd: e2eDir,
			env: { PI_AGENT_DIR: agentDir },
			timeoutMs: 60_000,
			reportsDir: outputDir,
			expect: ({ exitCode, stdout }) => exitCode === 0 && stdout.includes("structural-ok") && stdout.includes("answer"),
		}),
	);
	commandEvidence.push(
		await runCapturedCommand({
			name: "pi lsp_symbols bundled pi-lsp e2e",
			command: piBinary,
			args: [
				...basePiArgs,
				"--tools",
				"lsp_symbols,lsp_diagnostics",
				"-p",
				"Use lsp_symbols on src/lib.rs then use lsp_diagnostics on src/lib.rs then answer exactly lsp-ok",
			],
			cwd: e2eDir,
			env: { PI_AGENT_DIR: agentDir },
			timeoutMs: 90_000,
			reportsDir: outputDir,
			expect: ({ exitCode, stdout }) => exitCode === 0 && stdout.includes("lsp-ok"),
		}),
	);

	const diagnosticCases = cases.filter((item) => item.category === "diagnostics");
	const controlLatencies = diagnosticCases.map((item) => (item.control as { latencyMs: number }).latencyMs);
	const treatmentLatencies = diagnosticCases.map((item) => (item.treatment as { latencyMs: number }).latencyMs);
	const langWatch = await inspectLangWatch();
	const manifestExtensions =
		(JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { pi?: { extensions?: string[] } }).pi
			?.extensions ?? [];
	const summary = {
		totalCases: cases.length,
		passedCases: cases.filter((item) => item.success).length,
		successRate: cases.filter((item) => item.success).length / cases.length,
		controlMeanLatencyMs: Math.round(mean(controlLatencies)),
		treatmentMeanLatencyMs: Math.round(mean(treatmentLatencies)),
		diagnosticSources: {
			control: diagnosticCases.map((item) => (item.control as { source: string }).source),
			treatment: diagnosticCases.map((item) => (item.treatment as { source: string }).source),
		},
		piE2E: {
			passed: commandEvidence.filter((item) => item.status === "passed").length,
			total: commandEvidence.length,
			timeouts: commandEvidence.filter((item) => item.status === "timeout").length,
		},
		realCodeMetrics: {
			passed: realCodeMetrics.filter((item) => item.success).length,
			total: realCodeMetrics.length,
		},
	};
	const report = {
		experiment: "AHE pi-lsp bundled extension integration",
		generatedAt: new Date().toISOString(),
		repoRoot,
		temporaryWorkspace: work,
		packageIntegration: {
			piLsp,
			piModel: piModel ?? "default provider/model",
			pantheonManifestExtensions: manifestExtensions,
			bundledExtensionPathPresent: manifestExtensions.includes("./node_modules/pi-lsp/extensions/pi-lsp/index.ts"),
		},
		summary,
		cases,
		realCodeMetrics,
		realPiE2E: commandEvidence,
		langWatch,
		limitations: [
			"pi-lsp 0.1.7 is a Pi extension package and has no importable root/direct diagnostics API; Pantheon keeps command diagnostics fallback for built-in write/hashline/structural_search diagnostics.",
			"The bundled pi-lsp treatment is exercised through real Pi extension loading and LSP tools. Hot server reuse is scoped to a single Pi process and depends on model tool planning plus configured language-server availability.",
			"LangWatch read/query API schema was not assumed; the script verifies key presence and probes the OTLP traces endpoint without printing the secret.",
		],
	};

	const jsonPath = path.join(reportsDir, "ahe-pi-lsp-experiment.json");
	const mdPath = path.join(reportsDir, "ahe-pi-lsp-executive-report.md");
	writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
	writeFileSync(
		mdPath,
		[
			"# AHE Pi-LSP Experiment Executive Report",
			"",
			`Generated: ${report.generatedAt}`,
			"",
			"## Summary",
			"",
			`- Local cases passed: ${summary.passedCases}/${summary.totalCases} (${Math.round(summary.successRate * 100)}%)`,
			`- Real Pi E2E passed: ${summary.piE2E.passed}/${summary.piE2E.total}`,
			`- Real Pi E2E timeouts: ${summary.piE2E.timeouts}`,
			`- Real-code metrics passed: ${summary.realCodeMetrics.passed}/${summary.realCodeMetrics.total}`,
			`- Control mean diagnostics latency: ${summary.controlMeanLatencyMs} ms`,
			`- Treatment mean diagnostics latency: ${summary.treatmentMeanLatencyMs} ms`,
			`- Control diagnostic sources: ${summary.diagnosticSources.control.join(", ")}`,
			`- Treatment diagnostic sources: ${summary.diagnosticSources.treatment.join(", ")}`,
			"",
			"## Package Integration",
			"",
			`- Installed package: ${piLsp.installed ? `${piLsp.packageName}@${piLsp.version}` : "not installed"}`,
			`- pi-lsp extension path: ${piLsp.extensionPath ?? "not resolved"}`,
			`- Pantheon manifest includes bundled path: ${report.packageIntegration.bundledExtensionPathPresent}`,
			"- pi.dev/npm evidence: pi-lsp is the installable package; manifest declares `extensions/pi-lsp/index.ts`.",
			"",
			"## Cases",
			"",
			...cases.map((item) => `- ${item.name}: ${item.success ? "passed" : "failed"}`),
			"",
			"## Real-Code Metrics",
			"",
			...realCodeMetrics.map(
				(item) =>
					`- ${item.name}: ${item.success ? "passed" : "failed"}; dataset=${item.dataset}; elapsed=${item.elapsedMs} ms`,
			),
			"",
			"## Real Pi E2E",
			"",
			...commandEvidence.map(
				(item) =>
					`- ${item.name}: ${item.status}; exit=${item.exitCode}; duration=${item.durationMs} ms; artifact=${item.outputArtifact}`,
			),
			"",
			"## LangWatch",
			"",
			`- LANGWATCH_API_KEY present: ${langWatch.envPresent}`,
			`- Endpoint probed: ${langWatch.endpoint}`,
			`- Attempted: ${langWatch.attempted}`,
			`- Result: ${langWatch.status ?? langWatch.error ?? "not attempted"}`,
			"",
			"## Limitations",
			"",
			...report.limitations.map((item) => `- ${item}`),
			"",
			`Raw metrics: ${path.relative(repoRoot, jsonPath)}`,
			"",
		].join("\n"),
	);
	console.log(JSON.stringify({ jsonPath, mdPath, summary }, null, 2));
}

await main();
