// Worktree preparation for the implement stage. Each ticket is implemented in
// its own git worktree forked from origin/<base>, so concurrent tickets never
// share a working tree. The actual creation command is configurable per project
// (state.worktreeSetup) — the default targets monorepo-core's
// scripts/setup-worktree.ts, but any repo can supply its own, or set it to null
// to skip worktree creation and run stages in the repo root.

import { join } from "node:path";
import { pathExists, runShell } from "./io.ts";

type Log = (line: string) => void;

// Resolve the true git top-level for the configured repo path. Falls back to the
// given path if it is not inside a git repo (the SDK session will then surface
// the real error).
export function resolveRepoRoot(repoPath: string): string {
	const probe = runShell("git rev-parse --show-toplevel", { cwd: repoPath });
	const top = probe.stdout.trim();
	return probe.success && top ? top : repoPath;
}

// PRs can only target a base that exists on origin; otherwise `gh pr create`
// silently falls back to the repo default branch (main). Fail fast and loud.
export function assertBaseOnOrigin(repoRoot: string, base: string): void {
	const onOrigin = runShell(`git ls-remote --heads origin ${base} | grep -q .`, { cwd: repoRoot });
	if (!onOrigin.success) {
		throw new Error(
			`Base branch "${base}" is not on origin, so PRs would target main. Push it first: git push -u origin ${base}`,
		);
	}
}

export function worktreePathFor(repoRoot: string, branch: string): string {
	return join(repoRoot, "..", branch);
}

// Substitute {branch} and {base} into the configured setup command template.
export function renderWorktreeSetup(template: string, branch: string, base: string): string {
	return template.replaceAll("{branch}", branch).replaceAll("{base}", base);
}

// Ensure a usable worktree exists for the branch. Returns the worktree path, or
// the repo root if worktree creation is disabled (setupTemplate === null).
// Idempotent: an existing valid worktree is reused; an existing path that is not
// a git worktree is a hard error.
export async function prepareWorktree(opts: {
	repoRoot: string;
	branch: string;
	base: string;
	setupTemplate: string | null;
	dryRun: boolean;
	log: Log;
}): Promise<string> {
	const { repoRoot, branch, base, setupTemplate, dryRun, log } = opts;
	if (setupTemplate === null) {
		log("Worktree setup disabled (worktreeSetup=null); running stage in repo root.");
		return repoRoot;
	}

	const target = worktreePathFor(repoRoot, branch);

	// Preflight: git present, origin reachable, base ref resolvable (local or
	// origin). Refreshing refs here means new tickets fork from the latest base
	// as earlier tickets merge on the remote.
	const preflight =
		"command -v git >/dev/null && " +
		"git fetch --prune origin && " +
		`(git rev-parse --verify ${base}^{commit} >/dev/null 2>&1 || git rev-parse --verify origin/${base}^{commit} >/dev/null 2>&1)`;
	log("Implement preflight checks...");
	if (!dryRun) {
		const ok = runShell(preflight, { cwd: repoRoot });
		if (!ok.success) {
			throw new Error(
				`implement preflight failed (git missing, fetch failed, or base ref ${base} not found), code ${ok.code}`,
			);
		}
	}

	if (await pathExists(target)) {
		const verify = dryRun
			? { success: true }
			: runShell(`git -C "${target}" rev-parse --is-inside-work-tree >/dev/null 2>&1`, { cwd: repoRoot });
		if (!verify.success) throw new Error(`existing worktree path is not a valid git worktree: ${target}`);
		log(`Implement pre-step: existing worktree detected, skipping setup (${target})`);
		return target;
	}

	const setupCmd = renderWorktreeSetup(setupTemplate, branch, base);
	log(`Implement pre-step: ${setupCmd}`);
	if (!dryRun) {
		const setup = runShell(setupCmd, { cwd: repoRoot, inherit: true });
		if (!setup.success) throw new Error(`worktree setup pre-step failed with code ${setup.code}`);
	}
	return target;
}
