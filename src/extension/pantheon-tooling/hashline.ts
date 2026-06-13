import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolveInsideCwd } from "./shared.ts";

export type Hashline = {
	line: number;
	hash: string;
	text: string;
};

export type HashlineEdit = {
	line: number;
	expectedHash: string;
	newText: string;
};

export function hashLine(text: string) {
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export async function computeHashlines(filePath: string): Promise<Hashline[]> {
	const content = await readFile(filePath, "utf8");
	const lines = content.split(/\r?\n/);
	if (lines.at(-1) === "") lines.pop();
	return lines.map((text, index) => ({ line: index + 1, hash: hashLine(text), text }));
}

export async function applyHashlineEdit(input: { cwd: string; path: string; edits: HashlineEdit[] }) {
	const filePath = resolveInsideCwd(input.cwd, input.path);
	const content = await readFile(filePath, "utf8");
	const newline = content.includes("\r\n") ? "\r\n" : "\n";
	const hadFinalNewline = content.endsWith("\n");
	const lines = content.split(/\r?\n/);
	if (lines.at(-1) === "") lines.pop();

	const stale: Array<{ line: number; expectedHash: string; actualHash?: string; actualText?: string }> = [];
	for (const edit of input.edits) {
		const current = lines[edit.line - 1];
		const actualHash = current === undefined ? undefined : hashLine(current);
		if (actualHash !== edit.expectedHash) {
			stale.push({ line: edit.line, expectedHash: edit.expectedHash, actualHash, actualText: current });
		}
	}

	if (stale.length > 0) return { applied: false, stale };

	for (const edit of input.edits) lines[edit.line - 1] = edit.newText;
	await writeFile(filePath, `${lines.join(newline)}${hadFinalNewline ? newline : ""}`);
	return { applied: true, stale: [] };
}
