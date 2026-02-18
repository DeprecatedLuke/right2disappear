import { type DiscordAPI, DiscordForbiddenError, type Message, type SearchResult } from "./api";
import { type ArchivedThread, type Config, loadArchivedThreads, saveArchivedThreads } from "./config";
import { error, info, verbose, warn } from "./log";
import { cutoffSnowflake } from "./snowflake";

export interface PurgeStats {
	guildsProcessed: number;
	channelsProcessed: number;
	messagesDeleted: number;
	messagesSkipped: number;
	messagesFailed: number;
	errors: string[];
}

function extractHits(result: SearchResult, authorId: string): Message[] {
	const seen = new Set<string>();
	const hits: Message[] = [];
	for (const group of result.messages) {
		for (const msg of group) {
			if (msg.author.id === authorId && msg.hit && !seen.has(msg.id)) {
				seen.add(msg.id);
				hits.push(msg);
			}
		}
	}
	return hits;
}

/** Case-insensitive contains match against any pattern. */
function matchesSkipPattern(name: string, patterns: string[]): boolean {
	const lower = name.toLowerCase();
	return patterns.some(p => lower.includes(p.toLowerCase()));
}

async function purgeTarget(
	api: DiscordAPI,
	kind: "guild" | "channel",
	targetId: string,
	targetName: string,
	authorId: string,
	maxId: string,
	config: Config,
	stats: PurgeStats,
	channelNames: Map<string, string> | null,
	archivedThreads: Map<string, ArchivedThread>,
	guildName: string,
): Promise<void> {
	verbose(`scanning ${kind}: ${targetName} (${targetId})`);
	let totalFound = 0;
	let round = 0;

	while (true) {
		round++;
		let result: SearchResult;

		try {
			result =
				kind === "guild"
					? await api.searchGuild(targetId, authorId, maxId)
					: await api.searchChannel(targetId, authorId, maxId);
		} catch (e: unknown) {
			if (e instanceof DiscordForbiddenError) {
				verbose(`no access to ${kind} ${targetName}, skipping`);
				return;
			}
			throw e;
		}

		if (result.total_results === 0 || result.messages.length === 0) {
			if (totalFound > 0) {
				verbose(`${kind} ${targetName}: done (${totalFound} messages processed)`);
			}
			break;
		}

		let hits = extractHits(result, authorId);

		// Filter out messages from skipped channels (guild search returns cross-channel)
		if (channelNames && config.skipChannels.length > 0) {
			hits = hits.filter(msg => {
				const chName = channelNames.get(msg.channel_id);
				if (chName && matchesSkipPattern(chName, config.skipChannels)) {
					verbose(`  skipping message in #${chName} (matches skip pattern)`);
					stats.messagesSkipped++;
					return false;
				}
				return true;
			});
		}

		if (hits.length === 0) {
			// All hits were filtered or no matches — check if search has more
			if (result.total_results <= 25) {
				verbose(`${kind} ${targetName}: no actionable hits, done`);
				break;
			}
			// There are more results but this page was all skipped channels.
			// Use the oldest message ID from the raw results to paginate past them.
			const allMsgs = result.messages.flat();
			if (allMsgs.length > 0) {
				const oldest = allMsgs.reduce((a, b) => (BigInt(a.id) < BigInt(b.id) ? a : b));
				maxId = oldest.id;
				verbose(`${kind} ${targetName}: page fully skipped, advancing past ${maxId}`);
				await Bun.sleep(config.searchDelayMs);
				continue;
			}
			break;
		}

		totalFound += hits.length;
		verbose(
			`${kind} ${targetName} round ${round}: ${hits.length} messages (${result.total_results} total remaining)`,
		);

		let deletedThisBatch = 0;
		for (const msg of hits) {
			const preview = msg.content.slice(0, 60).replace(/\n/g, " ");
			const ts = new Date(msg.timestamp).toISOString().slice(0, 10);
			const chLabel = channelNames?.get(msg.channel_id);
			const loc = chLabel ? ` #${chLabel}` : "";
			if (archivedThreads.has(msg.channel_id)) {
				stats.messagesSkipped++;
				continue;
			}
			if (config.dryRun) {
				info(`  [dry-run] would delete ${msg.id}${loc} (${ts}): ${preview}`);
				stats.messagesDeleted++;
				continue;
			}

			try {
				await api.deleteMessage(msg.channel_id, msg.id);
				stats.messagesDeleted++;
				deletedThisBatch++;
				verbose(`  deleted ${msg.id}${loc} (${ts}): ${preview}`);
			} catch (e: unknown) {
				const emsg = e instanceof Error ? e.message : String(e);
				if (emsg.includes("Not found")) {
					verbose(`  ${msg.id} already deleted`);
				} else if (emsg.includes("Thread is archived")) {
					const chName = channelNames?.get(msg.channel_id) ?? msg.channel_id;
					archivedThreads.set(msg.channel_id, {
						guild: guildName,
						channel: chName,
						since: new Date().toISOString().slice(0, 10),
					});
					warn(
						`can't delete in archived thread "${chName}" in ${guildName} — thread is locked, need MANAGE_THREADS permission to unarchive`,
					);
					stats.messagesSkipped++;
				} else {
					warn(`  failed to delete ${msg.id}: ${emsg}`);
					stats.messagesFailed++;
					stats.errors.push(`${msg.id}: ${emsg}`);
				}
			}
			await Bun.sleep(config.deleteDelayMs);
		}

		// Advance cursor past processed messages when nothing was actually deleted
		// (dry-run, all archived, all already gone) to avoid infinite loop
		if (deletedThisBatch === 0 && hits.length > 0) {
			const oldest = hits.reduce((a, b) => (BigInt(a.id) < BigInt(b.id) ? a : b));
			maxId = (BigInt(oldest.id) - 1n).toString();
		}
		// Let search index catch up after deletions
		await Bun.sleep(config.searchDelayMs);
	}

	if (totalFound > 0) {
		const verb = config.dryRun ? "would delete" : "deleted";
		info(`  ${kind} ${targetName}: ${verb} ${totalFound} messages`);
	}
}

