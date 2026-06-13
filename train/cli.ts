#!/usr/bin/env bun
// `train` — the orchestrator CLI. Thin layer: parse argv, dispatch to a command
// handler in src/commands.ts, and turn thrown errors into a clean exit. All real
// logic lives in src/.

import { parseArgs } from "node:util";
import {
	cmdApprove,
	cmdBlock,
	cmdBootstrap,
	cmdHandoff,
	cmdInit,
	cmdNext,
	cmdProjects,
	cmdPrompt,
	cmdRun,
	cmdRunStage,
	cmdStart,
	cmdStatus,
	cmdUnblock,
	cmdUnlock,
	cmdUse,
} from "./src/commands.ts";

function usage(): string {
	return [
		"train — orchestrate Linear tickets through implement → review → address → human-gate → merge.",
		"",
		"Project selection: most commands take --project <slug> (defaults to the active project set via",
		"`train use`). --state <path> is a raw escape hatch that derives sibling artifacts from the state dir.",
		"",
		"Setup:",
		"  train bootstrap --queue <path> --base <feature/branch> [--repo <path>] [--project <slug>]",
		"  train init --queue <path> [--repo <path>] [--project <slug>]",
		"",
		"Run:",
		"  train start [--max-iterations <n>] [--dry-run] [--project <slug>]   # full autopilot loop",
		"  train run-stage --task <id> --stage <implement|review|address|merge> [--dry-run] [--project <slug>]",
		"  train run [--project <slug>]                                        # activate next queued task",
		"",
		"Inspect:",
		"  train projects                                                      # all streams, one-line status",
		"  train status [--project <slug>]",
		"  train next [--project <slug>]                                       # prompt for the active stage",
		"  train prompt --task <id> --stage <stage> [--project <slug>]",
		"",
		"Human gates & recovery:",
		"  train approve --task <id> [--project <slug>]                        # pass the awaiting_human gate",
		"  train unblock --task <id> --answer <text> --resume <status> [--project <slug>]",
		"  train block --task <id> --stage <stage> --question <text> [--by <name>] [--project <slug>]",
		"  train handoff --task <id> --stage <stage> --status <ok|blocked|failed> [--pr <url>] [--note <text>]",
		"  train unlock [--project <slug>]                                     # release a stale loop lock",
		"  train use <slug>                                                    # set the active project",
		"",
		"Env: TRAIN_HOME overrides where project state lives (default: train/.data).",
	].join("\n");
}

const handlers: Record<string, (flags: Record<string, unknown>) => Promise<void>> = {
	projects: cmdProjects,
	use: cmdUse,
	init: cmdInit,
	bootstrap: cmdBootstrap,
	run: cmdRun,
	status: cmdStatus,
	prompt: cmdPrompt,
	next: cmdNext,
	"run-stage": cmdRunStage,
	start: cmdStart,
	approve: cmdApprove,
	handoff: cmdHandoff,
	block: cmdBlock,
	unblock: cmdUnblock,
	unlock: cmdUnlock,
};

async function main(argv: string[]): Promise<void> {
	const [command, ...rest] = argv;
	if (!command || command === "help" || command === "--help" || command === "-h") {
		console.log(usage());
		return;
	}

	const { values, positionals } = parseArgs({
		args: rest,
		allowPositionals: true,
		options: {
			queue: { type: "string" },
			base: { type: "string" },
			repo: { type: "string" },
			state: { type: "string" },
			project: { type: "string" },
			task: { type: "string" },
			stage: { type: "string" },
			status: { type: "string" },
			pr: { type: "string" },
			note: { type: "string" },
			question: { type: "string" },
			answer: { type: "string" },
			resume: { type: "string" },
			by: { type: "string" },
			"max-iterations": { type: "string" },
			"dry-run": { type: "boolean" },
		},
	});

	const handler = handlers[command];
	if (!handler) {
		console.error(`Unknown command: ${command}\n`);
		console.log(usage());
		process.exit(1);
	}

	await handler({ ...values, _: positionals });
}

main(process.argv.slice(2)).catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
