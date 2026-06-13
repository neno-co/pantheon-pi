import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { type Component, Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { parseAcpxSessionEnvelope } from "./session.ts";
import { truncatePlainToWidth } from "./text.ts";
import type { PantheonRunSnapshot, PantheonWorkflowSnapshot } from "./types.ts";

const MAX_DETAIL_BYTES = 256 * 1024;
const MIN_EXPLORER_WIDTH = 44;
const OVERLAY_WIDTH_GUTTER = 6;
const MIN_CONTENT_VIEWPORT_LINES = 18;
const MAX_CONTENT_VIEWPORT_LINES = 48;
const ROOT_VISIBLE_COMPLETED_LIMIT = 3;

export type WorkflowSnapshotSource = () => PantheonWorkflowSnapshot[];

export interface AgentExplorerOptions {
	onClose?: () => void;
	requestRender?: () => void;
	now?: () => number;
	viewportLines?: number;
}

type Route =
	| { kind: "root" }
	| { kind: "run"; runId: string }
	| { kind: "artifact"; runId: string; artifact: "output" | "stderr" | "metadata" | "prompt" }
	| { kind: "session"; runId: string };

interface RunItem {
	run: PantheonRunSnapshot;
	depth: number;
}

type RootRow = RunItem | { collapsed: true; count: number };

function terminal(run: PantheonRunSnapshot) {
	return ["completed", "failed", "timeout", "cancelled"].includes(run.status);
}

function glyph(run: PantheonRunSnapshot) {
	if (run.status === "completed") return "✓";
	if (run.status === "failed") return "✗";
	if (run.status === "timeout") return "⧖";
	if (run.status === "cancelled") return "—";
	if (run.status === "queued") return "○";
	if (run.status === "needs_attention") return "!";
	return "●";
}

function duration(ms: number) {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function flattenRuns(workflows: PantheonWorkflowSnapshot[]) {
	const items: RunItem[] = [];
	const push = (run: PantheonRunSnapshot, depth: number) => {
		items.push({ run, depth });
		for (const child of run.children ?? []) push(child, depth + 1);
	};
	for (const workflow of workflows) for (const run of workflow.runs) push(run, 0);
	return items;
}

function rootRows(items: RunItem[], showCompletedArchive = false) {
	const completed = items.filter((item) => item.run.status === "completed");
	if (showCompletedArchive || completed.length <= ROOT_VISIBLE_COMPLETED_LIMIT) return items as RootRow[];
	let shownCompleted = 0;
	const rows: RootRow[] = [];
	for (const item of items) {
		if (item.run.status !== "completed") {
			rows.push(item);
			continue;
		}
		if (shownCompleted < ROOT_VISIBLE_COMPLETED_LIMIT) {
			rows.push(item);
			shownCompleted += 1;
		}
	}
	const hidden = completed.length - shownCompleted;
	if (hidden > 0) rows.push({ collapsed: true, count: hidden });
	return rows;
}

function findRun(workflows: PantheonWorkflowSnapshot[], runId: string): PantheonRunSnapshot | undefined {
	const stack = workflows.flatMap((workflow) => workflow.runs);
	while (stack.length > 0) {
		const run = stack.shift();
		if (!run) continue;
		if (run.id === runId) return run;
		stack.push(...(run.children ?? []));
	}
	return undefined;
}

function readBounded(filePath: string | undefined) {
	if (!filePath) return "(missing path)";
	try {
		if (!existsSync(filePath)) return `(file does not exist) ${filePath}`;
		const stats = statSync(filePath);
		const bytesToRead = Math.min(stats.size, MAX_DETAIL_BYTES);
		const offset = Math.max(0, stats.size - bytesToRead);
		const buffer = Buffer.alloc(bytesToRead);
		const fd = openSync(filePath, "r");
		try {
			readSync(fd, buffer, 0, bytesToRead, offset);
		} finally {
			closeSync(fd);
		}
		const text = buffer.toString("utf8") || "(empty)";
		if (stats.size <= MAX_DETAIL_BYTES) return text;
		return `… truncated to last ${MAX_DETAIL_BYTES} bytes from ${stats.size} bytes\n${text}`;
	} catch (error) {
		return `(failed to read) ${filePath}: ${error instanceof Error ? error.message : String(error)}`;
	}
}

function artifactPath(run: PantheonRunSnapshot, artifact: "output" | "stderr" | "metadata" | "prompt") {
	if (artifact === "output") return run.artifacts?.outputPath;
	if (artifact === "stderr") return run.artifacts?.stderrPath;
	if (artifact === "metadata") return run.artifacts?.metadataPath;
	return run.artifacts?.promptPath;
}

function plainPadEnd(value: string, width: number) {
	const missing = width - visibleWidth(value);
	return missing > 0 ? `${value}${" ".repeat(missing)}` : value;
}

function plainPadStart(value: string, width: number) {
	const missing = width - visibleWidth(value);
	return missing > 0 ? `${" ".repeat(missing)}${value}` : value;
}

function fit(value: string, width: number) {
	return plainPadEnd(truncatePlainToWidth(value, Math.max(1, width), "…"), width);
}

function field(value: string, width: number, align: "left" | "right" = "left") {
	const clipped = truncatePlainToWidth(value, Math.max(1, width), "…");
	return align === "right" ? plainPadStart(clipped, width) : plainPadEnd(clipped, width);
}

function center(value: string, width: number) {
	const clipped = truncatePlainToWidth(value, Math.max(1, width), "…");
	const remaining = Math.max(0, width - visibleWidth(clipped));
	const left = Math.floor(remaining / 2);
	return `${" ".repeat(left)}${clipped}${" ".repeat(remaining - left)}`;
}

function wrapLines(text: string, width: number, maxLines: number) {
	const lines = text.replace(/\r/g, "").split("\n");
	return lines.slice(-maxLines).map((line) => fit(line, width));
}

function labelValue(label: string, value: string | undefined, width: number) {
	return `${field(label, Math.min(12, Math.max(7, Math.floor(width * 0.18))))} ${fit(value ?? "(none)", Math.max(1, width - Math.min(12, Math.max(7, Math.floor(width * 0.18))) - 1))}`;
}

export class PantheonAgentExplorer implements Component {
	private routeStack: Route[] = [{ kind: "root" }];
	private selected = 0;
	private scroll = 0;
	private showCompletedArchive = false;
	private readonly source: WorkflowSnapshotSource;
	private readonly options: AgentExplorerOptions;

	constructor(source: WorkflowSnapshotSource, options: AgentExplorerOptions = {}) {
		this.source = source;
		this.options = options;
	}

	handleInput(data: string): void {
		const key = (value: string) => matchesKey(data, value);
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.left) || key("h")) {
			this.back();
			return;
		}
		if (key("q")) {
			this.options.onClose?.();
			return;
		}
		if (key("ctrl+u")) {
			this.page(-1);
			this.options.requestRender?.();
			return;
		}
		if (key("ctrl+d")) {
			this.page(1);
			this.options.requestRender?.();
			return;
		}
		if (matchesKey(data, Key.up) || key("k")) {
			if (this.current().kind === "root") this.selected = Math.max(0, this.selected - 1);
			else this.scroll = Math.max(0, this.scroll - 1);
			this.options.requestRender?.();
			return;
		}
		if (matchesKey(data, Key.down) || key("j")) {
			if (this.current().kind === "root") {
				const rows = rootRows(flattenRuns(this.source()), this.showCompletedArchive);
				this.selected = Math.min(Math.max(0, rows.length - 1), this.selected + 1);
			} else this.scroll += 1;
			this.options.requestRender?.();
			return;
		}
		for (const shortcut of ["o", "e", "m", "p", "s"]) {
			if (key(shortcut)) {
				this.openShortcut(shortcut);
				return;
			}
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.right) || key("l")) {
			this.enter();
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(MIN_EXPLORER_WIDTH, width - OVERLAY_WIDTH_GUTTER);
		const innerWidth = safeWidth - 4;
		const route = this.current();
		const content =
			route.kind === "root"
				? this.renderRoot(innerWidth)
				: route.kind === "run"
					? this.renderRun(route.runId, innerWidth)
					: route.kind === "artifact"
						? this.renderArtifact(route.runId, route.artifact, innerWidth)
						: this.renderSession(route.runId, innerWidth);
		return this.frame(safeWidth, content);
	}

	invalidate(): void {}

	private current() {
		return this.routeStack.at(-1) ?? { kind: "root" as const };
	}

	private frame(width: number, content: string[]) {
		const innerWidth = width - 4;
		const title = " Pantheon Agent Explorer ";
		const top = `╭─${title}${"─".repeat(Math.max(0, width - visibleWidth(title) - 3))}╮`;
		const separator = `├${"─".repeat(width - 2)}┤`;
		const bottom = `╰${"─".repeat(width - 2)}╯`;
		const lines = [top, this.boxLine(this.header(innerWidth), innerWidth), separator];
		const viewportLines = this.viewportLines();
		const body = content.length > 0 ? content : this.emptyState(innerWidth);
		const maxScroll = Math.max(0, body.length - viewportLines);
		this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
		const visibleBody = body.slice(this.scroll, this.scroll + viewportLines);
		while (visibleBody.length < viewportLines) visibleBody.push("");
		lines.push(this.boxLine("", innerWidth));
		for (const raw of visibleBody) lines.push(this.boxLine(raw, innerWidth));
		lines.push(this.boxLine("", innerWidth), separator, this.boxLine(this.footer(), innerWidth), bottom);
		return lines.map((line) => truncatePlainToWidth(line, width, "…"));
	}

	private boxLine(value: string, innerWidth: number) {
		return `│ ${fit(value, innerWidth)} │`;
	}

	private viewportLines() {
		if (typeof this.options.viewportLines === "number") return Math.max(4, Math.floor(this.options.viewportLines));
		const rows = process.stdout?.rows;
		if (!rows || rows < 32) return MIN_CONTENT_VIEWPORT_LINES;
		return Math.max(MIN_CONTENT_VIEWPORT_LINES, Math.min(MAX_CONTENT_VIEWPORT_LINES, Math.floor(rows * 0.7), rows - 8));
	}

	private emptyState(width: number) {
		return [
			"",
			center("No Pantheon ACPX runs yet", width),
			center("Run a Pantheon/acpx agent to populate this view", width),
			"",
		];
	}

	private back() {
		if (this.routeStack.length <= 1) this.options.onClose?.();
		else {
			this.routeStack.pop();
			this.scroll = 0;
			this.options.requestRender?.();
		}
	}

	private selectedRun() {
		const route = this.current();
		if (route.kind !== "root") return "runId" in route ? findRun(this.source(), route.runId) : undefined;
		const row = rootRows(flattenRuns(this.source()), this.showCompletedArchive)[this.selected];
		return row && !("collapsed" in row) ? row.run : undefined;
	}

	private canOpenSession(run: PantheonRunSnapshot | undefined) {
		return Boolean(run?.acpxSessionFile);
	}

	private page(direction: -1 | 1) {
		const delta = Math.max(1, Math.floor(this.viewportLines() / 2));
		if (this.current().kind === "root") {
			const rows = rootRows(flattenRuns(this.source()), this.showCompletedArchive);
			this.selected = Math.max(0, Math.min(Math.max(0, rows.length - 1), this.selected + direction * delta));
			this.keepRootSelectionVisible();
		} else {
			this.scroll = Math.max(0, this.scroll + direction * delta);
		}
	}

	private openShortcut(data: string) {
		const selectedRow = rootRows(flattenRuns(this.source()), this.showCompletedArchive)[this.selected];
		if (selectedRow && "collapsed" in selectedRow) {
			this.showCompletedArchive = true;
			this.options.requestRender?.();
			return;
		}
		const run = this.selectedRun();
		if (data === "s" && !this.canOpenSession(run)) return;
		const runId = run?.id;
		if (!runId) return;
		const current = this.current();
		const next: Route =
			data === "s"
				? { kind: "session", runId }
				: {
						kind: "artifact",
						runId,
						artifact: data === "e" ? "stderr" : data === "m" ? "metadata" : data === "p" ? "prompt" : "output",
					};
		if (current.kind === next.kind && current.runId === runId) {
			if (current.kind === "session" || (current.kind === "artifact" && current.artifact === next.artifact)) return;
		}
		if (current.kind === "artifact" || current.kind === "session") this.routeStack.pop();
		this.routeStack.push(next);
		this.scroll = 0;
		this.options.requestRender?.();
	}

	private enter() {
		const route = this.current();
		if (route.kind === "root") {
			const row = rootRows(flattenRuns(this.source()), this.showCompletedArchive)[this.selected];
			if (row && "collapsed" in row) {
				this.showCompletedArchive = true;
			} else if (row) this.routeStack.push({ kind: "run", runId: row.run.id });
		} else if (route.kind === "run") {
			this.routeStack.push({ kind: "artifact", runId: route.runId, artifact: "output" });
		}
		this.scroll = 0;
		this.options.requestRender?.();
	}

	private header(width: number) {
		const runs = flattenRuns(this.source()).map((item) => item.run);
		const active = runs.filter((run) => !terminal(run)).length;
		const issues = runs.filter((run) => run.status === "failed" || run.status === "timeout").length;
		const left = `${runs.length} runs · ${active} active · ${issues} issues`;
		const right = this.breadcrumb();
		const spacer = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
		return `${left}${" ".repeat(spacer)}${right}`;
	}

	private breadcrumb() {
		return this.routeStack.map((route) => route.kind).join(" › ");
	}

	private footer() {
		const page = "Ctrl-D/U Page";
		const session = this.canOpenSession(this.selectedRun()) ? " · s Session" : "";
		if (this.current().kind === "root") return `↑↓/jk Nav · ${page} · Enter/l Open · o Out${session} · q Quit`;
		return `↑↓/jk Scroll · ${page} · o Out · e Err · m Meta · p Prompt${session} · Esc/h Back · q Quit`;
	}

	private renderRoot(width: number) {
		const items = flattenRuns(this.source());
		if (items.length === 0) return this.emptyState(width);
		const rows = rootRows(items, this.showCompletedArchive);
		this.selected = Math.max(0, Math.min(this.selected, rows.length - 1));
		this.keepRootSelectionVisible();
		const statusWidth = 11;
		const countWidth = 5;
		const modelWidth = width >= 140 ? 24 : width >= 110 ? 18 : 12;
		const timeWidth = 7;
		const agentWidth = Math.min(width >= 140 ? 30 : 24, Math.max(12, Math.floor(width * 0.2)));
		const activityWidth = Math.max(
			8,
			width - 7 - agentWidth - statusWidth - countWidth - countWidth - modelWidth - timeWidth - 6,
		);
		let rowIndex = 0;
		const lines = [
			`${field("", 3)} ${field("Agent", agentWidth)} ${field("Status", statusWidth)} ${field("Turns", countWidth, "right")} ${field("Tools", countWidth, "right")} ${field("Model", modelWidth)} ${field("Time", timeWidth, "right")} ${field("Current activity", activityWidth)}`,
			`${"─".repeat(width)}`,
		];
		for (const row of rows) {
			const selected = rowIndex === this.selected ? "▶" : " ";
			rowIndex += 1;
			if ("collapsed" in row) {
				lines.push(`${selected} + ${row.count} completed agents collapsed — Enter to expand archive`);
				continue;
			}
			const { run, depth } = row;
			const indent = "  ".repeat(depth);
			const elapsed = duration((run.completedAt ?? this.options.now?.() ?? Date.now()) - run.startedAt);
			const agent = `${indent}${glyph(run)} ${run.agent}`;
			const activity = run.currentActivity ?? (run.status === "completed" ? "completed" : "waiting for activity…");
			lines.push(
				`${selected} ${field(agent, agentWidth)} ${field(run.status, statusWidth)} ${field(String(run.turnCount ?? 0), countWidth, "right")} ${field(String(run.toolCount ?? 0), countWidth, "right")} ${field(run.model ?? "-", modelWidth)} ${field(elapsed, timeWidth, "right")} ${field(activity, activityWidth)}`,
			);
		}
		return lines;
	}

	private keepRootSelectionVisible() {
		const selectedContentLine = this.selected + 2;
		const viewportLines = this.viewportLines();
		if (selectedContentLine < this.scroll) {
			this.scroll = selectedContentLine;
		} else if (selectedContentLine >= this.scroll + viewportLines) {
			this.scroll = selectedContentLine - viewportLines + 1;
		}
	}

	private renderRun(runId: string, width: number) {
		const run = findRun(this.source(), runId);
		if (!run) return [`Run not found: ${runId}`];
		const elapsed = duration((run.completedAt ?? this.options.now?.() ?? Date.now()) - run.startedAt);
		const lines = [
			`${glyph(run)} ${run.agent}`,
			"",
			labelValue("Status", run.status, width),
			labelValue("Duration", elapsed, width),
			labelValue("Turns", String(run.turnCount ?? 0), width),
			labelValue("Tools", String(run.toolCount ?? 0), width),
			labelValue("Model", run.model ?? "-", width),
			labelValue("Workflow", run.workflowId, width),
			labelValue("Run ID", run.id, width),
			labelValue("CWD", run.cwd, width),
			labelValue("ACPX", run.acpxSessionName ?? "(no named session)", width),
			labelValue("Session", run.acpxSessionFile ?? "(none)", width),
			labelValue("Trace", run.traceId ?? "none", width),
			"",
			"Artifacts",
			labelValue("output", run.artifacts?.outputPath ?? "(missing)", width),
			labelValue("stderr", run.artifacts?.stderrPath ?? "(missing)", width),
			labelValue("metadata", run.artifacts?.metadataPath ?? "(missing)", width),
		];
		return wrapLines(lines.join("\n"), width, 120);
	}

	private renderArtifact(runId: string, artifact: "output" | "stderr" | "metadata" | "prompt", width: number) {
		const run = findRun(this.source(), runId);
		if (!run) return [`Run not found: ${runId}`];
		const filePath = artifactPath(run, artifact);
		const livePreview =
			artifact === "output" ? run.stdoutPreview : artifact === "stderr" ? run.stderrPreview : undefined;
		const sections = [`${artifact}: ${filePath ?? "(missing)"}`];
		if (livePreview?.length) {
			sections.push("", run.status === "completed" ? "Recent output" : "Live output", ...livePreview);
		}
		const fileText = readBounded(filePath);
		if (fileText && fileText !== "(empty)") sections.push("", "Artifact file", fileText);
		else if (!livePreview?.length) sections.push("", fileText);
		return wrapLines(sections.join("\n"), width, 1000);
	}

	private renderSession(runId: string, width: number) {
		const run = findRun(this.source(), runId);
		if (!run) return [`Run not found: ${runId}`];
		const parsed = run.acpxSessionFile
			? parseAcpxSessionEnvelope(run.acpxSessionFile)
			: { kind: "unsupported" as const, reason: "run has no ACPX session file" };
		if (parsed.kind === "unsupported") return wrapLines(`Session unavailable: ${parsed.reason}`, width, 20);
		const lines = [
			"ACPX Session",
			labelValue("Name", parsed.name ?? "(unnamed)", width),
			labelValue("Backend", parsed.backend, width),
			labelValue("Record", parsed.recordId ?? "(none)", width),
			labelValue("ACP ID", parsed.acpSessionId ?? "(none)", width),
			labelValue("Messages", String(parsed.messageCount), width),
			labelValue("Stream", parsed.streamPath ?? "(none)", width),
			"",
			"Nested hints",
			...(parsed.nestedHints.length
				? parsed.nestedHints.map((hint) => `  ${hint.label} ${hint.agentId ?? ""} ${hint.answerPreview ?? ""}`)
				: ["  none"]),
			"",
			"Preview",
			...parsed.preview.map((line) => `  ${line}`),
		];
		return wrapLines(lines.join("\n"), width, 200);
	}
}