export async function purge(api: DiscordAPI, config: Config): Promise<PurgeStats> {
	const archivedThreads = await loadArchivedThreads();
	if (archivedThreads.size > 0) {
		info(`${archivedThreads.size} known archived threads will be skipped`);
	}
	const stats: PurgeStats = {
		guildsProcessed: 0,
		channelsProcessed: 0,
		messagesDeleted: 0,
		messagesSkipped: 0,
		messagesFailed: 0,
		errors: [],
	};

	// ── Identity ─────────────────────────────────────────────────────
	const me = await api.getMe();
	info(`authenticated as ${me.username} (${me.id})`);

	const maxId = cutoffSnowflake(config.maxAgeDays);
	const cutoffDate = new Date(Date.now() - config.maxAgeDays * 86_400_000).toISOString().slice(0, 10);
	info(`target: messages before ${cutoffDate} (${config.maxAgeDays} days)${config.dryRun ? " [DRY RUN]" : ""}`);

	if (config.skipChannels.length > 0) {
		info(`skip channels matching: ${config.skipChannels.join(", ")}`);
	}

	// ── Guilds ───────────────────────────────────────────────────────
	const guilds = await api.getGuilds();
	info(`found ${guilds.length} guilds`);

	for (const guild of guilds) {
		if (config.includeGuilds.length > 0 && !config.includeGuilds.includes(guild.id)) continue;
		if (config.excludeGuilds.includes(guild.id)) continue;

		// Resolve channel names for skip-channel filtering
		let channelNames: Map<string, string> | null = null;
		if (config.skipChannels.length > 0) {
			try {
				const channels = await api.getGuildChannels(guild.id);
				channelNames = new Map(channels.map(c => [c.id, c.name]));
			} catch {
				verbose(`could not fetch channels for ${guild.name}, skip-channels won't apply`);
			}
		}

		try {
			await purgeTarget(
				api,
				"guild",
				guild.id,
				guild.name,
				me.id,
				maxId,
				config,
				stats,
				channelNames,
				archivedThreads,
				guild.name,
			);
			stats.guildsProcessed++;
		} catch (e: unknown) {
			const emsg = e instanceof Error ? e.message : String(e);
			error(`guild ${guild.name}: ${emsg}`);
			stats.errors.push(`guild ${guild.name}: ${emsg}`);
		}
	}

	// ── DM Channels ──────────────────────────────────────────────────
	if (config.includeDMs) {
		const channels = await api.getDMChannels();
		info(`found ${channels.length} DM channels`);

		for (const channel of channels) {
			if (config.excludeChannels.includes(channel.id)) continue;
			if (config.includeChannels.length > 0 && !config.includeChannels.includes(channel.id)) continue;

			const name = channel.recipients?.map(r => r.username).join(", ") || channel.name || channel.id;

			// Skip DM channels matching skip patterns
			if (config.skipChannels.length > 0 && matchesSkipPattern(name, config.skipChannels)) {
				verbose(`skipping DM channel "${name}" (matches skip pattern)`);
				continue;
			}

			try {
				await purgeTarget(
					api,
					"channel",
					channel.id,
					name,
					me.id,
					maxId,
					config,
					stats,
					null,
					archivedThreads,
					name,
				);
				stats.channelsProcessed++;
			} catch (e: unknown) {
				const emsg = e instanceof Error ? e.message : String(e);
				error(`DM ${name}: ${emsg}`);
				stats.errors.push(`DM ${name}: ${emsg}`);
			}
		}
	}

	await saveArchivedThreads(archivedThreads);

	return stats;
}
