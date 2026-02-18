import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let verboseEnabled = false;
let logFile: string | null = null;

export function initLog(): void {
	const dir = path.join(os.homedir(), ".r2d", "discord");
	fs.mkdirSync(dir, { recursive: true });
	const date = new Date().toISOString().slice(0, 10);
	logFile = path.join(dir, `${date}.log`);
}

function writeLog(level: string, msg: string): void {
	if (!logFile) return;
	const ts = new Date().toISOString();
	fs.appendFileSync(logFile, `[${ts}] [${level}] ${msg}\n`);
}

export function setVerbose(v: boolean): void {
	verboseEnabled = v;
}

export function info(msg: string): void {
	console.log(`[r2d] ${msg}`);
	writeLog("INFO", msg);
}

export function verbose(msg: string): void {
	if (verboseEnabled) console.log(`[r2d] ${msg}`);
	// Always log verbose to file for post-mortem debugging
	writeLog("VERBOSE", msg);
}

export function warn(msg: string): void {
	console.warn(`[r2d] WARN: ${msg}`);
	writeLog("WARN", msg);
}

export function error(msg: string): void {
	console.error(`[r2d] ERROR: ${msg}`);
	writeLog("ERROR", msg);
}
