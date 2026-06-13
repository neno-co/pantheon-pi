import { randomUUID } from "node:crypto";
import { DEFAULT_LANGWATCH_ENDPOINT, initLangWatchRuntime, parseLangWatchConfig } from "../src/langwatch/index.ts";
import { fetchLangWatchTraceDetail, fetchLangWatchTracePages } from "../src/telemetry/ingest/index.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function readArg(name: string) {
	const prefix = `--${name}=`;
	return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasProbeTag(value: unknown, probeTag: string): boolean {
	if (typeof value === "string") return value.includes(probeTag);
	if (Array.isArray(value)) return value.some((item) => hasProbeTag(item, probeTag));
	if (value && typeof value === "object") return Object.values(value).some((item) => hasProbeTag(item, probeTag));
	return false;
}

function traceIdFrom(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	for (const key of ["trace_id", "traceId", "id"]) {
		const raw = record[key];
		if (typeof raw === "string" && /^[a-f0-9]{32}$/i.test(raw)) return raw;
	}
	return undefined;
}

const env = process.env as Record<string, string | undefined>;
const config = parseLangWatchConfig(env);
const endpoint = readArg("endpoint") ?? config.endpoint ?? DEFAULT_LANGWATCH_ENDPOINT;
const apiKey = config.apiKey;

if (!apiKey) {
	console.error("LANGWATCH_API_KEY is required for live probe (secret not printed).");
	process.exit(2);
}

const probeTag = `pantheon-pi-live-probe-${Date.now()}-${randomUUID()}`;
const startedAt = Date.now();
const runtime = await initLangWatchRuntime({ ...config, endpoint });
if (!runtime) {
	console.error("LangWatch runtime did not initialize; check LANGWATCH_API_KEY (secret not printed).");
	process.exit(2);
}

const span = runtime.startSpan("pantheon.langwatch.live_probe", {
	"langwatch.span.type": "span",
	"langwatch.input": `LangWatch live export probe ${probeTag}`,
	"langwatch.output": probeTag,
	"pantheon.event": "langwatch_live_probe",
	"pantheon.agent": "vulkanus",
	"pantheon.probe_tag": probeTag,
	"pantheon.run.success": true,
});
span.end();
const traceId = span.spanContext().traceId;
let flushTimeout: Timer | undefined;
const flushResult = await Promise.race([
	runtime.forceFlush().then(() => "completed" as const),
	new Promise<"timeout">((resolve) => {
		flushTimeout = setTimeout(() => resolve("timeout"), 5000);
	}),
]);
if (flushTimeout) clearTimeout(flushTimeout);

const warnings: string[] = [];
let otlpStatus: number | undefined;
let otlpStatusText: string | undefined;
let otlpResponsePreview: string | undefined;
try {
	const response = await fetch(`${endpoint.replace(/\/+$/, "")}/api/otel/v1/traces`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"X-Auth-Token": apiKey,
			"Content-Type": "application/x-protobuf",
		},
		body: new Uint8Array(),
	});
	otlpStatus = response.status;
	otlpStatusText = response.statusText;
	otlpResponsePreview = (await response.text()).slice(0, 160);
} catch (error) {
	warnings.push(`otlp endpoint probe failed: ${error instanceof Error ? error.message : String(error)}`);
}

let found = false;
let foundVia = "";
let matchingTraceId: string | undefined;

for (let attempt = 1; attempt <= 6 && !found; attempt++) {
	await sleep(attempt === 1 ? 1000 : 3000);
	const detail = await fetchLangWatchTraceDetail({ apiKey, endpoint, traceId });
	if (detail.warning) warnings.push(`attempt ${attempt} detail: ${detail.warning}`);
	if (detail.detail && hasProbeTag(detail.detail, probeTag)) {
		found = true;
		foundVia = "trace-detail";
		matchingTraceId = traceId;
		break;
	}

	const { pages, warnings: pageWarnings } = await fetchLangWatchTracePages({
		apiKey,
		endpoint,
		startDate: startedAt - 5 * 60 * 1000,
		endDate: Date.now() + 60 * 1000,
		pageSize: 100,
	});
	warnings.push(...pageWarnings.map((warning) => `attempt ${attempt} search: ${warning}`));
	const trace = pages.flatMap((page) => page.traces).find((candidate) => hasProbeTag(candidate, probeTag));
	if (trace) {
		found = true;
		foundVia = "trace-search";
		matchingTraceId = traceIdFrom(trace) ?? traceId;
	}
}

const uniqueWarnings = [...new Set(warnings)].slice(-10);
console.log(
	JSON.stringify(
		{
			ok: found,
			probeTag,
			traceId,
			flushResult,
			matchingTraceId,
			foundVia: foundVia || undefined,
			endpoint,
			otlpEndpointProbe: otlpStatus
				? { status: otlpStatus, statusText: otlpStatusText, bodyPreview: otlpResponsePreview }
				: undefined,
			warnings: uniqueWarnings,
		},
		null,
		2,
	),
);

process.exit(found ? 0 : 1);
