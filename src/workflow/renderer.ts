import { truncatePlainToWidth } from "./text.ts";
import type { PantheonRunSnapshot, PantheonWorkflowSnapshot, PantheonWorkflowStatus } from "./types.ts";

const frames = ["⠁", "⠂", "⠄", "⠂"];
const EXPLORER_HINT = "Open detailed Agent Explorer: /acpx-monitor";
const statusRank: Record<PantheonWorkflowStatus, number> = {
	running: 0,
	queued: 1,
	needs_attention: 2,
	failed: 3,
	timeout: 4,
	cancelled: 5,
	completed: 6,
};

export interface RenderPantheonWorkflowsOptions {
	width: number;
	expanded?: boolean;
	now?: number;
	maxLines?: number;
	maxDepth?: number;
}

function duration(ms: number) {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function glyph(run: PantheonRunSnapshot) {
	if (run.status === "completed") return "✓";
	if (run.status === "failed") return "✗";
	if (run.status === "timeout") return "⧖";
	if (run.status === "cancelled") return "—";
	if (run.status === "queued") return "○";
	if (run.status === "needs_attention") return "!";
	return frames[(run.activitySeed ?? 0) % frames.length] ?? "●";
}

function terminal(run: PantheonRunSnapshot) {
	return ["completed", "failed", "timeout", "cancelled"].includes(run.status);
}

function line(value: string, width: number) {
	return truncatePlainToWidth(value, Math.max(1, width), "…");
}

function runStats(run: PantheonRunSnapshot, now: number) {
	const parts = [duration((run.completedAt ?? now) - run.startedAt)];
	if (run.turnCount !== undefined) parts.push(`${run.turnCount} turns`);
	if (run.toolCount !== undefined) parts.push(`${run.toolCount} tools`);
	if (run.tokenCount !== undefined) parts.push(`${run.tokenCount} tok`);
	return parts.join(" · ");
}

function artifactSummary(run: PantheonRunSnapshot) {
	const parts = [];
	if (run.artifacts?.outputPath) parts.push(`artifact: ${run.artifacts.outputPath}`);
	if (run.traceId) parts.push(`trace: ${run.traceId}`);
	if (run.acpxSessionName) parts.push(`session: ${run.acpxSessionName}`);
	return parts.join(" · ");
}

function activityText(run: PantheonRunSnapshot) {
	if (run.currentActivity) return run.currentActivity;
	if (run.status === "completed") return "completed";
	if (run.status === "failed") return run.stderrPreview?.at(-1) ?? "failed";
	if (run.status === "timeout") return run.stderrPreview?.at(-1) ?? "timed out";
	return "waiting for activity…";
}

function renderRun(run: PantheonRunSnapshot, options: Required<RenderPantheonWorkflowsOptions>, depth: number) {
	const indent = "  ".repeat(depth);
	const prefix = depth > 0 ? "└─ " : "";
	const name = run.label ? `${run.agent}/${run.label}` : run.agent;
	const stale = run.status === "running" && options.now - run.updatedAt > 10_000 ? " stalled" : "";
	const lines = [
		line(
			`${indent}${prefix}${glyph(run)} ${name} · ${run.status}${stale} · ${runStats(run, options.now)} — ${activityText(run)}`,
			options.width,
		),
	];

	if (options.expanded) {
		if (run.currentTool)
			lines.push(
				line(
					`${indent}   ↳ tool: ${run.currentTool}${run.currentToolArgs ? ` ${run.currentToolArgs}` : ""}`,
					options.width,
				),
			);
		lines.push(line(`${indent}   ↳ cwd: ${run.cwd}`, options.width));
		const refs = artifactSummary(run);
		if (refs) lines.push(line(`${indent}   ↳ ${refs}`, options.width));
		const previews = run.status === "failed" || run.status === "timeout" ? run.stderrPreview : run.stdoutPreview;
		for (const preview of (previews ?? []).slice(-2)) lines.push(line(`${indent}     ${preview}`, options.width));
	}

	const children = run.children ?? [];
	if (children.length > 0 && depth < options.maxDepth) {
		const visibleChildren = children.slice(0, 3);
		for (const child of visibleChildren) lines.push(...renderRun(child, options, depth + 1));
		const hidden = children.length - visibleChildren.length;
		if (hidden > 0) lines.push(line(`${indent}  +${hidden} nested agents hidden`, options.width));
	} else if (children.length > 0) {
		const running = children.filter((child) => !terminal(child)).length;
		const completed = children.filter((child) => child.status === "completed").length;
		lines.push(
			line(`${indent}  +${children.length} nested agents (${running} running, ${completed} completed)`, options.width),
		);
	}
	return lines;
}

function topLevelRuns(workflows: PantheonWorkflowSnapshot[]) {
	return workflows
		.flatMap((workflow) => workflow.runs)
		.sort((left, right) => statusRank[left.status] - statusRank[right.status] || left.startedAt - right.startedAt);
}

function flattenRunTree(runs: PantheonRunSnapshot[]): PantheonRunSnapshot[] {
	return runs.flatMap((run) => [run, ...flattenRunTree(run.children ?? [])]);
}

function hasNonTerminalDescendant(run: PantheonRunSnapshot) {
	return flattenRunTree(run.children ?? []).some((child) => !terminal(child));
}

export function renderPantheonWorkflows(
	workflows: PantheonWorkflowSnapshot[],
	options: RenderPantheonWorkflowsOptions,
): string[] {
	const normalized: Required<RenderPantheonWorkflowsOptions> = {
		width: options.width,
		expanded: options.expanded ?? false,
		now: options.now ?? Date.now(),
		maxLines: options.maxLines ?? (options.expanded ? 18 : 8),
		maxDepth: options.maxDepth ?? 2,
	};
	const runs = topLevelRuns(workflows);
	const allRuns = flattenRunTree(runs);
	if (runs.length === 0) return [];

	const active = allRuns.filter((run) => !terminal(run)).length;
	if (active === 0) return [];
	const failed = allRuns.filter((run) => run.status === "failed" || run.status === "timeout").length;
	const completed = allRuns.filter((run) => run.status === "completed").length;
	const lines = [
		line(
			`Pantheon ACPX subagents · ${active} active · ${completed} done · ${failed} issue${failed === 1 ? "" : "s"}`,
			normalized.width,
		),
		line(EXPLORER_HINT, normalized.width),
	];

	let hiddenCompleted = 0;
	for (let index = 0; index < runs.length; index += 1) {
		const run = runs[index];
		if (!run) continue;
		if (!normalized.expanded && run.status === "completed" && completed > 5 && !hasNonTerminalDescendant(run)) {
			hiddenCompleted += 1;
			continue;
		}
		const next = renderRun(run, normalized, 0);
		if (lines.length + next.length > normalized.maxLines) {
			lines.push(line(`+${runs.length - index} runs hidden by line budget`, normalized.width));
			break;
		}
		lines.push(...next);
	}
	if (hiddenCompleted > 0 && lines.length < normalized.maxLines)
		lines.push(line(`+${hiddenCompleted} completed agents hidden`, normalized.width));
	return lines.slice(0, normalized.maxLines).map((rendered) => line(rendered, normalized.width));
}
