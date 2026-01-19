import type {
	ProfileEvent,
	ProfileSource,
	WebviewMessage,
} from "../types/messages";
import type { TerminalId } from "../types/terminal";

const DEFAULT_FLUSH_INTERVAL_MS = 200;
const MAX_BUFFERED_EVENTS = 2000;
const MAX_EVENTS_PER_MESSAGE = 500;

type ProfileData = Record<string, string | number | boolean | null>;

interface ProfileHookEvent {
	name: string;
	ts?: number;
	dur?: number;
	data?: ProfileData;
}

interface ProfileHook {
	enabled: boolean;
	record: (event: ProfileHookEvent) => void;
	now?: () => number;
}

declare global {
	interface Window {
		__BOOTTY_PROFILE__?: ProfileHook;
	}
}

export interface ProfileCollectorOptions {
	source: ProfileSource;
	terminalId?: TerminalId;
	postMessage: (message: WebviewMessage) => void;
	flushIntervalMs?: number;
	maxBufferedEvents?: number;
	maxEventsPerMessage?: number;
}

export interface ProfileRecordOptions {
	source?: ProfileSource;
	terminalId?: TerminalId;
}

export interface ProfileCollector {
	start: (sessionId: string) => void;
	stop: (sessionId: string) => void;
	isActive: () => boolean;
	recordEvent: (
		name: string,
		data?: ProfileData,
		options?: ProfileRecordOptions,
	) => void;
	startSpan: () => number | null;
	recordDuration: (
		name: string,
		start: number | null,
		data?: ProfileData,
		options?: ProfileRecordOptions,
	) => void;
}

export function createProfileCollector(
	options: ProfileCollectorOptions,
): ProfileCollector {
	const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
	const maxBufferedEvents = options.maxBufferedEvents ?? MAX_BUFFERED_EVENTS;
	const maxEventsPerMessage =
		options.maxEventsPerMessage ?? MAX_EVENTS_PER_MESSAGE;

	let activeSessionId: string | null = null;
	let flushTimer: number | null = null;
	const buffer: ProfileEvent[] = [];

	const now = (): number => {
		if (typeof performance !== "undefined" && performance.now) {
			return performance.now();
		}
		return Date.now();
	};

	const emitError = (error: unknown): void => {
		if (!activeSessionId) return;
		const message = error instanceof Error ? error.message : String(error);
		try {
			options.postMessage({
				type: "profile-error",
				sessionId: activeSessionId,
				error: message,
			});
		} catch {
			// Swallow: profiling should never crash the webview.
		}
	};

	const scheduleFlush = (delayMs: number): void => {
		if (flushTimer !== null) return;
		flushTimer = window.setTimeout(() => {
			flushTimer = null;
			flush();
		}, delayMs);
	};

	const enqueue = (event: ProfileEvent): void => {
		if (!activeSessionId) return;
		buffer.push(event);
		if (buffer.length >= maxBufferedEvents) {
			scheduleFlush(0);
			return;
		}
		scheduleFlush(flushIntervalMs);
	};

	const flush = (): void => {
		if (!activeSessionId || buffer.length === 0) return;
		try {
			while (buffer.length > 0) {
				const events = buffer.splice(0, maxEventsPerMessage);
				options.postMessage({
					type: "profile-data",
					sessionId: activeSessionId,
					events,
				});
			}
		} catch (error) {
			emitError(error);
		}
	};

	const buildEvent = (
		name: string,
		ts: number,
		dur?: number,
		data?: ProfileData,
		override?: ProfileRecordOptions,
	): ProfileEvent => ({
		name,
		ts,
		dur,
		data,
		source: override?.source ?? options.source,
		terminalId: override?.terminalId ?? options.terminalId,
	});

	const recordEvent = (
		name: string,
		data?: ProfileData,
		override?: ProfileRecordOptions,
	): void => {
		if (!activeSessionId) return;
		enqueue(buildEvent(name, now(), undefined, data, override));
	};

	const recordDuration = (
		name: string,
		start: number | null,
		data?: ProfileData,
		override?: ProfileRecordOptions,
	): void => {
		if (!activeSessionId || start === null) return;
		const end = now();
		enqueue(buildEvent(name, start, end - start, data, override));
	};

	const hook: ProfileHook = {
		enabled: false,
		now,
		record: (event) => {
			if (!activeSessionId) return;
			const ts = event.ts ?? now();
			enqueue(buildEvent(event.name, ts, event.dur, event.data));
		},
	};

	const start = (sessionId: string): void => {
		activeSessionId = sessionId;
		hook.enabled = true;
		window.__BOOTTY_PROFILE__ = hook;
		buffer.length = 0;
		recordEvent("bootty:profile-meta", {
			timeOrigin:
				typeof performance !== "undefined" ? performance.timeOrigin : null,
			userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
			url: typeof location !== "undefined" ? location.href : null,
			visibility:
				typeof document !== "undefined" ? document.visibilityState : null,
			devicePixelRatio:
				typeof window !== "undefined" ? window.devicePixelRatio : null,
		});
	};

	const stop = (sessionId: string): void => {
		if (!activeSessionId || sessionId !== activeSessionId) return;
		flush();
		activeSessionId = null;
		hook.enabled = false;
		if (flushTimer !== null) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
	};

	return {
		start,
		stop,
		isActive: () => activeSessionId !== null,
		recordEvent,
		startSpan: () => (activeSessionId ? now() : null),
		recordDuration,
	};
}
