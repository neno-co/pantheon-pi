import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export type DiagnosticsSource = "lsp" | "command" | "skipped" | "error";

export type DiagnosticSeverity = "error" | "warning" | "information" | "hint" | "unknown";

export type DiagnosticSummary = {
	total: number;
	bySeverity: Record<DiagnosticSeverity, number>;
};

export type DiagnosticsMetrics = {
	source: DiagnosticsSource;
	latencyMs: number;
	path?: string;
	language?: string;
	diagnosticCount: number;
	severities: Record<DiagnosticSeverity, number>;
	fallbackReason?: string;
};

export type DiagnosticsResult =
	| {
			skipped: false;
			source: "lsp" | "command" | "error";
			command?: string;
			exitCode: number;
			stdout: string;
			stderr: string;
			diagnostics?: unknown[];
			metrics: DiagnosticsMetrics;
	  }
	| {
			skipped: true;
			source: "skipped";
			reason: string;
			metrics: DiagnosticsMetrics;
	  };

const LANGUAGE_BY_EXTENSION = new Map<string, string>([
	[".ts", "typescript"],
	[".tsx", "typescriptreact"],
	[".js", "javascript"],
	[".jsx", "javascriptreact"],
	[".mts", "typescript"],
	[".cts", "typescript"],
	[".rs", "rust"],
	[".ex", "elixir"],
	[".exs", "elixir"],
]);

const DIAGNOSTIC_SEVERITIES: DiagnosticSeverity[] = ["error", "warning", "information", "hint", "unknown"];
const require = createRequire(import.meta.url);

function selectDiagnosticsCommand(cwd: string, targetPath?: string) {
	if (existsSync(path.join(cwd, "Cargo.toml"))) return ["cargo", "check"];
	if (existsSync(path.join(cwd, "mix.exs"))) return ["mix", "compile", "--warnings-as-errors"];
	if (existsSync(path.join(cwd, "deno.json")) || existsSync(path.join(cwd, "deno.jsonc"))) {
		return ["deno", "check", targetPath ?? "."];
	}
	if (existsSync(path.join(cwd, "tsconfig.json"))) return ["bunx", "tsc", "--noEmit"];
	if (targetPath && /\.[cm]?[tj]sx?$/.test(targetPath)) return ["bun", "--check", targetPath];
	return undefined;
}

function emptySeverityCounts(): Record<DiagnosticSeverity, number> {
	return { error: 0, warning: 0, information: 0, hint: 0, unknown: 0 };
}

function languageForPath(targetPath?: string) {
	return targetPath ? LANGUAGE_BY_EXTENSION.get(path.extname(targetPath)) : undefined;
}

function normalizeSeverity(value: unknown): DiagnosticSeverity {
	if (typeof value === "number") {
		if (value === 1) return "error";
		if (value === 2) return "warning";
		if (value === 3) return "information";
		if (value === 4) return "hint";
	}
	if (typeof value === "string") {
		const lower = value.toLowerCase();
		if (lower === "error" || lower === "warning" || lower === "information" || lower === "hint") return lower;
		if (lower === "info") return "information";
	}
	return "unknown";
}

function summarizeDiagnostics(diagnostics: unknown[] | undefined): DiagnosticSummary {
	const bySeverity = emptySeverityCounts();
	if (!diagnostics) return { total: 0, bySeverity };
	for (const diagnostic of diagnostics) {
		const severity =
			typeof diagnostic === "object" && diagnostic !== null
				? normalizeSeverity((diagnostic as Record<string, unknown>).severity)
				: "unknown";
		bySeverity[severity] += 1;
	}
	return { total: diagnostics.length, bySeverity };
}

function countCommandDiagnostics(stdout: string, stderr: string): DiagnosticSummary {
	const text = `${stdout}\n${stderr}`;
	const bySeverity = emptySeverityCounts();
	bySeverity.error = (text.match(/\berror(?:\s+[A-Z]+\d+|\[[^\]]+\])?:/gi) ?? []).length;
	bySeverity.warning = (text.match(/\bwarning(?:\s+[A-Z]+\d+|\[[^\]]+\])?:/gi) ?? []).length;
	const total = DIAGNOSTIC_SEVERITIES.reduce((sum, severity) => sum + bySeverity[severity], 0);
	return { total, bySeverity };
}

function isExperimentalLspEnabled(env: NodeJS.ProcessEnv = process.env) {
	return env.PANTHEON_EXPERIMENTAL_LSP === "1" || env.PANTHEON_EXPERIMENTAL_LSP === "true";
}

async function probePiLspPackage() {
	for (const packageName of ["pi-lsp", "@earendil-works/pi-lsp", "@earendil-works/pi-language-server"]) {
		try {
			const packageJsonPath = require.resolve(`${packageName}/package.json`);
			const extensionPath = packageName === "pi-lsp" ? require.resolve("pi-lsp/extensions/pi-lsp/index.ts") : undefined;
			return { available: true, packageName, packageJsonPath, extensionPath };
		} catch {
			// Keep probing known package names.
		}
	}
	return { available: false, reason: "pi-lsp package not importable" };
}

