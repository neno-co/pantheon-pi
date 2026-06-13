export type FindingType =
	| "missing-skill"
	| "stale-skill"
	| "ignored-skill"
	| "prompt-routing"
	| "specialist-contract"
	| "tool-affordance"
	| "validation-gap"
	| "cost-latency"
	| "silent-failure"
	| "flow-divergence"
	| "detour";

export type Severity = "critical" | "major" | "minor" | "info";

export type RecommendationKind = "regression" | "gap" | "smell" | "improvement";

export interface Finding {
	id: string;
	type: FindingType;
	severity: Severity;
	kind: RecommendationKind;
	description: string;
	evidence: string;
	repair: string;
}

export interface ReviewPacket {
	runId: string;
	agent: string;
	traceId: string | null;
	reviewedAt: string;
	findings: Finding[];
	repairsApplied: number;
	repairsUnverified: number;
}
