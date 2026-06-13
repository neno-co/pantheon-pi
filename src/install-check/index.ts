import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { PANTHEON_AGENTS } from "../agents.ts";
import { DEFAULT_ACPX_BIN } from "../runner/index.ts";

type Env = Record<string, string | undefined>;
type ExecutableCheck = (candidate: string) => boolean;

export interface InstallCheckOptions {
	rootDir?: string;
	env?: Env;
	pathEnv?: string;
	requireAcpx?: boolean;
	isExecutable?: ExecutableCheck;
}

export interface ResourceCheck {
	path: string;
	exists: boolean;
	agentCount?: number;
	requiredAgentsMissing?: string[];
	placeholderFiles?: string[];
}

export interface AcpxCheck {
	required: boolean;
	found: boolean;
	path?: string;
	source?: "PANTHEON_ACPX_BIN" | "ACPX_BIN" | "homebrew" | "PATH";
	message: string;
}

export interface ManifestCheck {
	packageName?: string;
	version?: string;
	files: string[];
	piExtensions: string[];
	piPrompts: string[];
	piSkills: string[];
	optionalDependencies: string[];
	bin: Record<string, string>;
	failures: string[];
}

export interface InstallCheckReport {
	ok: boolean;
	rootDir: string;
	manifest: ManifestCheck;
	resources: {
		extensionEntrypoint: ResourceCheck;
		cliEntrypoint: ResourceCheck;
		telemetry: ResourceCheck;
		prompts: ResourceCheck;
		manifests: ResourceCheck;
		bin: ResourceCheck;
		skills: ResourceCheck;
	};
	acpx: AcpxCheck;
	failures: string[];
	warnings: string[];
}

const requiredDistributionFiles = [
	"src/extension",
	"src/agents.ts",
	"src/cli.ts",
	"src/workflow",
	"src/telemetry",
	"agents/prompts",
	"agents/manifests",
	"agents/bin",
	"package.json",
];
const requiredBinEntries: Record<string, string> = {
	pantheon: "./src/cli.ts",
};
const reservedAgentPromptTemplatePath = "agents/prompts";
const requiredPiSkills = ["./skills/pantheon-telemetry"];

const requiredPackagedAgents = [...PANTHEON_AGENTS];
const placeholderPattern = /\b(MVP status|scaffold only|TODO: migrate|placeholder prompts|scaffold \+ placeholder)\b/i;
const staleOpenCodePromptPattern =
	/(Source:\s*\/Users|\.config\/opencode|opencode serve|CMUX_OPENCODE_SURFACE|OpenCode primary|OpenCode-primary)/i;

