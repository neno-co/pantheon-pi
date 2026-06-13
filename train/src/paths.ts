// Project layout + resolution. Every project is a self-contained train with its
// own state file, question log, logs/ dir, and scratch files under
// <dataRoot>/projects/<slug>/, so several Linear projects can be in flight at
// once without clobbering each other.
//
// The data root defaults to train/.data (gitignored runtime state); override it
// with the TRAIN_HOME env var to keep train state anywhere you like.

import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { deriveSlug, slug } from "./core.ts";
import { ensureDir, pathExists, readJson, writeJson } from "./io.ts";

const PACKAGE_ROOT = dirname(import.meta.dirname);

export function dataRoot(): string {
	return process.env.TRAIN_HOME ? process.env.TRAIN_HOME : join(PACKAGE_ROOT, ".data");
}

function projectsDir(): string {
	return join(dataRoot(), "projects");
}

function activePath(): string {
	return join(dataRoot(), "active.json");
}

// Every per-run artifact a project owns. Resolved once per command and threaded
// through, so two projects never share a state file, question log, prompt
// scratch file, log dir, or lock.
export type ProjectPaths = {
	slug: string;
	dir: string;
	statePath: string;
	questionsPath: string;
	logDir: string;
	lastPromptPath: string;
	bootstrapQueuePath: string;
	lockPath: string;
};

export function pathsForDir(slug: string, dir: string, statePath: string): ProjectPaths {
	return {
		slug,
		dir,
		statePath,
		questionsPath: join(dir, "QUESTIONS.md"),
		logDir: join(dir, "logs"),
		lastPromptPath: join(dir, "last-prompt.txt"),
		bootstrapQueuePath: join(dir, ".bootstrap-queue.json"),
		lockPath: join(dir, ".lock"),
	};
}

export function projectPaths(projectSlug: string): ProjectPaths {
	const dir = join(projectsDir(), projectSlug);
	return pathsForDir(projectSlug, dir, join(dir, "state.json"));
}

const ActivePointerSchema = z.object({ slug: z.string() });

export async function readActiveSlug(): Promise<string | null> {
	try {
		const json = await readJson(activePath(), ActivePointerSchema);
		return json.slug || null;
	} catch {
		return null;
	}
}

export async function writeActiveSlug(targetSlug: string): Promise<void> {
	await ensureDir(dataRoot());
	await writeJson(activePath(), { slug: targetSlug });
}

// Resolve which project a command operates on. Precedence:
//   1. --state <path>  → explicit escape hatch; sibling artifacts derive from its dir.
//   2. --project <slug>
//   3. the active pointer (active.json)
// Errors if nothing resolves, so commands never silently target the wrong train.
export async function resolveProject(flags: Record<string, unknown>): Promise<ProjectPaths> {
	const stateFlag = flags.state ? String(flags.state) : "";
	if (stateFlag) {
		const dir = dirname(stateFlag);
		return pathsForDir(basename(dir), dir, stateFlag);
	}
	const target = (flags.project ? slug(String(flags.project)) : "") || (await readActiveSlug());
	if (!target) {
		throw new Error(
			"No project selected. Pass --project <slug>, set one with `train use <slug>`, or bootstrap one with `train bootstrap`. Run `train projects` to list.",
		);
	}
	return projectPaths(target);
}

// Decide which project a create command (init/bootstrap) writes to. An explicit
// --state or --project wins; otherwise the slug is derived from the queue's
// Linear project reference so each new project lands in its own projects/<slug>/.
export async function resolveProjectForCreate(flags: Record<string, unknown>, project: string): Promise<ProjectPaths> {
	if (flags.state) return resolveProject(flags);
	const target = (flags.project ? slug(String(flags.project)) : "") || deriveSlug(project) || "default";
	return projectPaths(target);
}

// Every project with a readable state file under projects/. Used by `projects`.
export async function listProjectPaths(): Promise<ProjectPaths[]> {
	const found: ProjectPaths[] = [];
	let entries: string[] = [];
	try {
		const dirents = await readdir(projectsDir(), { withFileTypes: true });
		entries = dirents.filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return found;
	}
	for (const name of entries) {
		const p = projectPaths(name);
		if (await pathExists(p.statePath)) found.push(p);
	}
	return found;
}
