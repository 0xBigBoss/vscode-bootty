import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ProfileEvent } from "./types/messages";

const DEFAULT_FLUSH_INTERVAL_MS = 250;
const MAX_BUFFERED_LINES = 2000;

export interface ProfileWriterOptions {
	flushIntervalMs?: number;
	maxBufferedLines?: number;
}

export class ProfileWriter {
	private fileHandle?: fs.FileHandle;
	private buffer: string[] = [];
	private flushTimer?: NodeJS.Timeout;
	private pendingFlush?: Promise<void>;
	private closed = false;
	private readonly flushIntervalMs: number;
	private readonly maxBufferedLines: number;

	constructor(
		private readonly outputPath: string,
		options: ProfileWriterOptions = {},
	) {
		this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
		this.maxBufferedLines = options.maxBufferedLines ?? MAX_BUFFERED_LINES;
	}

	get path(): string {
		return this.outputPath;
	}

	async start(meta: Record<string, unknown>): Promise<void> {
		await fs.mkdir(path.dirname(this.outputPath), { recursive: true });
		this.fileHandle = await fs.open(this.outputPath, "a");
		await this.appendLine({
			type: "session-start",
			...meta,
			ts: Date.now(),
		});
	}

	appendEvents(sessionId: string, events: ProfileEvent[]): void {
		if (this.closed || !this.fileHandle || events.length === 0) return;
		for (const event of events) {
			this.buffer.push(JSON.stringify({ sessionId, type: "event", ...event }));
		}
		this.scheduleFlush();
	}

	async stop(meta: Record<string, unknown>): Promise<void> {
		if (this.closed) return;
		await this.appendLine({
			type: "session-stop",
			...meta,
			ts: Date.now(),
		});
		await this.flush();
		await this.close();
	}

	private async appendLine(payload: Record<string, unknown>): Promise<void> {
		if (this.closed || !this.fileHandle) return;
		this.buffer.push(JSON.stringify(payload));
		await this.flush();
	}

	private scheduleFlush(): void {
		if (this.flushTimer || this.closed) return;
		if (this.buffer.length >= this.maxBufferedLines) {
			this.flushTimer = setTimeout(() => {
				this.flushTimer = undefined;
				void this.flush();
			}, 0);
			return;
		}
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			void this.flush();
		}, this.flushIntervalMs);
	}

	private async flush(): Promise<void> {
		if (this.closed || !this.fileHandle || this.buffer.length === 0) return;
		if (this.pendingFlush) return this.pendingFlush;
		const lines = this.buffer.splice(0, this.buffer.length);
		const payload = `${lines.join("\n")}\n`;
		this.pendingFlush = this.fileHandle.appendFile(payload).finally(() => {
			this.pendingFlush = undefined;
		});
		await this.pendingFlush;
	}

	private async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		if (this.fileHandle) {
			await this.fileHandle.close();
			this.fileHandle = undefined;
		}
	}
}
