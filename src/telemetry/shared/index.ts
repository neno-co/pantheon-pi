import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export const TELEMETRY_SCHEMA_VERSION = 1;

export function nowIso() {
	return new Date().toISOString();
}

export function homeDirFromEnv(env: Record<string, string | undefined> = process.env) {
	return env.HOME ?? os.homedir();
}

export function defaultTelemetryDbPath(env: Record<string, string | undefined> = process.env) {
	return env.PANTHEON_TELEMETRY_DB ?? path.join(homeDirFromEnv(env), ".pantheon", "telemetry.db");
}

export function defaultTelemetryStateDir(homeDir = homeDirFromEnv()) {
	return path.join(homeDir, ".pantheon", "telemetry");
}

export function defaultTelemetryLockPath(env: Record<string, string | undefined> = process.env, homeDir?: string) {
	return path.join(defaultTelemetryStateDir(homeDir ?? homeDirFromEnv(env)), "ingest.lock");
}

export function defaultPiSessionDir(homeDir = os.homedir()) {
	return path.join(homeDir, ".pi", "agent", "sessions");
}

export function defaultAcpxSessionDir(homeDir = os.homedir()) {
	return path.join(homeDir, ".acpx", "sessions");
}

export function sha256(value: string | Buffer) {
	return createHash("sha256").update(value).digest("hex");
}

export function redactForTelemetry(value: string) {
	return value
		.replace(/(sk-[A-Za-z0-9_-]{12,})/g, "[REDACTED]")
		.replace(/([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*=)[^\s]+/gi, "$1[REDACTED]");
}

export function previewForTelemetry(value: string) {
	return redactForTelemetry(value).slice(0, 256);
}

export function isContentStorageEnabled(env: Record<string, string | undefined> = process.env) {
	return env.PANTHEON_TELEMETRY_STORE_CONTENT === "true";
}

export function sinceIso(duration: string | undefined) {
	if (!duration) return undefined;
	const match = duration.match(/^(\d+)([hdm])$/);
	if (!match) return undefined;
	const amount = Number(match[1]);
	const unit = match[2];
	const millis =
		unit === "h" ? amount * 60 * 60 * 1000 : unit === "d" ? amount * 24 * 60 * 60 * 1000 : amount * 60 * 1000;
	return new Date(Date.now() - millis).toISOString();
}
