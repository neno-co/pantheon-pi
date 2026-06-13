import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { findAcpxSessionFileByName, parseAcpxSessionEnvelope } from "../src/workflow/index.ts";

describe("ACPX session adapters", () => {
	test("finds ACPX session files by session name from index", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "pantheon-acpx-sessions-"));
		writeFileSync(
			path.join(dir, "index.json"),
			JSON.stringify({ schema: "acpx.session-index.v1", files: ["a.json", "b.json"] }),
		);
		writeFileSync(path.join(dir, "a.json"), JSON.stringify({ schema: "acpx.session.v1", name: "old", messages: [] }));
		writeFileSync(
			path.join(dir, "b.json"),
			JSON.stringify({ schema: "acpx.session.v1", name: "target", messages: [] }),
		);
		expect(findAcpxSessionFileByName("target", { sessionsDir: dir })).toBe(path.join(dir, "b.json"));
	});

	test("parses common ACPX envelope and Claude collapsed nested hints", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "pantheon-acpx-parse-"));
		const streamPath = path.join(dir, "claude.stream.ndjson");
		writeFileSync(
			streamPath,
			`${JSON.stringify({
				params: {
					_meta: {
						claudeCode: {
							toolResponse: {
								agentId: "agent-123",
								agentType: "general-purpose",
								content: [{ type: "text", text: "NESTED_TASK_OK" }],
							},
						},
					},
				},
			})}\n`,
		);
		const sessionPath = path.join(dir, "claude.json");
		writeFileSync(
			sessionPath,
			JSON.stringify({
				schema: "acpx.session.v1",
				acpx_record_id: "rec",
				acp_session_id: "claude-session",
				name: "claude-test",
				agent_command: "npx -y @agentclientprotocol/claude-agent-acp@latest",
				cwd: "/repo",
				event_log: { active_path: streamPath },
				messages: [{ User: { content: [{ Text: "hello" }] } }, { Agent: { content: [{ Text: "world" }] } }],
			}),
		);

		const parsed = parseAcpxSessionEnvelope(sessionPath, { sessionsDir: dir });
		expect(parsed.kind).toBe("acpx");
		if (parsed.kind !== "acpx") throw new Error("expected acpx parse");
		expect(parsed.backend).toBe("claude");
		expect(parsed.preview.join("\n")).toContain("user: hello");
		expect(parsed.nestedHints[0]).toMatchObject({ agentId: "agent-123", answerPreview: "NESTED_TASK_OK" });
	});

	test("gracefully rejects missing, malformed, and unsafe session files", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "pantheon-acpx-bad-"));
		expect(parseAcpxSessionEnvelope(path.join(dir, "missing.json"), { sessionsDir: dir }).kind).toBe("unsupported");
		const malformed = path.join(dir, "bad.json");
		writeFileSync(malformed, "not json");
		expect(parseAcpxSessionEnvelope(malformed, { sessionsDir: dir }).kind).toBe("unsupported");
		mkdirSync(path.join(dir, "nested"));
		writeFileSync(path.join(dir, "nested", "ok.json"), JSON.stringify({ schema: "acpx.session.v1", messages: [] }));
		expect(parseAcpxSessionEnvelope(path.join(dir, "..", "outside.json"), { sessionsDir: dir }).kind).toBe(
			"unsupported",
		);
	});

	test("rejects symlinked session files that resolve outside the ACPX sessions root", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "pantheon-acpx-symlink-root-"));
		const outside = await mkdtemp(path.join(tmpdir(), "pantheon-acpx-symlink-outside-"));
		const outsideSession = path.join(outside, "outside.json");
		writeFileSync(outsideSession, JSON.stringify({ schema: "acpx.session.v1", name: "target", messages: [] }));
		const linked = path.join(dir, "linked.json");
		symlinkSync(outsideSession, linked);
		expect(parseAcpxSessionEnvelope(linked, { sessionsDir: dir }).kind).toBe("unsupported");
	});
});
