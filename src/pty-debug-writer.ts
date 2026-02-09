import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { PtyDebugData, PtyDebugScope } from "./types/messages";
import type { TerminalId } from "./types/terminal";

const DEFAULT_FLUSH_INTERVAL_MS = 50;
const MAX_BUFFERED_LINES = 4096;

export interface PtyDebugRecord {
	ts: number;
	scope: PtyDebugScope;
	message: string;
	terminalId?: TerminalId;
	data?: PtyDebugData;
}

export class PtyDebugWriter {
	private stream?: fs.WriteStream;
	private buffer: string[] = [];
	private flushTimer?: NodeJS.Timeout;
	private closed = false;

	constructor(
		private readonly outputPath: string,
		private readonly flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
		private readonly maxBufferedLines = MAX_BUFFERED_LINES,
	) {}

	get path(): string {
		return this.outputPath;
	}

	async start(meta: Record<string, unknown>): Promise<void> {
		if (this.closed) {
			throw new Error("PTY debug writer has been closed");
		}
		await fsp.mkdir(path.dirname(this.outputPath), { recursive: true });
		this.stream = fs.createWriteStream(this.outputPath, {
			flags: "w",
			encoding: "utf8",
			highWaterMark: 1 << 20,
		});
		this.stream.on("error", () => {
			// Errors are best-effort for debug logging; callers continue without throwing.
		});
		this.append({
			ts: Date.now(),
			scope: "extension",
			message: "session-start",
			data: toDebugData(meta),
		});
	}

	append(record: PtyDebugRecord): void {
		if (this.closed || !this.stream) return;
		this.buffer.push(JSON.stringify(record));
		if (this.buffer.length >= this.maxBufferedLines) {
			this.scheduleFlush(0);
			return;
		}
		this.scheduleFlush(this.flushIntervalMs);
	}

	async stop(meta?: Record<string, unknown>): Promise<void> {
		if (this.closed) return;
		if (meta) {
			this.append({
				ts: Date.now(),
				scope: "extension",
				message: "session-stop",
				data: toDebugData(meta),
			});
		}
		this.flushNow();
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		const stream = this.stream;
		this.stream = undefined;
		this.closed = true;
		if (!stream) return;
		await new Promise<void>((resolve) => {
			stream.end(() => resolve());
		});
	}

	private scheduleFlush(delayMs: number): void {
		if (this.flushTimer || this.closed) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			this.flushNow();
		}, delayMs);
	}

	private flushNow(): void {
		if (this.closed || !this.stream || this.buffer.length === 0) return;
		const lines = this.buffer.splice(0, this.buffer.length);
		const payload = `${lines.join("\n")}\n`;
		const accepted = this.stream.write(payload);
		if (!accepted) {
			this.stream.once("drain", () => {
				if (this.buffer.length > 0) {
					this.scheduleFlush(0);
				}
			});
			return;
		}
		if (this.buffer.length > 0) {
			this.scheduleFlush(0);
		}
	}
}

function toDebugData(input: Record<string, unknown>): PtyDebugData {
	const out: PtyDebugData = {};
	for (const [key, value] of Object.entries(input)) {
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean" ||
			value === null
		) {
			out[key] = value;
			continue;
		}
		out[key] = JSON.stringify(value);
	}
	return out;
}
