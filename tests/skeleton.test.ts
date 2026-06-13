import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();

const requiredPaths = [
	"package.json",
	".gitignore",
	"README.md",
	"src/extension/index.ts",
	"src/runner/index.ts",
	"src/langwatch/index.ts",
	"agents/manifests/README.md",
	"agents/prompts/README.md",
	"evals/datasets/README.md",
	"evals/scripts/run-evals.ts",
	".githooks/pre-commit",
];

describe("pantheon-pi skeleton", () => {
	test("required files exist", () => {
		for (const relativePath of requiredPaths) {
			expect(existsSync(path.join(root, relativePath))).toBe(true);
		}
	});

	test("package manifest and scripts are configured", () => {
		const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

		expect(packageJson.name).toBe("pantheon-pi");
		expect(packageJson.pi).toBeDefined();
		expect(packageJson.pi.extensions).toContain("./src/extension/index.ts");
		expect(packageJson.peerDependencies).toMatchObject({
			"@earendil-works/pi-coding-agent": "*",
			"@earendil-works/pi-tui": "*",
			"@earendil-works/pi-ai": "*",
			typebox: "*",
		});
		expect(packageJson.scripts).toMatchObject({
			lint: expect.any(String),
			test: expect.any(String),
			validate: expect.any(String),
		});
	});
});
