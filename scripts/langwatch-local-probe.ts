#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";

const LOCAL_ENV_FILE = ".env.langwatch.local";
const LOCAL_LANGWATCH_ENDPOINT = "http://localhost:5560";
const PLACEHOLDER_KEY = "replace-with-local-langwatch-api-key";

function parseLocalEnvFile(path: string) {
	const values = new Map<string, string>();
	for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const separator = line.indexOf("=");
		if (separator === -1) continue;
		const key = line.slice(0, separator).trim();
		let value = line.slice(separator + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		values.set(key, value);
	}
	return values;
}

if (!existsSync(LOCAL_ENV_FILE)) {
	console.error(`${LOCAL_ENV_FILE} is required for local LangWatch probing.`);
	console.error(`Copy .env.langwatch.local.example to ${LOCAL_ENV_FILE} and fill in your local key.`);
	process.exit(2);
}

const localEnv = parseLocalEnvFile(LOCAL_ENV_FILE);
const apiKey = localEnv.get("LANGWATCH_API_KEY")?.trim();
if (!apiKey || apiKey === PLACEHOLDER_KEY) {
	console.error(`${LOCAL_ENV_FILE} must define a real local LANGWATCH_API_KEY (secret not printed).`);
	process.exit(2);
}

process.env.LANGWATCH_API_KEY = apiKey;
process.env.LANGWATCH_ENDPOINT = localEnv.get("LANGWATCH_ENDPOINT")?.trim() || LOCAL_LANGWATCH_ENDPOINT;

if (process.env.LANGWATCH_ENDPOINT.replace(/\/+$/, "") !== LOCAL_LANGWATCH_ENDPOINT) {
	console.error(`${LOCAL_ENV_FILE} must point LANGWATCH_ENDPOINT at ${LOCAL_LANGWATCH_ENDPOINT} for the local probe.`);
	process.exit(2);
}

process.argv = [process.argv[0] ?? "bun", "scripts/langwatch-live-probe.ts", `--endpoint=${LOCAL_LANGWATCH_ENDPOINT}`];
await import("./langwatch-live-probe.ts");
