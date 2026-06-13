import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import { listTextFiles } from "./shared.ts";

export type StructuralMatch = {
	path: string;
	line: number;
	column: number;
	match: string;
	captures: Record<string, string>;
};

const AST_GREP_LANGUAGES = new Map<string, Lang>([
	[".ts", Lang.TypeScript],
	[".mts", Lang.TypeScript],
	[".cts", Lang.TypeScript],
	[".tsx", Lang.Tsx],
	[".jsx", Lang.Tsx],
	[".js", Lang.JavaScript],
	[".css", Lang.Css],
	[".html", Lang.Html],
]);

function applyRewrite(template: string, captures: Record<string, string>) {
	return template.replace(/\$([A-Z][A-Z0-9_]*)/g, (_match, name: string) => captures[name] ?? "");
}

function getMetavariables(...templates: string[]) {
	return [
		...new Set(
			templates.flatMap((template) => [...template.matchAll(/\$([A-Z][A-Z0-9_]*)/g)].map((match) => match[1])),
		),
	];
}

export async function structuralSearch(input: { cwd: string; paths: string[]; pattern: string }) {
	const metavariables = getMetavariables(input.pattern);
	const results: StructuralMatch[] = [];
	for (const filePath of listTextFiles(input.cwd, input.paths)) {
		const lang = AST_GREP_LANGUAGES.get(path.extname(filePath));
		if (!lang) continue;
		const content = await readFile(filePath, "utf8");
		const root = parse(lang, content);
		for (const node of root.root().findAll(input.pattern)) {
			const captureValues: Record<string, string> = {};
			metavariables.forEach((name) => {
				const capture = node.getMatch(name);
				if (capture) captureValues[name] = capture.text();
			});
			const range = node.range();
			results.push({
				path: path.relative(input.cwd, filePath),
				line: range.start.line + 1,
				column: range.start.column + 1,
				match: node.text(),
				captures: captureValues,
			});
		}
	}
	return results;
}

export async function structuralReplace(input: {
	cwd: string;
	paths: string[];
	pattern: string;
	rewrite: string;
	dryRun?: boolean;
}) {
	const metavariables = getMetavariables(input.pattern, input.rewrite);
	const changedFiles: Array<{ path: string; replacements: number; preview: string }> = [];
	for (const filePath of listTextFiles(input.cwd, input.paths)) {
		const lang = AST_GREP_LANGUAGES.get(path.extname(filePath));
		if (!lang) continue;
		const content = await readFile(filePath, "utf8");
		const root = parse(lang, content);
		const edits = root
			.root()
			.findAll(input.pattern)
			.map((node) => {
				const captureValues: Record<string, string> = {};
				metavariables.forEach((name) => {
					const capture = node.getMatch(name);
					if (capture) captureValues[name] = capture.text();
				});
				const replacement = applyRewrite(input.rewrite, captureValues);
				return replacement ? node.replace(replacement) : undefined;
			})
			.filter((edit) => edit !== undefined);
		if (edits.length === 0) continue;
		const next = root.root().commitEdits(edits);
		if (!input.dryRun) await writeFile(filePath, next);
		changedFiles.push({ path: path.relative(input.cwd, filePath), replacements: edits.length, preview: next });
	}
	return { changedFiles, dryRun: input.dryRun !== false };
}
