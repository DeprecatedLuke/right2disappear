import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { verbose, warn } from "./log";

const DISCORD_DIRS = ["discord", "discordcanary", "discordptb"];
// Clients that use a sessionData subdirectory for leveldb
const ALT_CLIENT_DIRS = ["vesktop", "webcord", "armcord", "legcord"];
const BASE_PATHS = [
	path.join(os.homedir(), ".config"),
	path.join(os.homedir(), ".var/app/com.discordapp.Discord/config"),
	path.join(os.homedir(), "snap/discord/current/.config"),
];

// Standard user token: base64(userId).base64(ts).hmac
const TOKEN_RE = /[\w-]{24,}\.[\w-]{6}\.[\w-]{27,}/g;
// Encrypted token marker used by newer Discord
const ENCRYPTED_RE = /dQw4w9WgXcQ:([A-Za-z0-9+/=]+)/g;

function isValidToken(token: string): boolean {
	const parts = token.split(".");
	if (parts.length !== 3) return false;
	try {
		const userId = Buffer.from(parts[0]!, "base64").toString("utf-8");
		return /^\d{17,20}$/.test(userId);
	} catch {
		return false;
	}
}

/**
 * Chromium on Linux derives its cookie encryption key via PBKDF2
 * with password from the system keyring, or "peanuts" as fallback.
 */
function deriveLinuxKey(password = "peanuts"): Buffer {
	return crypto.pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
}

function decryptAesCbc(data: Buffer, key: Buffer): string | null {
	try {
		const iv = Buffer.alloc(16, " "); // 0x20
		const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
		return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf-8");
	} catch {
		return null;
	}
}

function tryDecryptToken(b64: string, discordPath: string): string | null {
	try {
		const raw = Buffer.from(b64, "base64");
		if (raw.length < 4) return null;

		const version = raw.subarray(0, 3).toString("ascii");
		const payload = raw.subarray(3);

		// v10: AES-128-CBC with "peanuts"-derived key
		if (version === "v10") {
			const key = deriveLinuxKey();
			const decrypted = decryptAesCbc(payload, key);
			if (decrypted && isValidToken(decrypted)) return decrypted;
		}

		// v11: AES-256-GCM with master key from Local State
		if (version === "v11" && payload.length >= 28) {
			const localStatePath = path.join(discordPath, "Local State");
			if (!fs.existsSync(localStatePath)) return null;

			const localState = JSON.parse(fs.readFileSync(localStatePath, "utf-8"));
			const encKeyB64 = localState?.os_crypt?.encrypted_key;
			if (!encKeyB64) return null;

			const encKey = Buffer.from(encKeyB64, "base64");
			// Master key is itself v10-encrypted
			const masterKeyRaw = encKey.subarray(3);
			const masterKey = decryptAesCbc(masterKeyRaw, deriveLinuxKey());
			if (!masterKey) return null;

			const nonce = payload.subarray(0, 12);
			const ciphertext = payload.subarray(12, -16);
			const tag = payload.subarray(-16);

			const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(masterKey, "binary"), nonce);
			decipher.setAuthTag(tag);
			const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");

			if (isValidToken(decrypted)) return decrypted;
		}
	} catch {
		// Decryption failed — try next candidate
	}
	return null;
}

function getDiscordPaths(): Array<{ root: string; leveldb: string }> {
	const results: Array<{ root: string; leveldb: string }> = [];

	// Standard Discord clients: leveldb directly under <root>/Local Storage/leveldb
	for (const base of BASE_PATHS) {
		for (const dir of DISCORD_DIRS) {
			const root = path.join(base, dir);
			const leveldb = path.join(root, "Local Storage", "leveldb");
			if (fs.existsSync(leveldb)) results.push({ root, leveldb });
		}
	}

	// Alt clients (Vesktop, WebCord, etc.): leveldb under <root>/sessionData/Local Storage/leveldb
	for (const base of BASE_PATHS) {
		for (const dir of ALT_CLIENT_DIRS) {
			const root = path.join(base, dir);
			const leveldb = path.join(root, "sessionData", "Local Storage", "leveldb");
			if (fs.existsSync(leveldb)) results.push({ root, leveldb });
		}
	}

	return results;
}

export function extractToken(): string | null {
	const installations = getDiscordPaths();
	if (installations.length === 0) {
		verbose("no Discord installation found");
		return null;
	}

	for (const { root, leveldb: leveldbPath } of installations) {
		verbose(`checking ${leveldbPath}`);

		let files: string[];
		try {
			files = fs.readdirSync(leveldbPath).filter(f => f.endsWith(".ldb") || f.endsWith(".log"));
		} catch {
			continue;
		}

		for (const file of files) {
			let content: Buffer;
			try {
				content = fs.readFileSync(path.join(leveldbPath, file));
			} catch {
				continue;
			}

			// latin1 preserves raw byte patterns for regex matching
			const text = content.toString("latin1");

			// Try plaintext tokens first
			for (const match of text.matchAll(TOKEN_RE)) {
				if (isValidToken(match[0]!)) {
					verbose("found plaintext token");
					return match[0]!;
				}
			}
			// Try encrypted tokens
			for (const match of text.matchAll(ENCRYPTED_RE)) {
				const decrypted = tryDecryptToken(match[1]!, root);
				if (decrypted) {
					verbose("decrypted token from leveldb");
					return decrypted;
				}
			}
		}
	}

	warn("token not found in any Discord installation");
	return null;
}

export function getTokenInstructions(): string {
	return `
To get your Discord token manually:
  1. Open Discord (browser or desktop app)
  2. Press Ctrl+Shift+I to open Developer Tools
  3. Go to the Network tab
  4. Perform any action (send a message, switch channels)
  5. Find a request to discord.com/api
  6. Copy the "authorization" header value

Then run:
  r2d --token YOUR_TOKEN --save
Or set:
  DISCORD_TOKEN=YOUR_TOKEN
Or add to:
  ~/.config/right2disappear/config.json
  {"token": "YOUR_TOKEN"}`.trim();
}
