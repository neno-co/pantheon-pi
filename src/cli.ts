#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { formatPantheonAgentList, isPantheonAgent, type PantheonAgent } from "./agents.ts";
import { checkInstallPrerequisites, type InstallCheckOptions, type InstallCheckReport } from "./install-check/index.ts";
import { runTelemetryCli } from "./telemetry/cli/index.ts";

export type PantheonCliCommand =
	| { command: "help" }
	| { command: "telemetry"; args: string[] }
	| { command: "init"; args: string[] }
	| { command: "launch"; agent: PantheonAgent; forwardedArgs: string[] };

export interface PantheonPiInvocation {
	command: string;
	args: string[];
}

export interface BuildPantheonPiInvocationOptions {
	rootDir?: string;
	piBin?: string;
}

export interface RunPantheonInitOptions extends InstallCheckOptions {}

export interface RunPantheonInitResult {
	install: InstallCheckReport;
}

const promptFlagNames = new Set([
	"--system-prompt",
	"--append-system-prompt",
	"--systemPrompt",
	"--appendSystemPrompt",
]);

export function pantheonUsage() {
	return [
		"Usage:",
		"  pantheon [--agent <agent>] [...pi args]",
		"  pantheon --agent <agent> -- <raw pi args>",
		"  pantheon init",
		"  pantheon telemetry <command> [...flags]",
		"",
		"Commands:",
		"  init                 Check packaged Pantheon assets",
		"  telemetry            Query the local Pantheon telemetry index",
		"  help, --help, -h     Show this Pantheon help",
		"",
		"Launch options:",
		"  --agent <agent>      Select the Pantheon agent prompt to append before launching Pi",
		`Agents: ${formatPantheonAgentList()}`,
		"",
		"Pi passthrough:",
		"  Normal Pi flags are forwarded after Pantheon parses --agent.",
		"  Pantheon owns prompt override flags (--system-prompt/--append-system-prompt).",
		"  Use `pi --help` for raw Pi help, or `pantheon -- --help` to forward help explicitly.",
	].join("\n");
}

export function validateForwardedPiArgs(args: string[]) {
	for (const arg of args) {
		const [name] = arg.split("=", 1);
		if (promptFlagNames.has(name)) {
			throw new Error(
				"Pantheon owns Pi system prompt flags (--system-prompt/--append-system-prompt). Use plain pi for custom prompts.",
			);
		}
	}
}

export function parsePantheonCli(args: string[]): PantheonCliCommand {
	const [group, ...rest] = args;
	if (group === "help" || group === "--help" || group === "-h") return { command: "help" };
	if (group === "telemetry") return { command: "telemetry", args: rest };
	if (group === "init") return { command: "init", args: rest };

	let agent: PantheonAgent = "athena";
	const forwardedArgs: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--") {
			forwardedArgs.push(...args.slice(index + 1));
			break;
		}
		if (arg === "--help" || arg === "-h") return { command: "help" };
		if (arg === "--agent") {
			const value = args[index + 1];
			if (!value) throw new Error("Missing value for --agent");
			if (!isPantheonAgent(value))
				throw new Error(`Unsupported Pantheon agent: ${value}. Supported agents: ${formatPantheonAgentList()}`);
			agent = value;
			index += 1;
			continue;
		}
		if (arg.startsWith("--agent=")) {
			const value = arg.slice("--agent=".length);
			if (!isPantheonAgent(value))
				throw new Error(`Unsupported Pantheon agent: ${value}. Supported agents: ${formatPantheonAgentList()}`);
			agent = value;
			continue;
		}
		forwardedArgs.push(arg);
	}

	validateForwardedPiArgs(forwardedArgs);
	return { command: "launch", agent, forwardedArgs };
}

export function buildPantheonPiInvocation(
	parsed: Extract<PantheonCliCommand, { command: "launch" }>,
	options: BuildPantheonPiInvocationOptions = {},
): PantheonPiInvocation {
	const rootDir = path.resolve(options.rootDir ?? path.join(import.meta.dirname, ".."));
	const promptPath = path.join(rootDir, "agents", "prompts", `${parsed.agent}.md`);
	if (!existsSync(promptPath)) throw new Error(`Pantheon agent prompt not found: ${promptPath}`);
	return {
		command: options.piBin ?? process.env.PANTHEON_PI_BIN ?? "pi",
		args: ["--append-system-prompt", promptPath, ...parsed.forwardedArgs],
	};
}

export function runPantheonInit(options: RunPantheonInitOptions = {}): RunPantheonInitResult {
	const rootDir = options.rootDir ?? path.join(import.meta.dirname, "..");
	const install = checkInstallPrerequisites({ ...options, rootDir });
	return { install };
}

async function main(args: string[]) {
	try {
		const parsed = parsePantheonCli(args);
		if (parsed.command === "help") {
			console.log(pantheonUsage());
			return;
		}
		if (parsed.command === "telemetry") {
			await runTelemetryCli(parsed.args);
			return;
		}
		if (parsed.command === "init") {
			const result = runPantheonInit();
			console.log(result.install.ok ? "Pantheon assets check passed." : "Pantheon assets check failed.");
			for (const failure of result.install.failures) console.error(`failure: ${failure}`);
			for (const warning of result.install.warnings) console.warn(`warning: ${warning}`);
			process.exit(result.install.ok ? 0 : 1);
		}

		const invocation = buildPantheonPiInvocation(parsed);
		const child = spawnSync(invocation.command, invocation.args, {
			stdio: "inherit",
			env: { ...process.env, PANTHEON_MAIN_AGENT: parsed.agent },
		});
		if (child.error) throw child.error;
		if (child.signal) process.kill(process.pid, child.signal);
		process.exit(child.status ?? 1);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		console.error(pantheonUsage());
		process.exit(1);
	}
}

if (import.meta.main) await main(process.argv.slice(2));
