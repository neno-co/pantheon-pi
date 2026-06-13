import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkInstallPrerequisites, findPathBinary, validatePackageManifest } from "../src/install-check/index.ts";

const root = process.cwd();

const expectedManagedAgents = [
	"argus",
	"athena",
	"codebase-analyzer",
	"codebase-locator",
	"codebase-pattern-finder",
	"dike",
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
	"meta-reviewer",
	"mnemosyne",
	"nemotron",
	"oracle",
	"prometheus",
	"thoughts-analyzer",
	"thoughts-locator",
	"translator",
	"vulkanus",
	"zeus",
];

const expectedPiExtensions = [
	"./src/extension/index.ts",
	"./node_modules/pi-lsp/extensions/pi-lsp/index.ts",
	"./node_modules/pi-goal/.pi/extensions/pi-goal/index.ts",
];

const expectedPackagedSkills = [
	"./skills/mlops/observability/langwatch-acpx",
	"./skills/pantheon-telemetry",
	"./skills/pantheon-cli",
];

describe("install prerequisite checks", () => {
	test("package manifest declares distribution files and Pi resources", () => {
		const report = checkInstallPrerequisites({
			rootDir: root,
			env: {},
			pathEnv: "",
			isExecutable: () => false,
		});

		expect(report.failures).toEqual([]);
		expect(report.manifest.packageName).toBe("pantheon-pi");
		expect(report.manifest.files).toContain("src/extension");
		expect(report.manifest.files).toContain("src/agents.ts");
		expect(report.manifest.files).toContain("src/cli.ts");
		expect(report.manifest.files).toContain("src/telemetry");
		expect(report.manifest.files).toContain("agents/prompts");
		expect(report.manifest.files).toContain("agents/manifests");
		expect(report.manifest.files).toContain("agents/bin");
		expect(report.manifest.files).toContain("skills");
		expect(report.manifest.piExtensions).toEqual(expect.arrayContaining(expectedPiExtensions));
		expect(report.manifest.piExtensions).not.toContain(
			"./node_modules/@injaneity/pi-computer-use/extensions/computer-use.ts",
		);
		expect(report.manifest.optionalDependencies).not.toContain("@injaneity/pi-computer-use");
		for (const extensionPath of expectedPiExtensions) {
			expect(report.failures).not.toContain(`declared pi extension is missing or unsafe: ${extensionPath}`);
		}
		expect(report.manifest.bin.pantheon).toBe("./src/cli.ts");
		expect(report.resources.cliEntrypoint.exists).toBe(true);
		expect(report.resources.telemetry.exists).toBe(true);
		expect(report.manifest.piSkills).toEqual(expect.arrayContaining(expectedPackagedSkills));
		expect(report.resources.skills.exists).toBe(true);
		expect(report.resources.skills.agentCount).toBeGreaterThanOrEqual(expectedPackagedSkills.length);
		expect(report.resources.skills.placeholderFiles).toEqual([]);
		expect(report.resources.extensionEntrypoint.exists).toBe(true);
		expect(report.resources.prompts.exists).toBe(true);
		expect(report.resources.manifests.exists).toBe(true);
		expect(report.resources.prompts.agentCount).toBeGreaterThanOrEqual(expectedManagedAgents.length);
		expect(report.resources.prompts.requiredAgentsMissing).toEqual([]);
		expect(report.resources.prompts.placeholderFiles).toEqual([]);
		expect(report.resources.manifests.agentCount).toBeGreaterThanOrEqual(expectedManagedAgents.length);
		expect(report.resources.manifests.requiredAgentsMissing).toEqual([]);
		expect(report.resources.manifests.placeholderFiles).toEqual([]);
		expect(report.resources.bin.exists).toBe(true);
		expect(report.resources.bin.requiredAgentsMissing).toEqual([]);
		expect(report.resources.bin.placeholderFiles).toEqual([]);
		expect(report.manifest.piPrompts).not.toContain("./agents/prompts");
		expect(report.acpx.required).toBe(false);
	});

	// Claude-backed agents run through claude-agent-acp with packaged prompts injected; all other
	// managed agents route through packaged pi-acp prompts. See SPEC.md (Pantheon-owned Claude Code route).
	const claudeBackedAgents = [
		"argus",
		"codebase-analyzer",
		"dike",
		"document-writer",
		"explore",
		"librarian",
		"meta-reviewer",
		"mnemosyne",
		"oracle",
		"prometheus",
		"thoughts-analyzer",
		"translator",
		"vulkanus",
	];
	const expectedModels: Record<string, string> = {
		argus: "claude-opus-4-8",
		athena: "openai-codex/gpt-5.5",
		"codebase-analyzer": "claude-sonnet-4-6",
		"codebase-locator": "google/gemini-3-flash-preview",
		"codebase-pattern-finder": "google/gemini-3-flash-preview",
		dike: "claude-opus-4-8",
		"document-writer": "claude-sonnet-4-5",
		explore: "claude-sonnet-4-6",
		"frontend-engineer": "google/gemini-3.1-pro-preview-customtools",
		"hunter-code-review": "google/gemini-3.1-pro-preview-customtools",
		"hunter-comments": "google/gemini-3.1-pro-preview-customtools",
		"hunter-security": "google/gemini-3.1-pro-preview-customtools",
		"hunter-silent-failure": "google/gemini-3.1-pro-preview-customtools",
		"hunter-simplifier": "google/gemini-3.1-pro-preview-customtools",
		"hunter-test-coverage": "google/gemini-3.1-pro-preview-customtools",
		"hunter-type-design": "google/gemini-3.1-pro-preview-customtools",
		librarian: "claude-sonnet-4-6",
		"meta-reviewer": "claude-opus-4-8",
		mnemosyne: "claude-opus-4-5",
		nemotron: "nebius/nvidia/nemotron-3-super-120b-a12b",
		oracle: "claude-opus-4-8",
		prometheus: "claude-opus-4-6",
		"thoughts-analyzer": "claude-sonnet-4-6",
		"thoughts-locator": "google/gemini-3-flash-preview",
		translator: "claude-sonnet-4-6",
		vulkanus: "claude-sonnet-4-6",
		zeus: "openai-codex/gpt-5.5",
	};

	test("baseline manifest routes Pantheon-managed agents through packaged prompts", () => {
		const manifest = JSON.parse(readFileSync(path.join(root, "agents/manifests/acpx-baseline.json"), "utf8"));
		expect(manifest.defaults.defaultAgent).toBe("athena");
		expect(Object.keys(manifest.agents).sort()).toEqual([...expectedManagedAgents, "pi"].sort());
		expect(manifest.agents.pi.defaultRoutable).toBe(false);
		expect(manifest.agents.pi.debugOnly).toBe(true);

		for (const agent of expectedManagedAgents) {
			if (claudeBackedAgents.includes(agent)) continue;
			const config = manifest.agents[agent];
			expect(config.kind).toBe("pi-acp-packaged-prompt-agent");
			expect(config.model).toBe(expectedModels[agent]);
			expect(config.prompt).toBe(`agents/prompts/${agent}.md`);
			expect(config.args).toContain(`PI_ACP_PI_COMMAND=./agents/bin/${agent}`);
			expect(config.command).not.toBe("@agentclientprotocol/claude-agent-acp");
			expect(config.args.join(" ")).not.toContain("claude-agent-acp");
		}
		for (const agent of claudeBackedAgents) {
			expect(manifest.agents[agent].defaultPermissions).toBe("approve-all");
		}
	});

	test("Claude Code agents use configured models with packaged prompts injected, staying Pantheon-owned", () => {
		const manifest = JSON.parse(readFileSync(path.join(root, "agents/manifests/acpx-baseline.json"), "utf8"));
		for (const agent of claudeBackedAgents) {
			const config = manifest.agents[agent];
			expect(config.kind).toBe("claude-agent-acp");
			expect(config.model).toBe(expectedModels[agent]);
			// The versioned prompt is still packaged and injected — the route does not depend on the
			// external/default claude-agent-acp prompt (SPEC.md carve-out).
			expect(config.prompt).toBe(`agents/prompts/${agent}.md`);
			expect(config.args.join(" ")).toContain("@agentclientprotocol/claude-agent-acp");
			expect(config.defaultPermissions).toBe("approve-all");
			expect(existsSync(path.join(root, "agents/prompts", `${agent}.md`))).toBe(true);
		}
		expect(manifest.agents.oracle.defaultTimeoutSeconds).toBe(600);
	});

	test("packaged launchers use configured model fallbacks and suppress startup update noise", () => {
		for (const agent of expectedManagedAgents) {
			const launcher = readFileSync(path.join(root, "agents/bin", agent), "utf8");
			expect(launcher).toContain(`export PI_SKIP_VERSION_CHECK="\${PI_SKIP_VERSION_CHECK:-1}"`);
			expect(launcher).toContain("PANTHEON_PI_MODEL");
			expect(launcher).toContain(`--model ${expectedModels[agent]}`);
		}
	});

	test("Athena prompt preserves primary builder-orchestrator guardrails under Pi runtime", () => {
		const athenaPrompt = readFileSync(path.join(root, "agents/prompts/athena.md"), "utf8");

		expect(athenaPrompt).toContain("Do **not** invoke OpenCode directly");
		expect(athenaPrompt).toContain("implement directly by default");
		expect(athenaPrompt).toContain("Frontend Engineer consultation is mandatory for frontend changes");
		expect(athenaPrompt).toContain("Argus review is mandatory before landing long-term functionality");
		expect(athenaPrompt).toContain("discover and run repo-native validation commands");
		expect(athenaPrompt).toContain("Use beads");
		expect(athenaPrompt).not.toContain("thoughts/tasks");
		expect(athenaPrompt).not.toContain("deno task validate");
		expect(athenaPrompt).not.toContain("OpenCode primary");
		expect(athenaPrompt).not.toContain("opencode serve");
	});

	test("strict mode fails when acpx cannot be discovered", () => {
		const report = checkInstallPrerequisites({
			rootDir: root,
			requireAcpx: true,
			env: {},
			pathEnv: "",
			isExecutable: () => false,
		});

		expect(report.ok).toBe(false);
		console.log(report.failures);
		expect(report.failures).toContain("acpx binary was not found or is not executable");
	});

	test("configured executable acpx satisfies strict mode", () => {
		const fakeAcpx = path.join(root, "tmp", "acpx");
		const report = checkInstallPrerequisites({
			rootDir: root,
			requireAcpx: true,
			env: { PANTHEON_ACPX_BIN: fakeAcpx },
			pathEnv: "",
			isExecutable: (candidate) => candidate === fakeAcpx,
		});

		expect(report.ok).toBe(true);
		expect(report.acpx.path).toBe(fakeAcpx);
		expect(report.acpx.source).toBe("PANTHEON_ACPX_BIN");
	});

	test("PATH discovery checks each executable candidate", () => {
		const binDir = path.join(root, "bin");
		const candidate = path.join(binDir, "acpx");
		expect(
			findPathBinary("acpx", `${path.join(root, "missing")}${path.delimiter}${binDir}`, (value) => value === candidate),
		).toBe(candidate);
	});

	test("manifest validation reports missing distribution resources", () => {
		const result = validatePackageManifest({
			name: "pantheon-pi",
			files: ["src/extension"],
			pi: { extensions: ["./src/extension/index.ts"], prompts: [] },
		});

		expect(result.failures).toContain("package.json files must include src/agents.ts");
		expect(result.failures).toContain("package.json files must include src/cli.ts");
		expect(result.failures).toContain("package.json files must include src/telemetry");
		expect(result.failures).toContain("package.json files must include agents/prompts");
		expect(result.failures).toContain("package.json files must include agents/manifests");
		expect(result.failures).toContain("package.json files must include agents/bin");
		expect(result.failures).toContain("package.json bin must include pantheon -> ./src/cli.ts");
	});

	test("manifest validation rejects bin.pantheon pointing to a different target", () => {
		const result = validatePackageManifest({
			name: "pantheon-pi",
			version: "0.0.0-test",
			files: [
				"src/agents.ts",
				"src/extension",
				"src/cli.ts",
				"src/telemetry",
				"agents/prompts",
				"agents/manifests",
				"agents/bin",
				"package.json",
			],
			bin: { pantheon: "./bin/pantheon.js" },
			pi: { extensions: ["./src/extension/index.ts"], prompts: [], skills: ["./skills/pantheon-telemetry"] },
		});

		expect(result.failures).toContain("package.json bin.pantheon must point to ./src/cli.ts (found ./bin/pantheon.js)");
	});

	test("manifest validation requires skills distribution resources when Pi skills are declared", () => {
		const result = validatePackageManifest({
			name: "pantheon-pi",
			version: "0.0.0-test",
			files: ["src/extension", "agents/prompts", "agents/manifests", "agents/bin", "package.json"],
			pi: { extensions: ["./src/extension/index.ts"], prompts: [], skills: ["./skills/example"] },
		});

		expect(result.failures).toContain("package.json files must include skills when pi.skills are declared");
		expect(result.failures).toContain("package.json pi.skills must include ./skills/pantheon-telemetry");
	});

	test("manifest validation requires the packaged Pantheon telemetry skill", () => {
		const result = validatePackageManifest({
			name: "pantheon-pi",
			version: "0.0.0-test",
			files: ["src/extension", "agents/prompts", "agents/manifests", "agents/bin", "skills", "package.json"],
			pi: { extensions: ["./src/extension/index.ts"], prompts: [], skills: ["./skills/example"] },
		});

		expect(result.failures).toContain("package.json pi.skills must include ./skills/pantheon-telemetry");
	});

	test("install checks warn instead of failing when optional pi extensions are not installed", () => {
		const tempRoot = mkdtempSync(path.join(os.tmpdir(), "pantheon-install-check-"));
		mkdirSync(path.join(tempRoot, "src/extension"), { recursive: true });
		writeFileSync(path.join(tempRoot, "src/extension/index.ts"), "export default function extension() {}\n");
		writeFileSync(
			path.join(tempRoot, "package.json"),
			JSON.stringify({
				name: "pantheon-pi",
				version: "0.0.0-test",
				files: ["src/extension", "agents/prompts", "agents/manifests", "agents/bin", "package.json"],
				optionalDependencies: { "@injaneity/pi-computer-use": "0.2.5" },
				pi: {
					extensions: [
						"./src/extension/index.ts",
						"./node_modules/@injaneity/pi-computer-use/extensions/computer-use.ts",
					],
					prompts: [],
					skills: ["./skills/pantheon-telemetry"],
				},
				bin: { pantheon: "./src/cli.ts" },
			}),
		);

		const report = checkInstallPrerequisites({
			rootDir: tempRoot,
			env: {},
			pathEnv: "",
			isExecutable: () => false,
		});

		expect(report.warnings).toContain(
			"optional pi extension is not installed: ./node_modules/@injaneity/pi-computer-use/extensions/computer-use.ts",
		);
		expect(report.failures).not.toContain(
			"declared pi extension is missing or unsafe: ./node_modules/@injaneity/pi-computer-use/extensions/computer-use.ts",
		);
	});

	test("install checks still fail when optional pi extension declarations are unsafe", () => {
		const tempRoot = mkdtempSync(path.join(os.tmpdir(), "pantheon-install-check-"));
		mkdirSync(path.join(tempRoot, "src/extension"), { recursive: true });
		writeFileSync(path.join(tempRoot, "src/extension/index.ts"), "export default function extension() {}\n");
		writeFileSync(
			path.join(tempRoot, "package.json"),
			JSON.stringify({
				name: "pantheon-pi",
				version: "0.0.0-test",
				files: ["src/extension", "agents/prompts", "agents/manifests", "agents/bin", "package.json"],
				optionalDependencies: { "@injaneity/pi-computer-use": "0.2.5" },
				pi: {
					extensions: [
						"./src/extension/index.ts",
						"../node_modules/@injaneity/pi-computer-use/extensions/computer-use.ts",
					],
					prompts: [],
					skills: ["./skills/pantheon-telemetry"],
				},
				bin: { pantheon: "./src/cli.ts" },
			}),
		);

		const report = checkInstallPrerequisites({
			rootDir: tempRoot,
			env: {},
			pathEnv: "",
			isExecutable: () => false,
		});

		expect(report.failures).toContain(
			"declared pi extension is missing or unsafe: ../node_modules/@injaneity/pi-computer-use/extensions/computer-use.ts",
		);
		expect(report.warnings).not.toContain(
			"optional pi extension is not installed: ../node_modules/@injaneity/pi-computer-use/extensions/computer-use.ts",
		);
	});

	test("install checks reject symlinked or out-of-tree declared skills", () => {
		const tempRoot = mkdtempSync(path.join(os.tmpdir(), "pantheon-install-check-"));
		mkdirSync(path.join(tempRoot, "skills/real-skill"), { recursive: true });
		mkdirSync(path.join(tempRoot, "external-skill"), { recursive: true });
		writeFileSync(path.join(tempRoot, "skills/real-skill/SKILL.md"), "---\nname: real-skill\n---\n");
		writeFileSync(path.join(tempRoot, "external-skill/SKILL.md"), "---\nname: external-skill\n---\n");
		symlinkSync(path.join(tempRoot, "external-skill"), path.join(tempRoot, "skills/symlink-skill"));
		writeFileSync(
			path.join(tempRoot, "package.json"),
			JSON.stringify({
				name: "pantheon-pi",
				version: "0.0.0-test",
				files: ["src/extension", "agents/prompts", "agents/manifests", "agents/bin", "skills", "package.json"],
				pi: {
					extensions: ["./src/extension/index.ts"],
					prompts: [],
					skills: ["./skills/real-skill", "./skills/symlink-skill", "./external-skill"],
				},
			}),
		);

		const report = checkInstallPrerequisites({
			rootDir: tempRoot,
			env: {},
			pathEnv: "",
			isExecutable: () => false,
		});

		expect(report.resources.skills.placeholderFiles).toEqual(["symlink-skill", "external-skill"]);
		expect(report.failures).toContain("placeholder packaged resources in skills: symlink-skill, external-skill");
	});

	test("manifest validation rejects packaged agent prompts as Pi prompt templates", () => {
		for (const promptPath of ["./agents/prompts", "agents/prompts", "./agents/prompts/", "agents\\prompts"]) {
			const result = validatePackageManifest({
				name: "pantheon-pi",
				version: "0.0.0-test",
				files: ["src/extension", "agents/prompts", "agents/manifests", "agents/bin", "package.json"],
				pi: { extensions: ["./src/extension/index.ts"], prompts: [promptPath] },
			});

			expect(result.failures).toContain(
				"package.json pi.prompts must not include ./agents/prompts because packaged agent system prompts are not Pi prompt templates",
			);
		}
	});

	test("baseline checks fail when packaged prompts or manifests are missing or placeholders", () => {
		const tempRoot = mkdtempSync(path.join(os.tmpdir(), "pantheon-install-check-"));
		mkdirSync(path.join(tempRoot, "src/extension"), { recursive: true });
		mkdirSync(path.join(tempRoot, "agents/prompts"), { recursive: true });
		mkdirSync(path.join(tempRoot, "agents/manifests"), { recursive: true });
		writeFileSync(path.join(tempRoot, "src/extension/index.ts"), "export default function extension() {}\n");
		writeFileSync(
			path.join(tempRoot, "package.json"),
			JSON.stringify({
				name: "pantheon-pi",
				version: "0.0.0-test",
				files: ["src/extension", "agents/prompts", "agents/manifests", "package.json"],
				pi: { extensions: ["./src/extension/index.ts"], prompts: [] },
			}),
		);
		writeFileSync(path.join(tempRoot, "agents/prompts/zeus.md"), "MVP status: scaffold + placeholder prompts\n");
		writeFileSync(
			path.join(tempRoot, "agents/manifests/acpx-baseline.json"),
			JSON.stringify({ agents: { zeus: { command: "env" } } }),
		);

		const report = checkInstallPrerequisites({
			rootDir: tempRoot,
			env: {},
			pathEnv: "",
			isExecutable: () => false,
		});

		expect(report.ok).toBe(false);
		console.log(report.failures);
		const expectedMissingExceptZeus = expectedManagedAgents.filter((agent) => agent !== "zeus").join(", ");
		expect(report.failures).toContain(
			`required packaged agents missing from agents/prompts: ${expectedMissingExceptZeus}`,
		);
		expect(report.failures).toContain("placeholder packaged resources in agents/prompts: zeus.md");
		expect(report.failures).toContain(
			`required packaged agents missing from agents/manifests: ${expectedMissingExceptZeus}`,
		);
	});

	test("baseline checks fail when manifests include local secrets or absolute user paths", () => {
		const tempRoot = mkdtempSync(path.join(os.tmpdir(), "pantheon-install-check-"));
		mkdirSync(path.join(tempRoot, "src/extension"), { recursive: true });
		mkdirSync(path.join(tempRoot, "agents/prompts"), { recursive: true });
		mkdirSync(path.join(tempRoot, "agents/manifests"), { recursive: true });
		writeFileSync(path.join(tempRoot, "src/extension/index.ts"), "export default function extension() {}\n");
		writeFileSync(
			path.join(tempRoot, "package.json"),
			JSON.stringify({
				name: "pantheon-pi",
				version: "0.0.0-test",
				files: ["src/extension", "agents/prompts", "agents/manifests", "package.json"],
				pi: { extensions: ["./src/extension/index.ts"], prompts: [] },
			}),
		);
		for (const agent of ["zeus", "vulkanus", "oracle", "argus"]) {
			writeFileSync(path.join(tempRoot, `agents/prompts/${agent}.md`), `# ${agent}\nReal role prompt\n`);
		}
		writeFileSync(
			path.join(tempRoot, "agents/manifests/acpx-baseline.json"),
			JSON.stringify({
				agents: {
					zeus: { command: "env", args: ["PI_ACP_PI_COMMAND=/Users/someone/.pi/agent/acp-agents/bin/zeus"] },
					vulkanus: { command: "env" },
					oracle: { command: "env" },
					argus: { command: "env" },
				},
			}),
		);

		const report = checkInstallPrerequisites({
			rootDir: tempRoot,
			env: {},
			pathEnv: "",
			isExecutable: () => false,
		});

		expect(report.ok).toBe(false);
		console.log(report.failures);
		expect(report.failures).toContain("placeholder packaged resources in agents/manifests: acpx-baseline.json");
	});

	test("baseline checks fail when manifest references a non-shipped packaged agent bin", () => {
		const tempRoot = mkdtempSync(path.join(os.tmpdir(), "pantheon-install-check-"));
		mkdirSync(path.join(tempRoot, "src/extension"), { recursive: true });
		mkdirSync(path.join(tempRoot, "agents/prompts"), { recursive: true });
		mkdirSync(path.join(tempRoot, "agents/manifests"), { recursive: true });
		mkdirSync(path.join(tempRoot, "agents/bin"), { recursive: true });
		writeFileSync(path.join(tempRoot, "src/extension/index.ts"), "export default function extension() {}\n");
		writeFileSync(
			path.join(tempRoot, "package.json"),
			JSON.stringify({
				name: "pantheon-pi",
				version: "0.0.0-test",
				files: ["src/extension", "agents/prompts", "agents/manifests", "agents/bin", "package.json"],
				pi: { extensions: ["./src/extension/index.ts"], prompts: [] },
			}),
		);
		for (const agent of ["zeus", "vulkanus", "oracle", "argus"]) {
			writeFileSync(path.join(tempRoot, `agents/prompts/${agent}.md`), `# ${agent}\nReal role prompt\n`);
			writeFileSync(path.join(tempRoot, `agents/bin/${agent}`), '#!/bin/sh\nexec pi --system-prompt prompt "$@"\n');
			chmodSync(path.join(tempRoot, `agents/bin/${agent}`), 0o755);
		}
		writeFileSync(
			path.join(tempRoot, "agents/manifests/acpx-baseline.json"),
			JSON.stringify({
				agents: {
					zeus: { command: "env", args: ["PI_ACP_PI_COMMAND=agents/bin/missing-zeus", "npx", "-y", "pi-acp@latest"] },
					vulkanus: { command: "env", args: ["PI_ACP_PI_COMMAND=agents/bin/vulkanus", "npx", "-y", "pi-acp@latest"] },
					oracle: { command: "env", args: ["PI_ACP_PI_COMMAND=agents/bin/oracle", "npx", "-y", "pi-acp@latest"] },
					argus: { command: "env", args: ["PI_ACP_PI_COMMAND=agents/bin/argus", "npx", "-y", "pi-acp@latest"] },
				},
			}),
		);

		const report = checkInstallPrerequisites({
			rootDir: tempRoot,
			env: {},
			pathEnv: "",
			isExecutable: () => true,
		});

		expect(report.ok).toBe(false);
		console.log(report.failures);
		expect(report.failures).toContain("placeholder packaged resources in agents/manifests: acpx-baseline.json");
	});

	test("baseline checks fail when packaged agent bin scripts are not executable", () => {
		const tempRoot = mkdtempSync(path.join(os.tmpdir(), "pantheon-install-check-"));
		mkdirSync(path.join(tempRoot, "src/extension"), { recursive: true });
		mkdirSync(path.join(tempRoot, "agents/prompts"), { recursive: true });
		mkdirSync(path.join(tempRoot, "agents/manifests"), { recursive: true });
		mkdirSync(path.join(tempRoot, "agents/bin"), { recursive: true });
		writeFileSync(path.join(tempRoot, "src/extension/index.ts"), "export default function extension() {}\n");
		writeFileSync(
			path.join(tempRoot, "package.json"),
			JSON.stringify({
				name: "pantheon-pi",
				version: "0.0.0-test",
				files: ["src/extension", "agents/prompts", "agents/manifests", "agents/bin", "package.json"],
				pi: { extensions: ["./src/extension/index.ts"], prompts: [] },
			}),
		);
		for (const agent of ["zeus", "vulkanus", "oracle", "argus"]) {
			writeFileSync(path.join(tempRoot, `agents/prompts/${agent}.md`), `# ${agent}\nReal role prompt\n`);
			writeFileSync(path.join(tempRoot, `agents/bin/${agent}`), '#!/bin/sh\nexec pi --system-prompt prompt "$@"\n');
		}
		writeFileSync(
			path.join(tempRoot, "agents/manifests/acpx-baseline.json"),
			JSON.stringify({
				agents: {
					zeus: { command: "env", args: ["PI_ACP_PI_COMMAND=agents/bin/zeus", "npx", "-y", "pi-acp@latest"] },
					vulkanus: { command: "env", args: ["PI_ACP_PI_COMMAND=agents/bin/vulkanus", "npx", "-y", "pi-acp@latest"] },
					oracle: { command: "env", args: ["PI_ACP_PI_COMMAND=agents/bin/oracle", "npx", "-y", "pi-acp@latest"] },
					argus: { command: "env", args: ["PI_ACP_PI_COMMAND=agents/bin/argus", "npx", "-y", "pi-acp@latest"] },
				},
			}),
		);

		const report = checkInstallPrerequisites({
			rootDir: tempRoot,
			env: {},
			pathEnv: "",
			isExecutable: () => true,
		});

		expect(report.ok).toBe(false);
		console.log(report.failures);
		expect(report.failures).toContain("placeholder packaged resources in agents/bin: argus, oracle, vulkanus, zeus");
	});

	test("baseline checks fail when prompts are stale OpenCode copies", () => {
		const tempRoot = mkdtempSync(path.join(os.tmpdir(), "pantheon-install-check-"));
		mkdirSync(path.join(tempRoot, "src/extension"), { recursive: true });
		mkdirSync(path.join(tempRoot, "agents/prompts"), { recursive: true });
		mkdirSync(path.join(tempRoot, "agents/manifests"), { recursive: true });
		mkdirSync(path.join(tempRoot, "agents/bin"), { recursive: true });
		writeFileSync(path.join(tempRoot, "src/extension/index.ts"), "export default function extension() {}\n");
		writeFileSync(
			path.join(tempRoot, "package.json"),
			JSON.stringify({
				name: "pantheon-pi",
				version: "0.0.0-test",
				files: ["src/extension", "agents/prompts", "agents/manifests", "agents/bin", "package.json"],
				pi: { extensions: ["./src/extension/index.ts"], prompts: [] },
			}),
		);
		for (const agent of ["zeus", "vulkanus", "oracle", "argus"]) {
			writeFileSync(path.join(tempRoot, `agents/prompts/${agent}.md`), `# ${agent}\nReal role prompt\n`);
			writeFileSync(path.join(tempRoot, `agents/bin/${agent}`), '#!/bin/sh\nexec pi --system-prompt prompt "$@"\n');
			chmodSync(path.join(tempRoot, `agents/bin/${agent}`), 0o755);
		}
		writeFileSync(
			path.join(tempRoot, "agents/prompts/oracle.md"),
			"Source: /Users/me/.config/opencode/agents/oracle.md\n",
		);
		writeFileSync(
			path.join(tempRoot, "agents/manifests/acpx-baseline.json"),
			JSON.stringify({
				agents: {
					zeus: { command: "env", args: ["PI_ACP_PI_COMMAND=agents/bin/zeus", "npx", "-y", "pi-acp@latest"] },
					vulkanus: { command: "env", args: ["PI_ACP_PI_COMMAND=agents/bin/vulkanus", "npx", "-y", "pi-acp@latest"] },
					oracle: { command: "env", args: ["PI_ACP_PI_COMMAND=agents/bin/oracle", "npx", "-y", "pi-acp@latest"] },
					argus: { command: "env", args: ["PI_ACP_PI_COMMAND=agents/bin/argus", "npx", "-y", "pi-acp@latest"] },
				},
			}),
		);

		const report = checkInstallPrerequisites({
			rootDir: tempRoot,
			env: {},
			pathEnv: "",
			isExecutable: () => true,
		});

		expect(report.ok).toBe(false);
		console.log(report.failures);
		expect(report.failures).toContain("placeholder packaged resources in agents/prompts: oracle.md");
	});
});