async function runExperimentalLspDiagnostics(cwd: string, targetPath: string | undefined, timeoutMs: number) {
	if (!targetPath) return { skipped: true, reason: "No target path for LSP diagnostics" } as const;
	const command = process.env.PANTHEON_EXPERIMENTAL_LSP_COMMAND;
	const probe = await probePiLspPackage();
	if (!command) {
		return {
			skipped: true,
			reason: probe.available
				? `Resolved ${probe.packageName} at ${probe.packageJsonPath}, but no supported direct diagnostics API is exposed; use bundled Pi extension tools or set PANTHEON_EXPERIMENTAL_LSP_COMMAND`
				: `${probe.reason}; set PANTHEON_EXPERIMENTAL_LSP_COMMAND to exercise an adapter`,
		} as const;
	}
	const result = await runCommand([command, targetPath], cwd, timeoutMs);
	if (result.exitCode !== 0) {
		return {
			skipped: true,
			reason: `LSP adapter exited ${result.exitCode}: ${result.stderr || result.stdout}`.slice(0, 500),
		} as const;
	}
	try {
		const parsed = JSON.parse(result.stdout || "[]");
		const diagnostics = Array.isArray(parsed) ? parsed : Array.isArray(parsed.diagnostics) ? parsed.diagnostics : [];
		return {
			skipped: false,
			command,
			stdout: result.stdout,
			stderr: result.stderr,
			exitCode: result.exitCode,
			diagnostics,
		} as const;
	} catch (error) {
		return { skipped: true, reason: `LSP adapter returned invalid JSON: ${String(error)}` } as const;
	}
}

async function runCommand(command: string[], cwd: string, timeoutMs: number) {
	return await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
		let timedOut = false;
		let stdout = "";
		let stderr = "";
		const proc = spawn(command[0] ?? "", command.slice(1), { cwd, env: process.env });
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill();
		}, timeoutMs);
		proc.stdout?.setEncoding("utf8");
		proc.stderr?.setEncoding("utf8");
		proc.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		proc.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		proc.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		proc.on("close", (code) => {
			clearTimeout(timer);
			resolve({ stdout, stderr, exitCode: timedOut ? 124 : (code ?? 1) });
		});
	});
}

export function formatDiagnostics(diagnostics: DiagnosticsResult) {
	if (diagnostics.skipped) return `Diagnostics skipped: ${diagnostics.reason}`;
	const output = [diagnostics.stdout, diagnostics.stderr].filter(Boolean).join("\n").trim();
	return [`Diagnostics: ${diagnostics.command} exited ${diagnostics.exitCode}`, output].filter(Boolean).join("\n");
}

export async function runDiagnostics(cwd: string, targetPath?: string, timeoutMs = 20_000): Promise<DiagnosticsResult> {
	const startedAt = Date.now();
	const language = languageForPath(targetPath);
	if (isExperimentalLspEnabled()) {
		try {
			const lsp = await runExperimentalLspDiagnostics(cwd, targetPath, Math.min(timeoutMs, 5_000));
			if (!lsp.skipped) {
				const summary = summarizeDiagnostics(lsp.diagnostics);
				return {
					skipped: false,
					source: "lsp",
					command: lsp.command,
					exitCode: lsp.exitCode,
					stdout: lsp.stdout.slice(-8_000),
					stderr: lsp.stderr.slice(-8_000),
					diagnostics: lsp.diagnostics,
					metrics: {
						source: "lsp",
						latencyMs: Date.now() - startedAt,
						path: targetPath,
						language,
						diagnosticCount: summary.total,
						severities: summary.bySeverity,
					},
				};
			}
			return await runCommandDiagnostics(cwd, targetPath, timeoutMs, startedAt, lsp.reason);
		} catch (error) {
			return await runCommandDiagnostics(cwd, targetPath, timeoutMs, startedAt, `LSP error: ${String(error)}`);
		}
	}
	return await runCommandDiagnostics(cwd, targetPath, timeoutMs, startedAt);
}

async function runCommandDiagnostics(
	cwd: string,
	targetPath: string | undefined,
	timeoutMs: number,
	startedAt: number,
	fallbackReason?: string,
): Promise<DiagnosticsResult> {
	const command = selectDiagnosticsCommand(cwd, targetPath);
	const language = languageForPath(targetPath);
	if (!command) {
		return {
			skipped: true,
			source: "skipped",
			reason: "No supported diagnostics strategy found",
			metrics: {
				source: "skipped",
				latencyMs: Date.now() - startedAt,
				path: targetPath,
				language,
				diagnosticCount: 0,
				severities: emptySeverityCounts(),
				fallbackReason,
			},
		};
	}

	try {
		const result = await runCommand(command, cwd, timeoutMs);
		const summary = countCommandDiagnostics(result.stdout, result.stderr);
		return {
			skipped: false,
			source: "command",
			command: command.join(" "),
			exitCode: result.exitCode,
			stdout: result.stdout.toString().slice(-8_000),
			stderr: result.stderr.toString().slice(-8_000),
			metrics: {
				source: "command",
				latencyMs: Date.now() - startedAt,
				path: targetPath,
				language,
				diagnosticCount: summary.total,
				severities: summary.bySeverity,
				fallbackReason,
			},
		};
	} catch (error) {
		return {
			skipped: false,
			source: "error",
			command: command.join(" "),
			exitCode: 127,
			stderr: String(error),
			stdout: "",
			metrics: {
				source: "error",
				latencyMs: Date.now() - startedAt,
				path: targetPath,
				language,
				diagnosticCount: 0,
				severities: emptySeverityCounts(),
				fallbackReason,
			},
		};
	}
}
