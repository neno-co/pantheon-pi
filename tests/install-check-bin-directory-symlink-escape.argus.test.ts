import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkInstallPrerequisites } from "../src/install-check/index.ts";

const requiredAgents = [
	"argus",
	"codebase-analyzer",
	"codebase-locator",
	"codebase-pattern-finder",
	"document-writer",
	"explore",
	"frontend-engineer",
	"hunter-code-review",
	"hunter-comments",
	"hunter-security",
	"hunter-silent-failure",
	"hunter-simplifier",
	"hunter-test-coverage",
	"hunter-type-design",
	"librarian",
	"mnemosyne",
	"oracle",
	"prometheus",
	"thoughts-analyzer",
	"thoughts-locator",
	"translator",
	"vulkanus",
	"zeus",
] as const;

function writeExecutableScript(filePath: string, body = "#!/bin/sh\nexit 0\n") {
	writeFileSync(filePath, body);
	chmodSync(filePath, 0o755);
}

function writeBaselineFixture(rootDir: string, externalBinDir: string) {
	mkdirSync(path.join(rootDir, "src/extension"), { recursive: true });
	mkdirSync(path.join(rootDir, "agents/prompts"), { recursive: true });
	mkdirSync(path.join(rootDir, "agents/manifests"), { recursive: true });
	mkdirSync(path.join(rootDir, "agents"), { recursive: true });
	mkdirSync(path.join(rootDir, "skills"), { recursive: true });
	mkdirSync(externalBinDir, { recursive: true });

	writeFileSync(path.join(rootDir, "src/extension/index.ts"), "export {}\n");
	writeFileSync(
		path.join(rootDir, "package.json"),
		JSON.stringify(
			{
				name: "pantheon-pi",
				version: "0.1.0",
				files: ["src/extension", "agents/prompts", "agents/manifests", "agents/bin", "package.json"],
				pi: {
					extensions: ["./src/extension/index.ts"],
					prompts: [],
				},
			},
			null,
			2,
		),
	);

	const agents: Record<
		string,
		{
			command: string;
			args: string[];
			kind: string;
			prompt?: string;
			defaultPermissions?: string;
			defaultRoutable?: boolean;
			debugOnly?: boolean;
		}
	> = {};

	for (const agent of requiredAgents) {
		agents[agent] = {
			command: "env",
			args: [`PI_ACP_PI_COMMAND=./agents/bin/${agent}`, "npx", "-y", "pi-acp@latest"],
			kind: "pi-acp-packaged-prompt-agent",
			prompt: `agents/prompts/${agent}.md`,
		};
		writeFileSync(path.join(rootDir, "agents/prompts", `${agent}.md`), `# ${agent}\nReal role prompt\n`);
		writeExecutableScript(path.join(externalBinDir, agent));
	}

	agents.pi = {
		command: "npx",
		args: ["-y", "pi-acp@latest"],
		kind: "external-acp",
		defaultRoutable: false,
		debugOnly: true,
	};

	writeFileSync(
		path.join(rootDir, "agents/manifests/acpx-baseline.json"),
		JSON.stringify(
			{
				schemaVersion: 1,
				source: "fixture",
				defaults: { defaultAgent: "zeus", defaultPermissions: "approve-all" },
				agents,
			},
			null,
			2,
		),
	);

	symlinkSync(externalBinDir, path.join(rootDir, "agents/bin"));
}

describe("Argus: install-check rejects symlinked packaged bin directories", () => {
	test("flags agents/bin when the directory itself resolves outside the package root", () => {
		const rootDir = mkdtempSync(path.join(os.tmpdir(), "pantheon-argus-root-"));
		const outsideDir = mkdtempSync(path.join(os.tmpdir(), "pantheon-argus-outside-"));
		const externalBinDir = path.join(outsideDir, "bin");

		writeBaselineFixture(rootDir, externalBinDir);

		const report = checkInstallPrerequisites({ rootDir, env: {} });

		expect(report.resources.bin.exists).toBe(true);
		expect(report.ok).toBe(false);
		expect(report.resources.bin.placeholderFiles).toContain("zeus");
	});
});
