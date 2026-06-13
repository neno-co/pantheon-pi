import { spawn } from "node:child_process";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@earendil-works/pi-coding-agent";

export async function runBoundedCommand(input: {
	command: string;
	cwd: string;
	timeoutSeconds?: number;
	maxBytes?: number;
	signal?: AbortSignal;
}) {
	const timeoutMs = Math.min(Math.max(input.timeoutSeconds ?? 30, 1), 300) * 1000;
	const maxBytes = Math.min(Math.max(input.maxBytes ?? DEFAULT_MAX_BYTES, 1024), 200_000);
	const result = await new Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>(
		(resolve, reject) => {
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			const proc = spawn("bash", ["-lc", input.command], {
				cwd: input.cwd,
				signal: input.signal,
			});
			const timer = setTimeout(() => {
				timedOut = true;
				proc.kill();
			}, timeoutMs);
			proc.stdout?.setEncoding("utf8");
			proc.stderr?.setEncoding("utf8");
			proc.stdout?.on("data", (chunk) => {
				stdout += chunk;
			});
			proc.stderr?.on("data", (chunk) => {
				stderr += chunk;
			});
			proc.on("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			proc.on("close", (code) => {
				clearTimeout(timer);
				resolve({ stdout, stderr, exitCode: code ?? 1, timedOut });
			});
		},
	);
	const out = truncateTail(result.stdout, { maxBytes, maxLines: DEFAULT_MAX_LINES });
	const err = truncateTail(result.stderr, { maxBytes, maxLines: DEFAULT_MAX_LINES });
	return {
		stdout: out.content,
		stderr: err.content,
		exitCode: result.timedOut ? 124 : result.exitCode,
		timedOut: result.timedOut,
		truncated: out.truncated || err.truncated,
	};
}
