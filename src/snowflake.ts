const DISCORD_EPOCH = 1420070400000n;

export function timestampToSnowflake(ts: number): string {
	return ((BigInt(ts) - DISCORD_EPOCH) << 22n).toString();
}

export function snowflakeToTimestamp(id: string): number {
	return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

export function cutoffSnowflake(daysAgo: number): string {
	return timestampToSnowflake(Date.now() - daysAgo * 86_400_000);
}