function defaultIsExecutable(candidate: string) {
	try {
		accessSync(candidate, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function normalizeFiles(value: unknown) {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function includesFile(files: string[], required: string) {
	return files.some((entry) => entry === required || entry === `${required}/` || required.startsWith(`${entry}/`));
}

function normalizeResourcePath(entry: string) {
	return entry.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export function validatePackageManifest(manifest: unknown): ManifestCheck {
	const record = typeof manifest === "object" && manifest !== null ? (manifest as Record<string, unknown>) : {};
	const pi = typeof record.pi === "object" && record.pi !== null ? (record.pi as Record<string, unknown>) : {};
	const files = normalizeFiles(record.files);
	const piExtensions = normalizeFiles(pi.extensions);
	const piPrompts = normalizeFiles(pi.prompts);
	const piSkills = normalizeFiles(pi.skills);
	const optionalDependenciesRaw =
		typeof record.optionalDependencies === "object" && record.optionalDependencies !== null
			? (record.optionalDependencies as Record<string, unknown>)
			: {};
	const optionalDependencies = Object.keys(optionalDependenciesRaw);
	const binRaw = typeof record.bin === "object" && record.bin !== null ? (record.bin as Record<string, unknown>) : {};
	const bin: Record<string, string> = {};
	for (const [name, value] of Object.entries(binRaw)) {
		if (typeof value === "string") bin[name] = value;
	}
	const failures: string[] = [];

	if (record.name !== "pantheon-pi") failures.push("package.json name must be pantheon-pi");
	if (typeof record.version !== "string" || record.version.length === 0)
		failures.push("package.json version is required");
	if (files.length === 0) failures.push("package.json must define a files array for distribution");
	if (piSkills.length > 0 && !includesFile(files, "skills"))
		failures.push("package.json files must include skills when pi.skills are declared");
	for (const required of requiredDistributionFiles) {
		if (!includesFile(files, required)) failures.push(`package.json files must include ${required}`);
	}
	if (!piExtensions.includes("./src/extension/index.ts")) {
		failures.push("package.json pi.extensions must include ./src/extension/index.ts");
	}
	for (const required of requiredPiSkills) {
		if (!piSkills.includes(required)) failures.push(`package.json pi.skills must include ${required}`);
	}
	if (piPrompts.some((entry) => normalizeResourcePath(entry) === reservedAgentPromptTemplatePath)) {
		failures.push(
			"package.json pi.prompts must not include ./agents/prompts because packaged agent system prompts are not Pi prompt templates",
		);
	}
	for (const [name, expectedTarget] of Object.entries(requiredBinEntries)) {
		const actual = bin[name];
		if (!actual) {
			failures.push(`package.json bin must include ${name} -> ${expectedTarget}`);
			continue;
		}
		if (normalizeResourcePath(actual) !== normalizeResourcePath(expectedTarget)) {
			failures.push(`package.json bin.${name} must point to ${expectedTarget} (found ${actual})`);
		}
	}

	return {
		packageName: typeof record.name === "string" ? record.name : undefined,
		version: typeof record.version === "string" ? record.version : undefined,
		files,
		piExtensions,
		piPrompts,
		piSkills,
		optionalDependencies,
		bin,
		failures,
	};
}

export function findPathBinary(
	binaryName: string,
	pathEnv: string,
	isExecutable: ExecutableCheck = defaultIsExecutable,
) {
	if (!pathEnv) return undefined;
	const executableName = process.platform === "win32" ? `${binaryName}.cmd` : binaryName;
	for (const entry of pathEnv.split(path.delimiter).filter(Boolean)) {
		const candidate = path.join(entry, executableName);
		if (isExecutable(candidate)) return candidate;
	}
	return undefined;
}

function discoverAcpx(env: Env, pathEnv: string, isExecutable: ExecutableCheck, required: boolean): AcpxCheck {
	const configured = [
		["PANTHEON_ACPX_BIN", env.PANTHEON_ACPX_BIN],
		["ACPX_BIN", env.ACPX_BIN],
	] as const;

	for (const [source, candidate] of configured) {
		if (candidate && isExecutable(candidate)) {
			return { required, found: true, path: candidate, source, message: `found acpx via ${source}` };
		}
		if (candidate) {
			return {
				required,
				found: false,
				path: candidate,
				source,
				message: `${source} is set but is not executable: ${candidate}`,
			};
		}
	}

	if (isExecutable(DEFAULT_ACPX_BIN)) {
		return {
			required,
			found: true,
			path: DEFAULT_ACPX_BIN,
			source: "homebrew",
			message: "found acpx at Homebrew path",
		};
	}

	const pathCandidate = findPathBinary("acpx", pathEnv, isExecutable);
	if (pathCandidate)
		return { required, found: true, path: pathCandidate, source: "PATH", message: "found acpx on PATH" };

	return {
		required,
		found: false,
		message:
			"acpx was not found. Install acpx, add it to PATH, or set PANTHEON_ACPX_BIN/ACPX_BIN to an executable path.",
	};
}

function isInsideDirectory(candidatePath: string, directoryPath: string) {
	const relative = path.relative(directoryPath, candidatePath);
	return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isInsideOrEqualDirectory(candidatePath: string, directoryPath: string) {
	const relative = path.relative(directoryPath, candidatePath);
	return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resource(rootDir: string, relativePath: string): ResourceCheck {
	const absolutePath = path.join(rootDir, relativePath);
	const exists = existsSync(absolutePath);
	const placeholderFiles: string[] = [];
	if (exists) {
		try {
			if (
				lstatSync(absolutePath).isSymbolicLink() ||
				!isInsideDirectory(realpathSync(absolutePath), realpathSync(rootDir))
			) {
				placeholderFiles.push(relativePath);
			}
		} catch {
			placeholderFiles.push(relativePath);
		}
	}
	return { path: relativePath, exists, placeholderFiles };
}

function declaredPackageResource(rootDir: string, entry: string) {
	const normalized = normalizeResourcePath(entry);
	const absolutePath = path.resolve(rootDir, normalized);
	if (!normalized || normalized.startsWith("../") || path.isAbsolute(entry)) return "unsafe";
	if (!existsSync(absolutePath)) return "missing";
	try {
		const rootRealPath = realpathSync(rootDir);
		return isInsideOrEqualDirectory(realpathSync(absolutePath), rootRealPath) ? "ok" : "unsafe";
	} catch {
		return "unsafe";
	}
}

function packageNameFromNodeModulesEntry(entry: string) {
	const normalized = normalizeResourcePath(entry);
	const nodeModulesPrefix = "node_modules/";
	if (!normalized.startsWith(nodeModulesPrefix)) return undefined;
	const parts = normalized.slice(nodeModulesPrefix.length).split("/").filter(Boolean);
	if (parts.length === 0) return undefined;
	if (parts[0]?.startsWith("@")) return parts.length > 1 ? `${parts[0]}/${parts[1]}` : undefined;
	return parts[0];
}

function isOptionalDeclaredExtension(entry: string, manifest: ManifestCheck) {
	const packageName = packageNameFromNodeModulesEntry(entry);
	return packageName !== undefined && manifest.optionalDependencies.includes(packageName);
}

function promptResource(rootDir: string, relativePath: string): ResourceCheck {
	const absolutePath = path.join(rootDir, relativePath);
	const exists = existsSync(absolutePath);
	if (!exists) return { path: relativePath, exists, agentCount: 0, requiredAgentsMissing: requiredPackagedAgents };

	const files = readdirSync(absolutePath).filter((entry) => entry.endsWith(".md"));
	const names = new Set(files.map((entry) => entry.slice(0, -".md".length)));
	const realPromptsPath = realpathSync(absolutePath);
	const promptDirectoryEscapesRoot =
		lstatSync(absolutePath).isSymbolicLink() || !isInsideDirectory(realPromptsPath, realpathSync(rootDir));
	const placeholderFiles = files.filter((entry) => {
		const fullPath = path.join(absolutePath, entry);
		try {
			if (promptDirectoryEscapesRoot || lstatSync(fullPath).isSymbolicLink()) return true;
			if (!isInsideDirectory(realpathSync(fullPath), realPromptsPath)) return true;
			const raw = readFileSync(fullPath, "utf8");
			return placeholderPattern.test(raw) || staleOpenCodePromptPattern.test(raw);
		} catch {
			return true;
		}
	});

	return {
		path: relativePath,
		exists,
		agentCount: files.length,
		requiredAgentsMissing: requiredPackagedAgents.filter((agent) => !names.has(agent)),
		placeholderFiles,
	};
}

function manifestResource(rootDir: string, relativePath: string): ResourceCheck {
	const absolutePath = path.join(rootDir, relativePath);
	const exists = existsSync(absolutePath);
	if (!exists) return { path: relativePath, exists, agentCount: 0, requiredAgentsMissing: requiredPackagedAgents };

	const files = readdirSync(absolutePath).filter((entry) => entry.endsWith(".json"));
	const placeholderFiles = files.filter((entry) =>
		placeholderPattern.test(readFileSync(path.join(absolutePath, entry), "utf8")),
	);
	const names = new Set<string>();
	const unsafePattern = /(\/Users\/|\/home\/|API_KEY|TOKEN|SECRET|PASSWORD|\$\{PI_AGENT_DIR\}|acp-agents\/bin)/;
	for (const file of files) {
		try {
			const raw = readFileSync(path.join(absolutePath, file), "utf8");
			if (unsafePattern.test(raw)) placeholderFiles.push(file);
			const parsed = JSON.parse(raw);
			const agents =
				typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).agents : undefined;
			if (typeof agents === "object" && agents !== null) {
				for (const [agent, config] of Object.entries(agents)) {
					names.add(agent);
					const agentRecord = typeof config === "object" && config !== null ? (config as Record<string, unknown>) : {};
					const args = Array.isArray(agentRecord.args)
						? agentRecord.args.filter((entry): entry is string => typeof entry === "string")
						: [];
					const commandOverride = args.find((entry) => entry.startsWith("PI_ACP_PI_COMMAND="));
					if (commandOverride) {
						const commandPath = commandOverride.slice("PI_ACP_PI_COMMAND=".length);
						const candidatePath = path.resolve(rootDir, commandPath);
						if (!isInsideOrEqualDirectory(candidatePath, path.resolve(rootDir)) || !existsSync(candidatePath)) {
							placeholderFiles.push(file);
						}
					}
				}
			}
		} catch {
			placeholderFiles.push(file);
		}
	}

	return {
		path: relativePath,
		exists,
		agentCount: names.size,
		requiredAgentsMissing: requiredPackagedAgents.filter((agent) => !names.has(agent)),
		placeholderFiles: [...new Set(placeholderFiles)],
	};
}

function binResource(rootDir: string, relativePath: string): ResourceCheck {
	const absolutePath = path.join(rootDir, relativePath);
	const exists = existsSync(absolutePath);
	if (!exists) return { path: relativePath, exists, agentCount: 0, requiredAgentsMissing: requiredPackagedAgents };

	const files = readdirSync(absolutePath)
		.filter((entry) => !entry.startsWith("."))
		.sort();
	const names = new Set(files);
	const realBinPath = realpathSync(absolutePath);
	const binDirectoryEscapesRoot =
		lstatSync(absolutePath).isSymbolicLink() || !isInsideDirectory(realBinPath, realpathSync(rootDir));
	const placeholderFiles = files.filter((entry) => {
		const fullPath = path.join(absolutePath, entry);
		try {
			if (binDirectoryEscapesRoot || lstatSync(fullPath).isSymbolicLink()) return true;
			const realFilePath = realpathSync(fullPath);
			if (!isInsideDirectory(realFilePath, realBinPath)) return true;
			const raw = readFileSync(fullPath, "utf8");
			return placeholderPattern.test(raw) || staleOpenCodePromptPattern.test(raw) || !defaultIsExecutable(fullPath);
		} catch {
			return true;
		}
	});

	return {
		path: relativePath,
		exists,
		agentCount: files.length,
		requiredAgentsMissing: requiredPackagedAgents.filter((agent) => !names.has(agent)),
		placeholderFiles,
	};
}

function skillResource(rootDir: string, relativePath: string, declaredSkills: string[]): ResourceCheck {
	const absolutePath = path.join(rootDir, relativePath);
	const exists = existsSync(absolutePath);
	if (!exists) return { path: relativePath, exists, agentCount: 0, placeholderFiles: declaredSkills };

	const placeholderFiles: string[] = [];
	const names = new Set<string>();
	const realSkillsPath = realpathSync(absolutePath);
	for (const skill of declaredSkills) {
		const normalizedSkill = normalizeResourcePath(skill);
		const relativeSkillDir =
			normalizedSkill === relativePath ? normalizedSkill : normalizedSkill.replace(`${relativePath}/`, "");
		const skillDir = normalizedSkill === relativePath ? absolutePath : path.join(rootDir, normalizedSkill);
		if (
			!existsSync(skillDir) ||
			!normalizedSkill.startsWith(`${relativePath}/`) ||
			lstatSync(skillDir).isSymbolicLink()
		) {
			placeholderFiles.push(relativeSkillDir);
			continue;
		}
		const realSkillDir = realpathSync(skillDir);
		if (!realSkillDir.startsWith(`${realSkillsPath}${path.sep}`)) {
			placeholderFiles.push(relativeSkillDir);
			continue;
		}
		const skillFile = path.join(skillDir, "SKILL.md");
		if (!existsSync(skillFile)) {
			placeholderFiles.push(relativeSkillDir);
			continue;
		}
		const raw = readFileSync(skillFile, "utf8");
		const name =
			raw
				.match(/^name:\s*([^\n]+)/m)?.[1]
				?.trim()
				.replace(/^['"]|['"]$/g, "") ?? relativeSkillDir;
		if (names.has(name)) placeholderFiles.push(relativeSkillDir);
		names.add(name);
	}

	return { path: relativePath, exists, agentCount: declaredSkills.length, placeholderFiles };
}

export function checkInstallPrerequisites(options: InstallCheckOptions = {}): InstallCheckReport {
	const rootDir = options.rootDir ?? process.cwd();
	const env = options.env ?? process.env;
	const pathEnv = options.pathEnv ?? env.PATH ?? "";
	const isExecutable = options.isExecutable ?? defaultIsExecutable;
	const requireAcpx = options.requireAcpx ?? env.PANTHEON_REQUIRE_ACPX === "true";
	const manifestPath = path.join(rootDir, "package.json");
	const failures: string[] = [];
	const warnings: string[] = [];
	let manifest: ManifestCheck;

	try {
		manifest = validatePackageManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		manifest = {
			files: [],
			piExtensions: [],
			piPrompts: [],
			piSkills: [],
			optionalDependencies: [],
			bin: {},
			failures: [`unable to read package.json: ${message}`],
		};
	}
	failures.push(...manifest.failures);

	const resources = {
		extensionEntrypoint: resource(rootDir, "src/extension/index.ts"),
		cliEntrypoint: resource(rootDir, "src/cli.ts"),
		telemetry: resource(rootDir, "src/telemetry"),
		prompts: promptResource(rootDir, "agents/prompts"),
		manifests: manifestResource(rootDir, "agents/manifests"),
		bin: binResource(rootDir, "agents/bin"),
		skills: skillResource(rootDir, "skills", manifest.piSkills),
	};
	for (const entry of manifest.piExtensions) {
		const resourceStatus = declaredPackageResource(rootDir, entry);
		if (resourceStatus === "ok") continue;
		if (resourceStatus === "missing" && isOptionalDeclaredExtension(entry, manifest)) {
			warnings.push(`optional pi extension is not installed: ${entry}`);
			continue;
		}
		failures.push(`declared pi extension is missing or unsafe: ${entry}`);
	}

	for (const item of Object.values(resources)) {
		if (!item.exists) failures.push(`required resource is missing: ${item.path}`);
		if (item.requiredAgentsMissing && item.requiredAgentsMissing.length > 0) {
			failures.push(`required packaged agents missing from ${item.path}: ${item.requiredAgentsMissing.join(", ")}`);
		}
		if (item.placeholderFiles && item.placeholderFiles.length > 0) {
			failures.push(`placeholder packaged resources in ${item.path}: ${item.placeholderFiles.join(", ")}`);
		}
	}

	const acpx = discoverAcpx(env, pathEnv, isExecutable, requireAcpx);
	if (!acpx.found) {
		if (requireAcpx) failures.push("acpx binary was not found or is not executable");
		else warnings.push(acpx.message);
	}

	return { ok: failures.length === 0, rootDir, manifest, resources, acpx, failures, warnings };
}
