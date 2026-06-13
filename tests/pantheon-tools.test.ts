import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	applyHashlineEdit,
	computeHashlines,
	runDiagnostics,
	structuralReplace,
	structuralSearch,
} from "../src/extension/pantheon-tooling/index.ts";

describe("hashline editing", () => {
	test("detects stale line hashes before applying edits", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pantheon-hashline-"));
		const file = path.join(dir, "sample.ts");
		writeFileSync(file, "const answer = 41\nconsole.log(answer)\n");
		const [first] = await computeHashlines(file);

		writeFileSync(file, "const answer = 42\nconsole.log(answer)\n");

		const result = await applyHashlineEdit({
			cwd: dir,
			path: "sample.ts",
			edits: [{ line: first.line, expectedHash: first.hash, newText: "const answer = 43" }],
		});

		expect(result.applied).toBe(false);
		expect(result.stale).toHaveLength(1);
		expect(readFileSync(file, "utf8")).toBe("const answer = 42\nconsole.log(answer)\n");
	});
});

describe("structural search/replace", () => {
	test("uses ast-grep syntax nodes instead of textual matching", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pantheon-structural-"));
		mkdirSync(path.join(dir, "src"));
		writeFileSync(
			path.join(dir, "src", "app.ts"),
			"const text = 'console.log(notCode)'\nconsole.log(answer)\nconsole.error('bad')\n",
		);

		const matches = await structuralSearch({ cwd: dir, paths: ["src/app.ts"], pattern: "console.log($ARG)" });
		expect(matches).toHaveLength(1);
		expect(matches[0]?.captures.ARG).toBe("answer");
		expect(matches[0]?.line).toBe(2);

		const replacement = await structuralReplace({
			cwd: dir,
			paths: ["src/app.ts"],
			pattern: "console.log($ARG)",
			rewrite: "logger.info($ARG)",
			dryRun: true,
		});

		expect(replacement.changedFiles).toHaveLength(1);
		expect(replacement.changedFiles[0]?.preview).toContain("logger.info(answer)");
		expect(replacement.changedFiles[0]?.preview).toContain("'console.log(notCode)'");
		expect(readFileSync(path.join(dir, "src", "app.ts"), "utf8")).toContain("console.log(answer)");
	});
});

