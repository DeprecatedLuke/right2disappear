import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Config {
	token: string;
	maxAgeDays: number;
	dryRun: boolean;
	deleteDelayMs: number;
	searchDelayMs: number;
	excludeGuilds: string[];
	excludeChannels: string[];
	includeGuilds: string[];
	includeChannels: string[];
	includeDMs: boolean;
	skipChannels: string[];
	verbose: boolean;
}

export const CONFIG_DIR = path.join(os.homedir(), ".config", "right2disappear");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const ARCHIVED_FILE = path.join(CONFIG_DIR, "archived-threads.json");

export interface ArchivedThread {
	guild: string;
	channel: string;
	since: string;
}

const DEFAULTS: Omit<Config, "token"> = {
	maxAgeDays: 30,
	dryRun: false,
	deleteDelayMs: 1200,
	searchDelayMs: 3000,
	excludeGuilds: [],
	excludeChannels: [],
	includeGuilds: [],
	includeChannels: [],
	includeDMs: true,
	skipChannels: [],
	verbose: false,
};

export async function loadConfig(overrides: Partial<Config> = {}): Promise<Config> {
	let file: Partial<Config> = {};

	try {
		file = await Bun.file(CONFIG_FILE).json();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			// Corrupt config — ignore, use defaults
		}
	}

	const env: Partial<Config> = {};
	if (process.env.DISCORD_TOKEN) env.token = process.env.DISCORD_TOKEN;
	if (process.env.R2D_MAX_AGE) env.maxAgeDays = parseInt(process.env.R2D_MAX_AGE, 10);
	if (process.env.R2D_DRY_RUN === "1") env.dryRun = true;

	return { ...DEFAULTS, token: "", ...file, ...env, ...overrides } as Config;
}

export async function saveConfig(updates: Partial<Config>): Promise<void> {
	fs.mkdirSync(CONFIG_DIR, { recursive: true });

	let existing: Partial<Config> = {};
	try {
		existing = await Bun.file(CONFIG_FILE).json();
	} catch {
		// Overwrite corrupt or missing file
	}

	await Bun.write(CONFIG_FILE, `${JSON.stringify({ ...existing, ...updates }, null, "\t")}\n`);
	fs.chmodSync(CONFIG_FILE, 0o600);
}

export async function loadArchivedThreads(): Promise<Map<string, ArchivedThread>> {
	try {
		const data: Record<string, ArchivedThread> = await Bun.file(ARCHIVED_FILE).json();
		return new Map(Object.entries(data));
	} catch {
		return new Map();
	}
}

export async function saveArchivedThreads(threads: Map<string, ArchivedThread>): Promise<void> {
	if (threads.size === 0) return;
	fs.mkdirSync(CONFIG_DIR, { recursive: true });
	await Bun.write(ARCHIVED_FILE, `${JSON.stringify(Object.fromEntries(threads), null, "\t")}\n`);
}
