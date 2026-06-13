import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkInstallPrerequisites } from "../src/install-check/index.ts";

describe("Argus: install-check accepts out-of-tree PI_ACP_PI_COMMAND paths", () => {
	test("should reject manifest command overrides that resolve outside the package root", () => {
		const rootDir = mkdtempSync(path.join(os.tmpdir(), "pantheon-install-check-root-"));
		const outsideDir = mkdtempSync(path.join(os.tmpdir(), "pantheon-install-check-outside-"));
		const outsideBin = path.join(outsideDir, "zeus-bin");
		const traversalPath = path.relative(rootDir, outsideBin);

		mkdirSync(path.join(rootDir, "src/extension"), { recursive: true });
		mkdirSync(path.join(rootDir, "agents/manifests"), { recursive: true });
		writeFileSync(path.join(rootDir, "src/extension/index.ts"), "export default function extension() {}\n");
		writeFileSync(
			path.join(rootDir, "package.json"),
			JSON.stringify(
				{
					name: "pantheon-pi",
					version: "0.0.0-test",
					files: ["src/extension", "agents/prompts", "agents/manifests", "agents/bin", "package.json"],
					pi: { extensions: ["./src/extension/index.ts"], prompts: [] },
				},
				null,
				2,
			),
		);
		writeFileSync(outsideBin, "#!/bin/sh\necho outside\n");
		writeFileSync(
			path.join(rootDir, "agents/manifests/acpx-baseline.json"),
			JSON.stringify(
				{
					agents: {
						zeus: {
							command: "env",
							args: [`PI_ACP_PI_COMMAND=${traversalPath}`, "npx", "-y", "pi-acp@latest"],
						},
					},
				},
				null,
				2,
			),
		);

		const report = checkInstallPrerequisites({ rootDir, env: {}, pathEnv: "", isExecutable: () => true });

		expect(report.resources.manifests.placeholderFiles).toContain("acpx-baseline.json");
	});
});
