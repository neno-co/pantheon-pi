import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_SESSION_BYTES = 512 * 1024;
const MAX_STREAM_LINES = 400;

export interface AcpxSessionEnvelope {
	kind: "acpx";
	path: string;
	recordId?: string;
	acpSessionId?: string;
	name?: string;
	agentCommand?: string;
	cwd?: string;
	createdAt?: string;
	updatedAt?: string;
	messageCount: number;
	streamPath?: string;
	backend: "pi" | "claude" | "unknown";
	nestedHints: NormalizedNestedHint[];
	preview: string[];
}

export interface NormalizedNestedHint {
	label: string;
	agentId?: string;
	agentType?: string;
	answerPreview?: string;
	nativePath?: string;
}

export interface UnsupportedSessionHistory {
	kind: "unsupported";
	reason: string;
	path?: string;
}

export type NormalizedSessionHistory = AcpxSessionEnvelope | UnsupportedSessionHistory;

function defaultAcpxSessionsDir() {
	return path.join(os.homedir(), ".acpx", "sessions");
}

function defaultClaudeProjectsDir() {
	return path.join(os.homedir(), ".claude", "projects");
}

function realPathForSafety(targetPath: string) {
	try {
		if (existsSync(targetPath)) return realpathSync(targetPath);
		const parent = path.dirname(targetPath);
		if (!existsSync(parent)) return path.resolve(targetPath);
		return path.join(realpathSync(parent), path.basename(targetPath));
	} catch {
		return path.resolve(targetPath);
	}
}

function isInside(targetPath: string, rootPath: string) {
	const relative = path.relative(realPathForSafety(rootPath), realPathForSafety(targetPath));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readBoundedText(filePath: string, maxBytes = MAX_SESSION_BYTES) {
	const stats = statSync(filePath);
	const bytesToRead = Math.min(stats.size, maxBytes);
	const buffer = Buffer.alloc(bytesToRead);
	const fd = openSync(filePath, "r");
	try {
		readSync(fd, buffer, 0, bytesToRead, 0);
	} finally {
		closeSync(fd);
	}
	const text = buffer.toString("utf8");
	if (stats.size > maxBytes) return `${text}\n… truncated at ${maxBytes} bytes from ${stats.size} bytes`;
	return text;
}

export function generateUniqueAcpxSessionId(agent: string): string {
	const sanitizedAgent = agent.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
	const ts = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 7);
	return `pantheon-${sanitizedAgent}-${ts}-${rand}`;
}

export function sanitizeAcpxSessionName(agent: string, sessionId?: string) {
	const raw = sessionId?.trim() || generateUniqueAcpxSessionId(agent);
	const sanitized = raw.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized || generateUniqueAcpxSessionId(agent);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function textFromContent(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const lines: string[] = [];
	for (const item of content) {
		if (typeof item === "string") lines.push(item);
		const record = asRecord(item);
		if (!record) continue;
		if (typeof record.Text === "string") lines.push(record.Text);
		if (typeof record.text === "string") lines.push(record.text);
		const nestedContent = asRecord(record.content);
		if (typeof nestedContent?.text === "string") lines.push(nestedContent.text);
		const toolUse = asRecord(record.ToolUse);
		if (toolUse) lines.push(`[tool:${String(toolUse.name ?? "unknown")}] ${JSON.stringify(toolUse.input ?? {})}`);
		const toolResult = asRecord(record.ToolResult);
		if (toolResult) lines.push(`[tool-result:${String(toolResult.tool_name ?? toolResult.name ?? "unknown")}]`);
	}
	return lines;
}

function previewMessages(messages: unknown) {
	if (!Array.isArray(messages)) return [];
	const lines: string[] = [];
	for (const message of messages.slice(-12)) {
		const record = asRecord(message);
		if (!record) continue;
		const user = asRecord(record.User);
		const agent = asRecord(record.Agent);
		if (user) {
			for (const text of textFromContent(user.content)) lines.push(`user: ${text}`);
		}
		if (agent) {
			for (const text of textFromContent(agent.content)) lines.push(`assistant: ${text}`);
		}
	}
	return lines
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter(Boolean)
		.slice(-12);
}

function backendFromCommand(command: unknown): AcpxSessionEnvelope["backend"] {
	const text = typeof command === "string" ? command : "";
	if (text.includes("PI_ACP_PI_COMMAND") || text.includes("pi-acp")) return "pi";
	if (text.includes("claude-agent-acp") || text.includes("claude")) return "claude";
	return "unknown";
}

function safeIdentifier(value: string | undefined) {
	if (!value || !/^[a-zA-Z0-9._-]+$/.test(value)) return undefined;
	return value;
}

function findClaudeNativeSubagentPath(acpSessionId: string | undefined, agentId: string | undefined) {
	const safeSessionId = safeIdentifier(acpSessionId);
	const safeAgentId = safeIdentifier(agentId);
	if (!safeSessionId || !safeAgentId) return undefined;
	const root = defaultClaudeProjectsDir();
	if (!existsSync(root)) return undefined;
	const candidateSuffix = path.join(`${safeSessionId}`, "subagents", `agent-${safeAgentId}.jsonl`);
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const entryPath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				if (entryPath.includes(`${path.sep}${safeSessionId}`) || current === root) stack.push(entryPath);
				continue;
			}
			if (entryPath.endsWith(candidateSuffix) && isInside(entryPath, root)) return entryPath;
		}
	}
	return undefined;
}

