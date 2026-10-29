/**
 * Finds a project's verification commands (typecheck, lint, test).
 * Order: `<repo>/.pi/checks.json`, then package.json scripts, then Makefile targets.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ProjectCheck {
	name: string;
	command: string;
}

export interface ProjectChecks {
	checks: ProjectCheck[];
	/** Where the checks came from, shown to the user. */
	source: string;
	/** Directory the commands run in. */
	workingDir: string;
	/** Run the checks automatically when the agent finishes a turn that changed files. */
	autoVerify: boolean;
	timeoutMs: number;
}

export const CHECKS_CONFIG_RELATIVE_PATH = join(".pi", "checks.json");
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
/** Script names per check, most specific first. */
const SCRIPT_NAMES_BY_CHECK: Record<string, string[]> = {
	typecheck: ["typecheck", "type-check", "check-types", "tsc"],
	lint: ["lint"],
	test: ["test"],
};
const MAKE_TARGETS = ["check", "lint", "test"];
/** `npm init` writes this placeholder; running it would always fail. */
const NPM_PLACEHOLDER_TEST = /no test specified/;

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** Walks up from `startDir` to the nearest directory holding `.git`; undefined outside a repo. */
export function findRepoRoot(startDir: string): string | undefined {
	let dir = startDir;
	while (true) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** Nearest file named `fileName` from `startDir` up to `stopDir` (inclusive). */
function findNearestFile(startDir: string, stopDir: string, fileName: string): string | undefined {
	let dir = startDir;
	while (true) {
		const candidate = join(dir, fileName);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (dir === stopDir || parent === dir) return undefined;
		dir = parent;
	}
}

export function detectPackageManager(lockfileNames: ReadonlySet<string>): PackageManager {
	if (lockfileNames.has("pnpm-lock.yaml")) return "pnpm";
	if (lockfileNames.has("yarn.lock")) return "yarn";
	if (lockfileNames.has("bun.lock") || lockfileNames.has("bun.lockb")) return "bun";
	return "npm";
}

export function checksFromPackageScripts(scripts: Record<string, string>, packageManager: PackageManager): ProjectCheck[] {
	return Object.entries(SCRIPT_NAMES_BY_CHECK).flatMap(([checkName, scriptNames]) => {
		const scriptName = scriptNames.find((name) => typeof scripts[name] === "string");
		if (!scriptName) return [];
		if (checkName === "test" && NPM_PLACEHOLDER_TEST.test(scripts[scriptName])) return [];
		return [{ name: checkName, command: `${packageManager} run ${scriptName}` }];
	});
}

export function checksFromMakefile(makefile: string): ProjectCheck[] {
	return MAKE_TARGETS.filter((target) => new RegExp(`^${target}\\s*:`, "m").test(makefile)).map((target) => ({
		name: target,
		command: `make ${target}`,
	}));
}

function parseChecksConfig(configPath: string, repoRoot: string): ProjectChecks {
	const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
	const isValidCheck = (check: unknown): check is ProjectCheck =>
		typeof (check as ProjectCheck)?.name === "string" && typeof (check as ProjectCheck)?.command === "string";
	if (!Array.isArray(raw.checks) || !raw.checks.every(isValidCheck)) {
		throw new Error(`${configPath}: "checks" must be a list of { "name": string, "command": string }`);
	}
	const timeoutSeconds = raw.timeoutSeconds;
	if (timeoutSeconds !== undefined && (typeof timeoutSeconds !== "number" || timeoutSeconds <= 0)) {
		throw new Error(`${configPath}: "timeoutSeconds" must be a positive number`);
	}
	return {
		checks: raw.checks,
		source: configPath,
		workingDir: repoRoot,
		autoVerify: raw.autoVerify !== false,
		timeoutMs: timeoutSeconds === undefined ? DEFAULT_TIMEOUT_MS : timeoutSeconds * 1000,
	};
}

function lockfilesBesides(packageJsonPath: string, repoRoot: string): Set<string> {
	const lockfileNames = ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "package-lock.json"];
	const dirs = [dirname(packageJsonPath), repoRoot];
	return new Set(lockfileNames.filter((name) => dirs.some((dir) => existsSync(join(dir, name)))));
}

/** Checks for the project containing `cwd`; an empty list when nothing is configured or detected. */
export function findProjectChecks(cwd: string): ProjectChecks {
	const root = findRepoRoot(cwd) ?? cwd;
	const configPath = join(root, CHECKS_CONFIG_RELATIVE_PATH);
	if (existsSync(configPath)) return parseChecksConfig(configPath, root);

	const detected = { autoVerify: true, timeoutMs: DEFAULT_TIMEOUT_MS };
	const packageJsonPath = findNearestFile(cwd, root, "package.json");
	if (packageJsonPath) {
		const scripts = (JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
		const packageManager = detectPackageManager(lockfilesBesides(packageJsonPath, root));
		const checks = checksFromPackageScripts(scripts, packageManager);
		return { ...detected, checks, source: packageJsonPath, workingDir: dirname(packageJsonPath) };
	}
	const makefilePath = findNearestFile(cwd, root, "Makefile");
	if (makefilePath) {
		const checks = checksFromMakefile(readFileSync(makefilePath, "utf8"));
		return { ...detected, checks, source: makefilePath, workingDir: dirname(makefilePath) };
	}
	return { ...detected, checks: [], source: "none", workingDir: root };
}
