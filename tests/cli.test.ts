import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PANTHEON_AGENTS } from "../src/agents.ts";
import {
	buildPantheonPiInvocation,
	pantheonUsage,
	parsePantheonCli,
	runPantheonInit,
	validateForwardedPiArgs,
} from "../src/cli.ts";
import { telemetryMain } from "../src/telemetry/cli/index.ts";

function makePackageRoot() {
	const rootDir = mkdtempSync(path.join(os.tmpdir(), "pantheon-cli-root-"));
	mkdirSync(path.join(rootDir, "agents/prompts"), { recursive: true });
	for (const agent of PANTHEON_AGENTS) {
		writeFileSync(path.join(rootDir, `agents/prompts/${agent}.md`), `# ${agent}\nPrompt for ${agent}\n`);
	}
	return rootDir;
}

describe("pantheon CLI parsing and launch", () => {
	test("top-level help is owned by Pantheon instead of forwarding to Pi", () => {
		expect(parsePantheonCli(["--help"])).toEqual({ command: "help" });
		expect(parsePantheonCli(["-h"])).toEqual({ command: "help" });
		expect(parsePantheonCli(["help"])).toEqual({ command: "help" });
		expect(pantheonUsage()).toContain("pantheon [--agent <agent>] [...pi args]");
		expect(pantheonUsage()).toContain("Use `pi --help` for raw Pi help");
	});

	test("explicit separator allows forwarding help to Pi", () => {
		const parsed = parsePantheonCli(["--", "--help"]);
		expect(parsed).toEqual({ command: "launch", agent: "athena", forwardedArgs: ["--help"] });
	});

	test("bare pantheon defaults to launching Athena through vanilla pi with appended prompt", () => {
		const rootDir = makePackageRoot();
		const parsed = parsePantheonCli([]);
		const invocation = buildPantheonPiInvocation(parsed, { rootDir, piBin: "pi" });

		expect(parsed).toEqual({ command: "launch", agent: "athena", forwardedArgs: [] });
		expect(invocation.command).toBe("pi");
		expect(invocation.args).toEqual(["--append-system-prompt", path.join(rootDir, "agents/prompts/athena.md")]);
		expect(invocation.args).not.toContain("--system-prompt");
	});

	test("--agent selects from shared allow-list and forwards extra pi args", () => {
		const rootDir = makePackageRoot();
		const parsed = parsePantheonCli(["--agent", "vulkanus", "-p", "hi"]);
		const invocation = buildPantheonPiInvocation(parsed, { rootDir, piBin: "/usr/local/bin/pi" });

		expect(parsed).toEqual({ command: "launch", agent: "vulkanus", forwardedArgs: ["-p", "hi"] });
		expect(invocation).toEqual({
			command: "/usr/local/bin/pi",
			args: ["--append-system-prompt", path.join(rootDir, "agents/prompts/vulkanus.md"), "-p", "hi"],
		});
	});

	test("unsupported agents fail from the shared allow-list", () => {
		expect(() => parsePantheonCli(["--agent", "bogus"])).toThrow(/Unsupported Pantheon agent: bogus/);
	});

	test("forwarded prompt override flags fail fast before invoking pi", () => {
		for (const args of [
			["--agent", "zeus", "--system-prompt", "custom"],
			["--append-system-prompt", "custom"],
			["--system-prompt=custom"],
			["--append-system-prompt=custom"],
			["--systemPrompt", "custom"],
			["--appendSystemPrompt", "custom"],
		]) {
			expect(() => parsePantheonCli(args)).toThrow(/Pantheon owns Pi system prompt flags/);
		}
	});

	test("prompt append semantics preserve Pi tools by avoiding replacement", () => {
		const rootDir = makePackageRoot();
		const invocation = buildPantheonPiInvocation(parsePantheonCli(["--agent", "zeus"]), { rootDir });
		const piUsageDocs = readFileSync(
			path.join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/README.md"),
			"utf8",
		);

		expect(invocation.command).toBe("pi");
		expect(invocation.args[0]).toBe("--append-system-prompt");
		expect(invocation.args).not.toContain("--system-prompt");
		expect(piUsageDocs).toContain("--append-system-prompt <text>");
		expect(piUsageDocs).toContain("Append to system prompt");
		expect(piUsageDocs).toContain("--system-prompt <text>");
		expect(piUsageDocs).toContain("Replace default prompt");
	});

	test("validateForwardedPiArgs catches prompt flags after -- separators", () => {
		expect(() => validateForwardedPiArgs(["--", "--system-prompt", "custom"])).toThrow(
			/Pantheon owns Pi system prompt flags/,
		);
	});
});

describe("pantheon telemetry help", () => {
	test("prints command help for explicit help flags", async () => {
		for (const args of [["--help"], ["-h"], ["help"]]) {
			const output = await telemetryMain(args);
			expect(output).toContain("Usage:");
			expect(output).toContain("pantheon telemetry runs");
			expect(output).toContain("--json --no-ingest");
		}
	});
});

describe("pantheon init", () => {
	test("is assets/check-only and does not create APPEND_SYSTEM.md", () => {
		const rootDir = makePackageRoot();
		const homeDir = mkdtempSync(path.join(os.tmpdir(), "pantheon-cli-home-"));
		const result = runPantheonInit({ rootDir, env: {}, pathEnv: "", isExecutable: () => false });
		const appendSystemPath = path.join(homeDir, ".pi/agent/APPEND_SYSTEM.md");

		expect(result.install.failures.length).toBeGreaterThan(0);
		expect(existsSync(appendSystemPath)).toBe(false);
	});

	test("does not migrate or modify existing APPEND_SYSTEM files or symlinks", () => {
		const rootDir = makePackageRoot();
		const homeDir = mkdtempSync(path.join(os.tmpdir(), "pantheon-cli-home-"));
		const appendSystemPath = path.join(homeDir, ".pi/agent/APPEND_SYSTEM.md");
		mkdirSync(path.dirname(appendSystemPath), { recursive: true });
		writeFileSync(appendSystemPath, "# user prompt\n");

		runPantheonInit({ rootDir, env: {}, pathEnv: "", isExecutable: () => false });
		expect(readFileSync(appendSystemPath, "utf8")).toBe("# user prompt\n");

		const secondHomeDir = mkdtempSync(path.join(os.tmpdir(), "pantheon-cli-home-"));
		const secondAppendPath = path.join(secondHomeDir, ".pi/agent/APPEND_SYSTEM.md");
		mkdirSync(path.dirname(secondAppendPath), { recursive: true });
		const otherPrompt = path.join(secondHomeDir, "other.md");
		writeFileSync(otherPrompt, "# other\n");
		symlinkSync(otherPrompt, secondAppendPath);

		runPantheonInit({ rootDir, env: {}, pathEnv: "", isExecutable: () => false });
		expect(readlinkSync(secondAppendPath)).toBe(otherPrompt);

		const thirdHomeDir = mkdtempSync(path.join(os.tmpdir(), "pantheon-cli-home-"));
		const pantheonAppendPath = path.join(thirdHomeDir, ".pi/agent/APPEND_SYSTEM.md");
		mkdirSync(path.dirname(pantheonAppendPath), { recursive: true });
		symlinkSync(path.join(rootDir, "agents/prompts/zeus.md"), pantheonAppendPath);

		runPantheonInit({ rootDir, env: {}, pathEnv: "", isExecutable: () => false });
		expect(readlinkSync(pantheonAppendPath)).toBe(path.join(rootDir, "agents/prompts/zeus.md"));
	});
});