function nestedHintsFromStream(
	streamPath: string | undefined,
	acpSessionId: string | undefined,
	sessionsDir = defaultAcpxSessionsDir(),
) {
	if (!streamPath || !existsSync(streamPath) || !isInside(streamPath, sessionsDir)) return [];
	let text: string;
	try {
		text = readBoundedText(streamPath);
	} catch {
		return [];
	}
	const hints = new Map<string, NormalizedNestedHint>();
	for (const line of text.split("\n").slice(-MAX_STREAM_LINES)) {
		if (!line.includes("claudeCode") && !line.includes("agentId")) continue;
		try {
			const parsed = JSON.parse(line);
			const params = asRecord(parsed.params);
			const update = asRecord(params?.update);
			const meta =
				asRecord(asRecord(update?._meta)?.claudeCode) ??
				asRecord(asRecord(params?._meta)?.claudeCode) ??
				asRecord(asRecord(parsed._meta)?.claudeCode);
			const response = asRecord(meta?.toolResponse);
			const agentId = typeof response?.agentId === "string" ? response.agentId : undefined;
			if (!agentId) continue;
			const content = textFromContent(response?.content).join(" ");
			hints.set(agentId, {
				label: "Claude Task",
				agentId,
				agentType: typeof response?.agentType === "string" ? response.agentType : undefined,
				answerPreview: content || undefined,
				nativePath: findClaudeNativeSubagentPath(acpSessionId, agentId),
			});
		} catch {
			// Ignore non-JSON or unfamiliar stream lines.
		}
	}
	return [...hints.values()];
}

export function findAcpxSessionFileByName(name: string, options: { sessionsDir?: string } = {}) {
	const sessionsDir = options.sessionsDir ?? defaultAcpxSessionsDir();
	const indexPath = path.join(sessionsDir, "index.json");
	if (!existsSync(indexPath)) return undefined;
	if (!isInside(indexPath, sessionsDir)) return undefined;
	try {
		const index = JSON.parse(readBoundedText(indexPath)) as { files?: unknown };
		const files = Array.isArray(index.files)
			? index.files.filter((file): file is string => typeof file === "string")
			: [];
		for (const file of files.slice().reverse()) {
			const sessionPath = path.join(sessionsDir, file);
			if (!sessionPath.endsWith(".json") || !isInside(sessionPath, sessionsDir) || !existsSync(sessionPath)) continue;
			try {
				const session = JSON.parse(readBoundedText(sessionPath)) as { name?: unknown; closed?: unknown };
				if (session.name === name && session.closed !== true) return sessionPath;
			} catch {}
		}
	} catch {
		return undefined;
	}
	return undefined;
}

export function parseAcpxSessionEnvelope(
	filePath: string,
	options: { sessionsDir?: string } = {},
): NormalizedSessionHistory {
	const sessionsDir = options.sessionsDir ?? defaultAcpxSessionsDir();
	if (!filePath) return { kind: "unsupported", reason: "missing session file path" };
	if (!isInside(filePath, sessionsDir))
		return { kind: "unsupported", reason: "session file outside safe ACPX root", path: filePath };
	if (!existsSync(filePath)) return { kind: "unsupported", reason: "session file does not exist", path: filePath };
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(readBoundedText(filePath));
	} catch (error) {
		return {
			kind: "unsupported",
			reason: `failed to parse ACPX session JSON: ${error instanceof Error ? error.message : String(error)}`,
			path: filePath,
		};
	}
	if (parsed.schema !== "acpx.session.v1") {
		return {
			kind: "unsupported",
			reason: `unsupported ACPX session schema: ${String(parsed.schema ?? "missing")}`,
			path: filePath,
		};
	}
	const eventLog = asRecord(parsed.event_log);
	const rawStreamPath = typeof eventLog?.active_path === "string" ? eventLog.active_path : undefined;
	const streamPath = rawStreamPath && isInside(rawStreamPath, sessionsDir) ? rawStreamPath : undefined;
	const acpSessionId = typeof parsed.acp_session_id === "string" ? parsed.acp_session_id : undefined;
	const backend = backendFromCommand(parsed.agent_command);
	return {
		kind: "acpx",
		path: filePath,
		recordId: typeof parsed.acpx_record_id === "string" ? parsed.acpx_record_id : undefined,
		acpSessionId,
		name: typeof parsed.name === "string" ? parsed.name : undefined,
		agentCommand: typeof parsed.agent_command === "string" ? parsed.agent_command : undefined,
		cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
		createdAt: typeof parsed.created_at === "string" ? parsed.created_at : undefined,
		updatedAt: typeof parsed.updated_at === "string" ? parsed.updated_at : undefined,
		messageCount: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
		streamPath,
		backend,
		nestedHints: backend === "claude" ? nestedHintsFromStream(streamPath, acpSessionId, sessionsDir) : [],
		preview: previewMessages(parsed.messages),
	};
}
