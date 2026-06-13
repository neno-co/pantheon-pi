export const PANTHEON_AGENTS = [
	"argus",
	"athena",
	"codebase-analyzer",
	"codebase-locator",
	"codebase-pattern-finder",
	"dike",
	"document-writer",
	"explore",
	"frontend-engineer",
	"hunter-code-review",
	"hunter-comments",
	"hunter-security",
	"hunter-silent-failure",
	"hunter-simplifier",
	"hunter-test-coverage",
	"hunter-type-design",
	"librarian",
	"meta-reviewer",
	"mnemosyne",
	"nemotron",
	"oracle",
	"prometheus",
	"thoughts-analyzer",
	"thoughts-locator",
	"translator",
	"vulkanus",
	"zeus",
] as const;

export type PantheonAgent = (typeof PANTHEON_AGENTS)[number];

export function isPantheonAgent(value: string): value is PantheonAgent {
	return (PANTHEON_AGENTS as readonly string[]).includes(value);
}

export function formatPantheonAgentList() {
	return PANTHEON_AGENTS.join(", ");
}

export const DEFAULT_ACPX_TIMEOUT_SECONDS = 300;
export const ORACLE_DEFAULT_TIMEOUT_SECONDS = 600;

export type PantheonAgentBackend =
	| { kind: "pi-acp-packaged" }
	| { kind: "claude-agent-acp"; promptFile: PantheonAgent };

export type PantheonAgentPermissionPolicy = "deny-all" | "approve-reads" | "approve-all";

export interface PantheonAgentConfig {
	agent: PantheonAgent;
	backend: PantheonAgentBackend;
	model: string;
	promptFile: PantheonAgent;
	defaultTimeoutSeconds?: number;
	permissions?: PantheonAgentPermissionPolicy;
}

/** acpx selector command for the Claude Code ACP adapter. */
export const CLAUDE_AGENT_ACP_COMMAND = "npx -y @agentclientprotocol/claude-agent-acp@latest";

function piAgent(agent: PantheonAgent, model: string): PantheonAgentConfig {
	return { agent, backend: { kind: "pi-acp-packaged" }, model, promptFile: agent };
}

function claudeAgent(agent: PantheonAgent, model: string, defaultTimeoutSeconds?: number): PantheonAgentConfig {
	// Runtime source of truth: manifest defaultPermissions mirrors this but is not consulted by the runner.
	return {
		agent,
		backend: { kind: "claude-agent-acp", promptFile: agent },
		model,
		promptFile: agent,
		defaultTimeoutSeconds,
		permissions: "approve-all",
	};
}

/**
 * Versioned, agent-level runtime configuration.
 *
 * AHE treats the prompt, tools, skills, backend, and model as one versioned
 * agent surface. Keep models here at the agent level rather than hidden in
 * launchers or inferred from host defaults. The manifest mirrors this table for
 * packaged visibility, but this module is the runtime source of truth.
 *
 * Models mirror ihorkatkov/pantheon .opencode/agents where the agent exists,
 * with Pantheon-Pi overrides for Zeus, Vulkanus, Oracle, and Argus.
 */
const AGENT_CONFIGS: Record<PantheonAgent, PantheonAgentConfig> = {
	argus: claudeAgent("argus", "claude-opus-4-8"),
	athena: piAgent("athena", "openai-codex/gpt-5.5"),
	"codebase-analyzer": claudeAgent("codebase-analyzer", "claude-sonnet-4-6"),
	"codebase-locator": piAgent("codebase-locator", "google/gemini-3-flash-preview"),
	"codebase-pattern-finder": piAgent("codebase-pattern-finder", "google/gemini-3-flash-preview"),
	dike: claudeAgent("dike", "claude-opus-4-8"),
	"document-writer": claudeAgent("document-writer", "claude-sonnet-4-5"),
	explore: claudeAgent("explore", "claude-sonnet-4-6"),
	"frontend-engineer": piAgent("frontend-engineer", "google/gemini-3.1-pro-preview-customtools"),
	"hunter-code-review": piAgent("hunter-code-review", "google/gemini-3.1-pro-preview-customtools"),
	"hunter-comments": piAgent("hunter-comments", "google/gemini-3.1-pro-preview-customtools"),
	"hunter-security": piAgent("hunter-security", "google/gemini-3.1-pro-preview-customtools"),
	"hunter-silent-failure": piAgent("hunter-silent-failure", "google/gemini-3.1-pro-preview-customtools"),
	"hunter-simplifier": piAgent("hunter-simplifier", "google/gemini-3.1-pro-preview-customtools"),
	"hunter-test-coverage": piAgent("hunter-test-coverage", "google/gemini-3.1-pro-preview-customtools"),
	"hunter-type-design": piAgent("hunter-type-design", "google/gemini-3.1-pro-preview-customtools"),
	librarian: claudeAgent("librarian", "claude-sonnet-4-6"),
	"meta-reviewer": claudeAgent("meta-reviewer", "claude-opus-4-8", 900),
	mnemosyne: claudeAgent("mnemosyne", "claude-opus-4-5"),
	nemotron: piAgent("nemotron", "nebius/nvidia/nemotron-3-super-120b-a12b"),
	oracle: claudeAgent("oracle", "claude-opus-4-8", ORACLE_DEFAULT_TIMEOUT_SECONDS),
	prometheus: claudeAgent("prometheus", "claude-opus-4-6"),
	"thoughts-analyzer": claudeAgent("thoughts-analyzer", "claude-sonnet-4-6"),
	"thoughts-locator": piAgent("thoughts-locator", "google/gemini-3-flash-preview"),
	translator: claudeAgent("translator", "claude-sonnet-4-6"),
	vulkanus: claudeAgent("vulkanus", "claude-sonnet-4-6"),
	zeus: piAgent("zeus", "openai-codex/gpt-5.5"),
};

export function getAgentConfig(agent: PantheonAgent): PantheonAgentConfig {
	return AGENT_CONFIGS[agent];
}

export function getAcpxBackend(agent: string):
	| { kind: "pi-acp-packaged"; model?: string; promptFile?: PantheonAgent; defaultTimeoutSeconds?: number }
	| {
			kind: "claude-agent-acp";
			model: string;
			promptFile: PantheonAgent;
			defaultTimeoutSeconds?: number;
			permissions?: PantheonAgentPermissionPolicy;
	  } {
	if (!isPantheonAgent(agent)) return { kind: "pi-acp-packaged" };
	const config = getAgentConfig(agent);
	if (config.backend.kind === "claude-agent-acp") {
		return {
			kind: "claude-agent-acp",
			model: config.model,
			promptFile: config.backend.promptFile,
			defaultTimeoutSeconds: config.defaultTimeoutSeconds,
			permissions: config.permissions,
		};
	}
	return {
		kind: "pi-acp-packaged",
		model: config.model,
		promptFile: config.promptFile,
		defaultTimeoutSeconds: config.defaultTimeoutSeconds,
	};
}
