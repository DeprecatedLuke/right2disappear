import { verbose, warn } from "./log";

const BASE_URL = "https://discord.com/api/v9";
const UA =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) discord/0.0.71 Chrome/128.0.6613.186 Electron/32.2.6 Safari/537.36";

// ── Types ──────────────────────────────────────────────────────────

export interface Message {
	id: string;
	channel_id: string;
	author: { id: string; username: string };
	content: string;
	timestamp: string;
	hit?: boolean;
}

export interface SearchResult {
	total_results: number;
	messages: Message[][];
	retry_after?: number;
}

export interface Guild {
	id: string;
	name: string;
}

export interface Channel {
	id: string;
	type: number;
	recipients?: Array<{ id: string; username: string }>;
	name?: string;
}

export interface GuildChannel {
	id: string;
	name: string;
	type: number;
}

export interface User {
	id: string;
	username: string;
	discriminator: string;
}

// ── Errors ─────────────────────────────────────────────────────────

export class DiscordAuthError extends Error {
	constructor(msg: string) {
		super(msg);
		this.name = "DiscordAuthError";
	}
}

export class DiscordForbiddenError extends Error {
	constructor(path: string) {
		super(`Forbidden: ${path}`);
		this.name = "DiscordForbiddenError";
	}
}

// ── Client ─────────────────────────────────────────────────────────

export class DiscordAPI {
	#token: string;
	#maxRetries = 5;

	constructor(token: string) {
		this.#token = token;
	}

	async #request<T>(method: string, path: string, attempt = 0): Promise<T> {
		verbose(`${method} ${path}`);

		const res = await fetch(`${BASE_URL}${path}`, {
			method,
			headers: {
				Authorization: this.#token,
				"User-Agent": UA,
				"Content-Type": "application/json",
			},
		});

		// ── Rate-limited ───────────────────────────────────────────────
		if (res.status === 429) {
			const body = (await res.json()) as { retry_after: number };
			const wait = body.retry_after * 1000 + 1000;
			warn(`rate limited on ${path}, waiting ${Math.round(wait / 1000)}s`);
			await Bun.sleep(wait);
			return this.#request(method, path, attempt);
		}

		// ── Search index building ──────────────────────────────────────
		if (res.status === 202) {
			if (attempt >= this.#maxRetries) {
				throw new Error(`Search index not ready after ${this.#maxRetries} retries: ${path}`);
			}
			verbose("search index building, retrying in 3s");
			await Bun.sleep(3000);
			return this.#request(method, path, attempt + 1);
		}

		// ── Auth / permission errors ───────────────────────────────────
		if (res.status === 401) {
			throw new DiscordAuthError("Invalid or expired token");
		}
		if (res.status === 403) {
			throw new DiscordForbiddenError(path);
		}

		// ── 204 No Content (successful DELETE) ─────────────────────────
		if (res.status === 204) {
			return {} as T;
		}

		// ── 404 — resource gone ────────────────────────────────────────
		if (res.status === 404) {
			throw new Error(`Not found: ${path}`);
		}

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`HTTP ${res.status} ${method} ${path}: ${text}`);
		}

		// ── Pre-emptive rate limit wait ────────────────────────────────
		const remaining = res.headers.get("x-ratelimit-remaining");
		const resetAfter = res.headers.get("x-ratelimit-reset-after");
		if (remaining === "0" && resetAfter) {
			const wait = parseFloat(resetAfter) * 1000 + 200;
			verbose(`bucket exhausted, waiting ${Math.round(wait)}ms`);
			await Bun.sleep(wait);
		}

		return res.json() as T;
	}

	// ── Endpoints ──────────────────────────────────────────────────

	async getMe(): Promise<User> {
		return this.#request("GET", "/users/@me");
	}

	async getGuilds(): Promise<Guild[]> {
		// Discord paginates guilds at 200. Fetch all.
		const all: Guild[] = [];
		let after: string | undefined;
		while (true) {
			const params = new URLSearchParams({ limit: "200" });
			if (after) params.set("after", after);
			const batch: Guild[] = await this.#request("GET", `/users/@me/guilds?${params}`);
			all.push(...batch);
			if (batch.length < 200) break;
			after = batch[batch.length - 1]!.id;
		}
		return all;
	}

	async getDMChannels(): Promise<Channel[]> {
		return this.#request("GET", "/users/@me/channels");
	}

	async getGuildChannels(guildId: string): Promise<GuildChannel[]> {
		return this.#request("GET", `/guilds/${guildId}/channels`);
	}

	async searchGuild(guildId: string, authorId: string, maxId: string, minId?: string): Promise<SearchResult> {
		const params = new URLSearchParams({
			author_id: authorId,
			max_id: maxId,
			sort_order: "asc",
			include_nsfw: "true",
		});
		if (minId) params.set("min_id", minId);
		return this.#request("GET", `/guilds/${guildId}/messages/search?${params}`);
	}

	async searchChannel(channelId: string, authorId: string, maxId: string, minId?: string): Promise<SearchResult> {
		const params = new URLSearchParams({
			author_id: authorId,
			max_id: maxId,
			sort_order: "asc",
		});
		if (minId) params.set("min_id", minId);
		return this.#request("GET", `/channels/${channelId}/messages/search?${params}`);
	}

	async deleteMessage(channelId: string, messageId: string): Promise<void> {
		await this.#request("DELETE", `/channels/${channelId}/messages/${messageId}`);
	}
}
