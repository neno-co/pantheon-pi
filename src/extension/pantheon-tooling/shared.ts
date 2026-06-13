import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".css", ".html"]);

export function resolveInsideCwd(cwd: string, requestedPath: string) {
	const root = path.resolve(cwd);
	const resolved = path.resolve(root, requestedPath);
	if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
		throw new Error(`Path escapes cwd: ${requestedPath}`);
	}
	return resolved;
}

export function listTextFiles(root: string, entries: string[]): string[] {
	const files: string[] = [];
	for (const entry of entries) {
		const absolute = resolveInsideCwd(root, entry);
		if (!existsSync(absolute)) continue;
		const stat = statSync(absolute);
		const dirEntries = stat.isDirectory() ? readdirIfDirectory(absolute) : undefined;
		if (dirEntries) {
			files.push(
				...listTextFiles(
					root,
					dirEntries.map((child) => path.relative(root, path.join(absolute, child))),
				),
			);
			continue;
		}
		if (TEXT_EXTENSIONS.has(path.extname(absolute))) files.push(absolute);
	}
	return files;
}

function readdirIfDirectory(absolute: string) {
	try {
		return readdirSync(absolute, { withFileTypes: true })
			.filter((entry) => !entry.name.startsWith("."))
			.map((entry) => entry.name);
	} catch {
		return undefined;
	}
}
