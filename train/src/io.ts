// Filesystem + shell helpers. Thin wrappers over node:fs / node:child_process so
// the rest of the orchestrator reads cleanly and so the Deno-era APIs have one
// place to live now that we run on Bun/Node.

import { spawnSync } from "node:child_process";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import type { z } from "zod";

export async function readJson<S extends z.ZodTypeAny>(path: string, schema: S): Promise<z.output<S>> {
	const text = await readFile(path, "utf8");
	return schema.parse(JSON.parse(text));
}

export async function writeJson(path: string, value: unknown): Promise<void> {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function appendText(path: string, text: string): Promise<void> {
	await appendFile(path, text);
}

export async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
}

export async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

export type ShellResult = { success: boolean; code: number; stdout: string; stderr: string };

// Run a command through a login shell, mirroring the original orchestrator's
// `zsh -lc` contract (so the user's PATH, deno, gh, etc. are all in scope).
// `inherit` streams to the parent terminal (used for the worktree setup step);
// otherwise stdout/stderr are captured and returned.
export function runShell(cmd: string, opts: { cwd?: string; inherit?: boolean } = {}): ShellResult {
	const result = spawnSync("zsh", ["-lc", cmd], {
		cwd: opts.cwd,
		stdio: opts.inherit ? "inherit" : "pipe",
		encoding: "utf8",
	});
	return {
		success: result.status === 0,
		code: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}
