import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const installScript = path.join(process.cwd(), "install.sh");

describe("install.sh", () => {
	test("is packaged as the one-line Pantheon installer", () => {
		expect(existsSync(installScript)).toBe(true);
	});

	test("dry-run shows the install sequence without needing a checkout", () => {
		const result = spawnSync("bash", [installScript], {
			cwd: process.cwd(),
			env: {
				...process.env,
				PANTHEON_INSTALL_DRY_RUN: "1",
				PANTHEON_INSTALL_DIR: "/tmp/pantheon-pi-install-test",
				PANTHEON_REPO_URL: "https://example.invalid/pantheon-pi.git",
			},
			encoding: "utf8",
		});

		expect(result.status).toBe(0);
		const output = `${result.stdout}\n${result.stderr}`;
		expect(output).toContain("https://example.invalid/pantheon-pi.git");
		expect(output).toContain("git clone --depth 1");
		expect(output).toContain("bun install --cwd /tmp/pantheon-pi-install-test");
		expect(output).toContain("cd /tmp/pantheon-pi-install-test && pi install .");
		expect(output).toContain("cd /tmp/pantheon-pi-install-test && bun link");
		expect(output).toContain("cd /tmp/pantheon-pi-install-test && pantheon init");
		expect(output).toContain("Claude Code, OpenAI Codex, and Gemini are authenticated locally");
		expect(output).toContain("codex login");
	});
});
