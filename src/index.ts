#!/usr/bin/env bun
import { parseArgs as nodeParseArgs } from "node:util";
import { DiscordAPI } from "./api";
import { CONFIG_FILE, loadConfig, saveConfig } from "./config";
import { error, info, initLog, setVerbose } from "./log";
import { purge } from "./purge";
import { extractToken, getTokenInstructions } from "./token";

// ── Duration parsing ─────────────────────────────────────────────

const DURATION_RE = /^(\d+)\s*(h|d|w|m|y)$/i;

const UNIT_TO_DAYS: Record<string, number> = {
	h: 1 / 24,
	d: 1,
	w: 7,
	m: 30,
	y: 365,
};

function parseDuration(input: string): number {
	const match = DURATION_RE.exec(input);
	if (match) {
		const n = parseInt(match[1]!, 10);
		const unit = match[2]!.toLowerCase();
		const multiplier = UNIT_TO_DAYS[unit];
		if (multiplier !== undefined && n > 0) return n * multiplier;
	}
	// Bare number = days (backward compat)
	const days = parseInt(input, 10);
	if (!Number.isNaN(days) && days > 0) return days;
	throw new Error(`Invalid duration: "${input}". Use: 7d, 2w, 1m, 1y, or a plain number of days.`);
}

// ── Arg parsing ──────────────────────────────────────────────────
function parseFlags() {
	const { values } = nodeParseArgs({
		args: process.argv.slice(2),
		strict: true,
		allowPositionals: false,
		options: {
			"keep-earlier-than": { type: "string", short: "k" },
			"skip-channels": { type: "string", short: "s" },
			token: { type: "string", short: "t" },
			"dry-run": { type: "boolean", short: "n" },
			verbose: { type: "boolean", short: "v" },
			setup: { type: "boolean" },
			save: { type: "boolean" },
			help: { type: "boolean", short: "h" },
			"no-dms": { type: "boolean" },
			"include-guilds": { type: "string" },
			"exclude-guilds": { type: "string" },
		},
	});
	return values;
}

// ── Help ─────────────────────────────────────────────────────────

const HELP = `r2d — auto-delete Discord messages older than a given age

USAGE
  r2d [options]
  bun src/index.ts [options]

OPTIONS
  --keep-earlier-than, -k <dur>  Keep messages newer than this; delete the rest
                                 Formats: 7d, 2w, 1m, 1y (default: 30d)
  --skip-channels, -s <names>    Comma-separated channel name patterns to skip
                                 Fuzzy case-insensitive contains match
                                 e.g. --skip-channels="announcements,changelog"
  --token, -t <token>            Discord user token
  --dry-run, -n                  Show what would be deleted, don't delete
  --verbose, -v                  Verbose output
  --setup                        Extract token from Discord client, save config
  --save                         Persist provided --token to config file
  --include-guilds <ids>         Comma-separated guild IDs to process (allowlist)
  --exclude-guilds <ids>         Comma-separated guild IDs to skip
  --no-dms                       Skip DM channels
  --help, -h                     Show this help

ENVIRONMENT
  DISCORD_TOKEN                  User token (overrides config file)
  R2D_MAX_AGE                    Age threshold in days
  R2D_DRY_RUN=1                  Enable dry run

CONFIG
  ${CONFIG_FILE}

CRON
  # Daily at 3am, keep only last 7 days
  0 3 * * * ${process.env.HOME}/.bun/bin/r2d --keep-earlier-than 7d 2>&1 | logger -t r2d

NOTE
  Using a user token for automation violates Discord ToS.
  Only reaches messages in guilds you are currently in, plus your DMs.
  Messages in guilds you have left cannot be reached via the API.`;

// ── Setup ────────────────────────────────────────────────────────

async function setup(): Promise<void> {
	info("extracting token from Discord client...");
	const token = extractToken();

	if (!token) {
		error("could not extract token automatically");
		console.log(getTokenInstructions());
		process.exit(1);
	}

	info("token found — saving to config...");
	await saveConfig({ token });
	info(`saved to ${CONFIG_FILE}`);

	try {
		const api = new DiscordAPI(token);
		const me = await api.getMe();
		info(`verified: logged in as ${me.username} (${me.id})`);
	} catch {
		error("token extracted but API validation failed — is Discord open/logged in?");
		process.exit(1);
	}
}

// ── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const flags = parseFlags();

	if (flags.help) {
		console.log(HELP);
		process.exit(0);
	}

	if (flags.setup) {
		await setup();
		process.exit(0);
	}
	// Build config: file -> env -> CLI overrides
	const overrides: Record<string, unknown> = {};
	if (flags.token) overrides.token = flags.token;
	if (flags["keep-earlier-than"] !== undefined) overrides.maxAgeDays = parseDuration(flags["keep-earlier-than"]);
	if (flags["dry-run"]) overrides.dryRun = true;
	if (flags.verbose) overrides.verbose = true;
	if (flags["no-dms"]) overrides.includeDMs = false;
	if (flags["include-guilds"]) overrides.includeGuilds = flags["include-guilds"].split(",");
	if (flags["exclude-guilds"]) overrides.excludeGuilds = flags["exclude-guilds"].split(",");
	if (flags["skip-channels"]) overrides.skipChannels = flags["skip-channels"].split(",").map(s => s.trim());
	const config = await loadConfig(overrides);
	initLog();
	setVerbose(config.verbose);
	if (flags.save && config.token) {
		await saveConfig({ token: config.token });
		info(`token saved to ${CONFIG_FILE}`);
	}

	// Resolve token: config/env -> auto-extract -> fail
	if (!config.token) {
		info("no token configured, attempting auto-extraction...");
		const extracted = extractToken();
		if (extracted) {
			config.token = extracted;
			info("token extracted from Discord client");
		} else {
			error("no token available");
			console.log(getTokenInstructions());
			process.exit(1);
		}
	}

	const api = new DiscordAPI(config.token);
	const stats = await purge(api, config);

	// ── Summary ────────────────────────────────────────────────────
	console.log();
	info("=== summary ===");
	info(`guilds scanned:     ${stats.guildsProcessed}`);
	info(`DM channels:        ${stats.channelsProcessed}`);
	info(`messages ${config.dryRun ? "found" : "deleted"}:     ${stats.messagesDeleted}`);
	if (stats.messagesSkipped > 0) {
		info(`messages skipped:    ${stats.messagesSkipped}`);
	}
	if (stats.messagesFailed > 0) {
		info(`messages failed:    ${stats.messagesFailed}`);
	}
	if (stats.errors.length > 0) {
		info(`errors:             ${stats.errors.length}`);
		for (const e of stats.errors) {
			info(`  - ${e}`);
		}
	}

	process.exit(stats.messagesFailed > 0 ? 1 : 0);
}

main().catch(e => {
	error(e.message || String(e));
	process.exit(1);
});
