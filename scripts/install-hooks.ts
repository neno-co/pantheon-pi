import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const source = path.join(".githooks", "pre-commit");
const destinationDir = path.join(".git", "hooks");
const destination = path.join(destinationDir, "pre-commit");

if (!existsSync(source)) {
	throw new Error(`Hook source not found: ${source}`);
}

mkdirSync(destinationDir, { recursive: true });
copyFileSync(source, destination);
chmodSync(destination, 0o755);

console.log(`Installed git hook: ${destination}`);