describe("post-write diagnostics", () => {
	test("records command diagnostics metrics and fallback source by default", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pantheon-ts-diagnostics-"));
		const binDir = path.join(dir, "bin");
		mkdirSync(binDir);
		writeFileSync(path.join(dir, "sample.ts"), "const answer: number = 'bad'\n");
		writeFileSync(
			path.join(binDir, "bun"),
			"#!/usr/bin/env sh\nprintf 'error: Type string is not assignable to number\\n'\n",
		);
		chmodSync(path.join(binDir, "bun"), 0o755);

		const originalPath = process.env.PATH;
		const originalLsp = process.env.PANTHEON_EXPERIMENTAL_LSP;
		delete process.env.PANTHEON_EXPERIMENTAL_LSP;
		process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
		try {
			const result = await runDiagnostics(dir, "sample.ts", 1_000);
			expect(result.skipped).toBe(false);
			if (!result.skipped) {
				expect(result.source).toBe("command");
				expect(result.metrics.source).toBe("command");
				expect(result.metrics.path).toBe("sample.ts");
				expect(result.metrics.language).toBe("typescript");
				expect(result.metrics.diagnosticCount).toBe(1);
				expect(result.metrics.severities.error).toBe(1);
				expect(result.metrics.latencyMs).toBeGreaterThanOrEqual(0);
			}
		} finally {
			process.env.PATH = originalPath;
			process.env.PANTHEON_EXPERIMENTAL_LSP = originalLsp;
		}
	});

	test("uses experimental LSP adapter when explicitly enabled", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pantheon-lsp-diagnostics-"));
		const adapter = path.join(dir, "fake-lsp");
		writeFileSync(path.join(dir, "sample.ts"), "const answer: number = 'bad'\n");
		writeFileSync(adapter, '#!/usr/bin/env sh\nprintf \'[{"severity":"error","message":"fake lsp error"}]\'\n');
		chmodSync(adapter, 0o755);

		const originalLsp = process.env.PANTHEON_EXPERIMENTAL_LSP;
		const originalCommand = process.env.PANTHEON_EXPERIMENTAL_LSP_COMMAND;
		process.env.PANTHEON_EXPERIMENTAL_LSP = "1";
		process.env.PANTHEON_EXPERIMENTAL_LSP_COMMAND = adapter;
		try {
			const result = await runDiagnostics(dir, "sample.ts", 1_000);
			expect(result.skipped).toBe(false);
			if (!result.skipped) {
				expect(result.source).toBe("lsp");
				expect(result.metrics.source).toBe("lsp");
				expect(result.metrics.diagnosticCount).toBe(1);
				expect(result.metrics.severities.error).toBe(1);
				expect(result.diagnostics).toEqual([{ severity: "error", message: "fake lsp error" }]);
			}
		} finally {
			process.env.PANTHEON_EXPERIMENTAL_LSP = originalLsp;
			process.env.PANTHEON_EXPERIMENTAL_LSP_COMMAND = originalCommand;
		}
	});

	test("falls back to command diagnostics when experimental LSP is unavailable", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pantheon-lsp-fallback-"));
		const binDir = path.join(dir, "bin");
		mkdirSync(binDir);
		writeFileSync(path.join(dir, "sample.ts"), "const answer = 42\n");
		writeFileSync(path.join(binDir, "bun"), "#!/usr/bin/env sh\necho checked:$*\n");
		chmodSync(path.join(binDir, "bun"), 0o755);

		const originalPath = process.env.PATH;
		const originalLsp = process.env.PANTHEON_EXPERIMENTAL_LSP;
		const originalCommand = process.env.PANTHEON_EXPERIMENTAL_LSP_COMMAND;
		process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
		process.env.PANTHEON_EXPERIMENTAL_LSP = "1";
		delete process.env.PANTHEON_EXPERIMENTAL_LSP_COMMAND;
		try {
			const result = await runDiagnostics(dir, "sample.ts", 1_000);
			expect(result.skipped).toBe(false);
			if (!result.skipped) {
				expect(result.source).toBe("command");
				expect(result.metrics.fallbackReason).toContain("no supported direct diagnostics API is exposed");
			}
		} finally {
			process.env.PATH = originalPath;
			process.env.PANTHEON_EXPERIMENTAL_LSP = originalLsp;
			process.env.PANTHEON_EXPERIMENTAL_LSP_COMMAND = originalCommand;
		}
	});

	test("uses cargo check when Cargo.toml exists", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pantheon-rust-diagnostics-"));
		const binDir = path.join(dir, "bin");
		mkdirSync(binDir);
		writeFileSync(path.join(dir, "Cargo.toml"), '[package]\nname = "demo"\nversion = "0.1.0"\n');
		writeFileSync(path.join(binDir, "cargo"), "#!/usr/bin/env sh\necho cargo:$*\n");
		chmodSync(path.join(binDir, "cargo"), 0o755);

		const originalPath = process.env.PATH;
		process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
		try {
			const result = await runDiagnostics(dir, "src/lib.rs", 1_000);
			expect(result.skipped).toBe(false);
			if (!result.skipped) {
				expect(result.command).toBe("cargo check");
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain("cargo:check");
			}
		} finally {
			process.env.PATH = originalPath;
		}
	});

	test("uses mix compile with warnings as errors when mix.exs exists", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pantheon-elixir-diagnostics-"));
		const binDir = path.join(dir, "bin");
		mkdirSync(binDir);
		writeFileSync(path.join(dir, "mix.exs"), "defmodule Demo.MixProject do\nend\n");
		writeFileSync(path.join(binDir, "mix"), "#!/usr/bin/env sh\necho mix:$*\n");
		chmodSync(path.join(binDir, "mix"), 0o755);

		const originalPath = process.env.PATH;
		process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
		try {
			const result = await runDiagnostics(dir, "lib/demo.ex", 1_000);
			expect(result.skipped).toBe(false);
			if (!result.skipped) {
				expect(result.command).toBe("mix compile --warnings-as-errors");
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain("mix:compile --warnings-as-errors");
			}
		} finally {
			process.env.PATH = originalPath;
		}
	});
});
