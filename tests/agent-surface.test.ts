import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getAgentConfig, PANTHEON_AGENTS } from "../src/agents.ts";

const root = process.cwd();
const baselinePath = path.join(root, "agents/manifests/acpx-baseline.json");
const evalDatasetPath = path.join(root, "evals/datasets/agent-quality-baseline.json");
const alignmentPath = path.join(root, "agents/prompts/ALIGNMENT.md");
const olympusSha = "f939230eb557c673de27c3de1845c784699bfad7";

function routableManifestAgents() {
	const manifest = JSON.parse(readFileSync(baselinePath, "utf8")) as {
		agents: Record<string, { defaultRoutable?: boolean; debugOnly?: boolean }>;
	};
	return Object.entries(manifest.agents)
		.filter(([, config]) => config.defaultRoutable !== false && config.debugOnly !== true)
		.map(([agent]) => agent)
		.sort();
}

function extensionAcpxAgents() {
	return [...PANTHEON_AGENTS].sort();
}

describe("manifest-authoritative agent surface", () => {
	test("extension acpx tool exposes exactly manifest-routable agents", () => {
		expect(extensionAcpxAgents()).toEqual(routableManifestAgents());
	});

	test("every routable Pantheon agent has an explicit configured model", () => {
		const manifest = JSON.parse(readFileSync(baselinePath, "utf8")) as {
			agents: Record<string, { kind: string; model?: string }>;
		};
		for (const agent of routableManifestAgents()) {
			const config = getAgentConfig(agent as (typeof PANTHEON_AGENTS)[number]);
			expect(config.model).toBeTruthy();
			expect(manifest.agents[agent].model).toBe(config.model);
			if (config.backend.kind === "pi-acp-packaged") expect(config.model).toContain("/");
		}
	});

	test("smoke eval dataset covers every manifest-routable agent", () => {
		const dataset = JSON.parse(readFileSync(evalDatasetPath, "utf8")) as { cases: Array<{ targetAgent: string }> };
		const covered = [...new Set(dataset.cases.map((testCase) => testCase.targetAgent))].sort();
		expect(covered).toEqual(routableManifestAgents());
	});

	test("prompt alignment matrix documents a non-gating historical baseline", () => {
		const alignment = readFileSync(alignmentPath, "utf8");
		expect(alignment).toContain(olympusSha);
		expect(alignment).toContain("historical baseline");
		expect(alignment).toContain("non-gating");
		expect(alignment).toContain("Pantheon-Pi prompts are canonical after import");
		expect(alignment).not.toMatch(/Alignment contract|Allowed Pi\/acpx deltas|\bAligned\b|preserve upstream/i);
		for (const agent of routableManifestAgents()) {
			expect(alignment).toContain(`\`${agent}.md\``);
			if (agent === "athena" || agent === "dike" || agent === "meta-reviewer")
				expect(alignment).toContain(`\`${agent}.md\` | No Olympus counterpart`);
			else expect(alignment).toContain(`.opencode/agents/${agent}.md`);
		}
		expect(alignment).toContain("`aether.md` | No Olympus counterpart | Local-only experimental prompt");
	});

	test("routable local prompts include Pi overlay and avoid ongoing Olympus parity language", () => {
		const staleRuntimePattern =
			/opencode serve|\.config\/opencode|CMUX_OPENCODE_SURFACE|OpenCode primary|OpenCode-primary|Source:\s*\/Users/i;
		const parityPattern = /Preserve the Olympus role contract|fully aligned with Olympus|Olympus parity|Olympus drift/i;
		for (const agent of routableManifestAgents()) {
			const prompt = readFileSync(path.join(root, "agents/prompts", `${agent}.md`), "utf8");
			expect(prompt).toStartWith("# Pantheon-Pi Packaged Agent Prompt\n\nThis prompt is maintained");
			expect(prompt).toContain("Pi/acpx Runtime Overlay");
			expect(prompt).toContain(olympusSha);
			expect(prompt).not.toMatch(staleRuntimePattern);
			expect(prompt).not.toMatch(parityPattern);
		}
	});

	test("README and SPEC present the public in-app subagents product surface", () => {
		const readme = readFileSync(path.join(root, "README.md"), "utf8");
		const spec = readFileSync(path.join(root, "SPEC.md"), "utf8");
		expect(readme).toContain("# In-App Subagents for Pi");
		expect(readme).toContain("Internal project-management data, generated reports, private research notes");
		expect(spec).toContain("# In-App Subagents Architecture");
		for (const document of [readme, spec]) {
			expect(document).not.toMatch(
				/Olympus parity|Olympus drift|fully aligned with Olympus|preserve upstream semantic role contracts/i,
			);
		}
	});
});
