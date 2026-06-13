import { describe, expect, test } from "bun:test";
import type { Finding, FindingType, ReviewPacket, Severity } from "../src/meta-reviewer/index.ts";

const FINDING_TYPES: FindingType[] = [
	"missing-skill",
	"stale-skill",
	"ignored-skill",
	"prompt-routing",
	"specialist-contract",
	"tool-affordance",
	"validation-gap",
	"cost-latency",
	"silent-failure",
	"flow-divergence",
	"detour",
];

const SEVERITIES: Severity[] = ["critical", "major", "minor", "info"];

describe("meta-reviewer types", () => {
	test("FindingType covers all 11 taxonomy values", () => {
		expect(FINDING_TYPES).toHaveLength(11);
		// Ensure no duplicates
		expect(new Set(FINDING_TYPES).size).toBe(11);
	});

	test("Severity covers all 4 tiers", () => {
		expect(SEVERITIES).toHaveLength(4);
	});

	test("Finding interface is structurally valid", () => {
		const finding: Finding = {
			id: "f001",
			type: "prompt-routing",
			severity: "major",
			kind: "gap",
			description: "Prompt missing worktree guard instruction",
			evidence: "trace-abc:45-67",
			repair: "Add worktree guard to agents/prompts/vulkanus.md",
		};
		expect(finding.id).toBe("f001");
		expect(finding.type).toBe("prompt-routing");
		expect(finding.severity).toBe("major");
		expect(finding.kind).toBe("gap");
	});

	test("ReviewPacket interface is structurally valid", () => {
		const packet: ReviewPacket = {
			runId: "run-001",
			agent: "vulkanus",
			traceId: "trace-abc-123",
			reviewedAt: "2026-06-05T00:00:00Z",
			findings: [],
			repairsApplied: 0,
			repairsUnverified: 0,
		};
		expect(packet.runId).toBe("run-001");
		expect(packet.traceId).toBe("trace-abc-123");
		expect(packet.findings).toHaveLength(0);
	});

	test("ReviewPacket allows null traceId when no real trace available", () => {
		const packet: ReviewPacket = {
			runId: "fixture-run",
			agent: "zeus",
			traceId: null,
			reviewedAt: "2026-06-05T00:00:00Z",
			findings: [],
			repairsApplied: 0,
			repairsUnverified: 0,
		};
		expect(packet.traceId).toBeNull();
	});
});
