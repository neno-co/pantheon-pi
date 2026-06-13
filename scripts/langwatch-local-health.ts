#!/usr/bin/env bun
const DEFAULT_LOCAL_LANGWATCH_ENDPOINT = "http://localhost:5560";

function readArg(name: string) {
	const prefix = `--${name}=`;
	return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function normalizeEndpoint(value: string) {
	return value.replace(/\/+$/, "");
}

const endpoint = normalizeEndpoint(readArg("endpoint") ?? DEFAULT_LOCAL_LANGWATCH_ENDPOINT);
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 5000);

try {
	const response = await fetch(endpoint, { signal: controller.signal });
	console.log(`Local LangWatch reachable at ${endpoint} (HTTP ${response.status}).`);
	if (endpoint !== DEFAULT_LOCAL_LANGWATCH_ENDPOINT) {
		console.log(`Using overridden endpoint; primary Pantheon-Pi dev endpoint is ${DEFAULT_LOCAL_LANGWATCH_ENDPOINT}.`);
	}
} catch (error) {
	const reason = error instanceof Error ? error.message : String(error);
	console.error(`Local LangWatch is not reachable at ${endpoint}: ${reason}`);
	console.error("Start the self-hosted LangWatch stack, or pass --endpoint=<local-url> if it is bound elsewhere.");
	process.exit(1);
} finally {
	clearTimeout(timeout);
}
