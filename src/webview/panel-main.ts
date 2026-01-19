/**
 * Panel webview script for multi-terminal management.
 * Handles tab bar UI and multiple terminal instances within a single webview.
 */

import debug from "debug";

// Enable debug logging early from localStorage (before any debug() calls)
// This ensures WebGLRenderer constructor/attach logs are captured
const storedDebug = localStorage.getItem("debug");
if (storedDebug) {
	debug.enable(storedDebug);
}

// Import WebGL renderer (bundled by esbuild)
import { WebGLRenderer } from "@0xbigboss/libghostty-webgl";

const logWebgl = debug("bootty:panel:webgl");

import {
	createFileCache,
	extractPathsFromDataTransfer,
	isWindowsPlatform,
	quoteShellPath,
	resolvePath as resolvePathUtil,
} from "../file-cache";
import {
	getKeyHandlerResult,
	isClearScreenShortcut,
	isDeleteLineShortcut,
	isLineEndShortcut,
	isLineStartShortcut,
	isMacPlatform,
	isNextTabShortcut,
	isPrevTabShortcut,
	isSearchShortcut,
} from "../keybinding-utils";
import type {
	PanelExtensionMessage,
	PanelWebviewMessage,
	RendererMode,
	RendererStatus,
	RendererType,
	RuntimeConfig,
	TerminalGroup,
	TerminalTheme,
} from "../types/messages";
import type { TerminalId } from "../types/terminal";
import { ContextMenu } from "./context-menu";
import { createProfileCollector } from "./profile-collector";
import { createRenderer } from "./renderer-utils";
import {
	createSearchController,
	type SearchController,
} from "./search-controller";
import { TerminalList, type TerminalListItem } from "./terminal-list";

// Declare VS Code API (provided by webview host)
declare function acquireVsCodeApi(): {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
};

// Initialize VS Code API (must be called exactly once)
const vscode = acquireVsCodeApi();

// Webview state persistence interface
interface WebviewState {
	tabs?: Array<{ id: TerminalId; title: string; active: boolean }>;
	currentCwd?: Record<TerminalId, string>;
}

// Terminal instance managed within the panel
interface PanelTerminal {
	id: TerminalId;
	title: string;
	term: unknown; // ghostty-web Terminal instance
	fitAddon: unknown; // FitAddon instance
	container: HTMLElement;
	currentCwd?: string;
	searchController: SearchController;
	themeObserver: MutationObserver;
	resizeObserver: ResizeObserver;
}

// Wrap in async IIFE for top-level await
const boottyPanelInit = async (): Promise<void> => {
	const WASM_URL = document.body.dataset.wasmUrl || "";
	const RENDERER_MODE = (document.body.dataset.renderer ||
		"auto") as RendererMode;
	const scrollbackValue = Number.parseInt(
		document.body.dataset.scrollback ?? "",
		10,
	);
	const SCROLLBACK =
		Number.isFinite(scrollbackValue) && scrollbackValue > 0
			? scrollbackValue
			: 1000;
	const profileCollector = createProfileCollector({
		source: "panel",
		postMessage: (message) => vscode.postMessage(message),
	});

	// Restore persisted state
	const savedState = vscode.getState() as WebviewState | undefined;

	// Terminal instances
	const terminals = new Map<TerminalId, PanelTerminal>();
	let activeTerminalId: TerminalId | null = null;

	// Track renderer info per terminal for status reporting
	const rendererInfo = new Map<
		TerminalId,
		{
			type: RendererType;
			status: RendererStatus;
			fallback: boolean;
			reason?: string;
		}
	>();

	// Scroll preservation state: coalesce multiple writes into single RAF per terminal
	const scrollRafState = new Map<
		TerminalId,
		{ pending: boolean; scrollOffset: number; scrollbackBefore: number }
	>();
	const scrollOffsets = new Map<TerminalId, number>();
	const scrollDisposables = new Map<TerminalId, { dispose?: () => void }>();
	const ptyQueueState = new Map<
		TerminalId,
		{
			pending: boolean;
			bytes: number;
			segments: number;
			adaptiveLatch: boolean;
			drainInFlight: boolean;
			drainQueued: boolean;
			pendingChunks: Uint8Array[];
			pendingBytes: number;
			pendingSegments: number;
			mergeScheduled: boolean;
			mergeChunks: Uint8Array[];
			mergeBytes: number;
		}
	>();
	const adaptiveMaxLinesByTerminal = new Map<TerminalId, number>();
	const benchDrainState = new Map<TerminalId, { token: string }>();
	const directWriteState = new Map<
		TerminalId,
		{
			token: string;
			payload: string;
			payloadBytes: number;
			repeatRemaining: number;
			repeatTotal: number;
			finalPayload?: string;
			finalPayloadBytes: number;
			writesPerFrame: number;
			cancelled: boolean;
		}
	>();
	let drainToken = 0;
	const pendingDrains = new Map<
		number,
		{
			terminalId: TerminalId;
			adaptiveApplied: boolean;
			byteAdaptive: boolean;
			maxLines: number;
			maxFrameMs: number;
			maxBytes: number;
			queueSegmentsBefore: number;
			queueBytesBefore: number;
		}
	>();
	async function createPtyDrainWorker(uri: string): Promise<Worker> {
		try {
			return new Worker(uri);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			try {
				const response = await fetch(uri);
				if (!response.ok) {
					throw new Error(`Fetch failed with status ${response.status}`);
				}
				const source = await response.text();
				const blobUrl = URL.createObjectURL(
					new Blob([source], { type: "text/javascript" }),
				);
				return new Worker(blobUrl);
			} catch (fetchError) {
				const fetchMessage =
					fetchError instanceof Error ? fetchError.message : String(fetchError);
				throw new Error(
					`Failed to create PTY drain worker. new Worker error: ${message}. Fetch fallback error: ${fetchMessage}.`,
				);
			}
		}
	}

	const ptyWorkerUri = document.body.dataset.ptyWorkerUri;
	if (!ptyWorkerUri) {
		throw new Error("PTY drain worker URI missing.");
	}
	const ptyWorker = await createPtyDrainWorker(ptyWorkerUri);
	type DrainResultMessage = {
		type: "drain-result";
		terminalId: TerminalId;
		token: number;
		output: Uint8Array;
		drainedLines: number;
		drainedBytes: number;
		durationMs: number;
		queueSegmentsBefore: number;
		queueSegmentsAfter: number;
		queueBytesBefore: number;
		queueBytesAfter: number;
	};

	ptyWorker.addEventListener("message", (event: MessageEvent) => {
		const msg = event.data as DrainResultMessage;
		if (msg.type !== "drain-result") return;
		const pending = pendingDrains.get(msg.token);
		pendingDrains.delete(msg.token);
		const state = getPtyQueueState(msg.terminalId);
		state.drainInFlight = false;

		if (pending) {
			state.bytes = msg.queueBytesAfter;
			state.segments = msg.queueSegmentsAfter;
			if (profileCollector.isActive()) {
				profileCollector.recordEvent(
					"bootty:webview:pty-drain",
					{
						queueSegmentsBefore: pending.queueSegmentsBefore,
						queueSegmentsAfter: msg.queueSegmentsAfter,
						queueBytesBefore: pending.queueBytesBefore,
						queueBytesAfter: msg.queueBytesAfter,
						drainedLines: msg.drainedLines,
						drainedBytes: msg.drainedBytes,
						durationMs: msg.durationMs,
						maxLines: pending.maxLines,
						maxFrameMs: pending.maxFrameMs,
						maxBytes: pending.maxBytes,
						adaptiveApplied: pending.adaptiveApplied,
						autoTuneApplied: runtimeConfig.ptyAdaptiveAutoTune,
						autoTuneMaxLines:
							adaptiveMaxLinesByTerminal.get(msg.terminalId) ?? null,
					},
					{ terminalId: msg.terminalId },
				);
			}
			if (
				pending.adaptiveApplied &&
				!pending.byteAdaptive &&
				runtimeConfig.ptyAdaptiveAutoTune &&
				pending.maxFrameMs > 0
			) {
				const baseMaxLines = getAdaptiveMaxLinesBase(msg.terminalId);
				if (baseMaxLines > 0) {
					const hitMaxLines = msg.drainedLines >= pending.maxLines;
					const targetMs = pending.maxFrameMs;
					if (hitMaxLines && msg.durationMs < targetMs * 0.6) {
						adaptiveMaxLinesByTerminal.set(
							msg.terminalId,
							Math.min(
								baseMaxLines,
								Math.max(
									pending.maxLines + 1,
									Math.ceil(pending.maxLines * 1.5),
								),
							),
						);
					} else if (msg.durationMs > targetMs * 1.1) {
						adaptiveMaxLinesByTerminal.set(
							msg.terminalId,
							Math.max(1, Math.floor(pending.maxLines * 0.7)),
						);
					} else if (!adaptiveMaxLinesByTerminal.has(msg.terminalId)) {
						adaptiveMaxLinesByTerminal.set(msg.terminalId, pending.maxLines);
					}
				}
			}
		}

		const output = msg.output;
		if (output.byteLength > 0) {
			const terminal = terminals.get(msg.terminalId);
			if (terminal) {
				const termApi = terminal.term as unknown as {
					write: (data: string | Uint8Array) => void;
					getViewportY?: () => number;
					getScrollbackLength?: () => number;
					scrollToLine?: (line: number) => void;
				};
				const hasScrollListener = scrollDisposables.has(msg.terminalId);
				const scrollOffset = hasScrollListener
					? (scrollOffsets.get(msg.terminalId) ?? 0)
					: (termApi.getViewportY?.() ?? 0);
				let rafState = scrollRafState.get(msg.terminalId);
				if ((!rafState || !rafState.pending) && scrollOffset > 0) {
					rafState = {
						pending: false,
						scrollOffset,
						scrollbackBefore: termApi.getScrollbackLength?.() ?? 0,
					};
					scrollRafState.set(msg.terminalId, rafState);
				}
				const writeStart = profileCollector.startSpan();
				termApi.write(output);
				profileCollector.recordDuration(
					"bootty:webview:pty-write",
					writeStart,
					{ bytes: output.byteLength },
					{ terminalId: msg.terminalId },
				);
				if (
					scrollOffset > 0 &&
					termApi.scrollToLine &&
					rafState &&
					!rafState.pending
				) {
					rafState.pending = true;
					const scrollToLine = termApi.scrollToLine;
					requestAnimationFrame(() => {
						const state = scrollRafState.get(msg.terminalId);
						if (state) {
							state.pending = false;
							const scrollbackAfter = termApi.getScrollbackLength?.() ?? 0;
							const delta = scrollbackAfter - state.scrollbackBefore;
							scrollToLine(state.scrollOffset + delta);
						}
					});
				}
			}
		}

		if (state.pendingChunks.length > 0) {
			for (const chunk of state.pendingChunks) {
				ptyWorker.postMessage(
					{ type: "enqueue", terminalId: msg.terminalId, data: chunk },
					[chunk.buffer],
				);
			}
			state.bytes += state.pendingBytes;
			state.segments += state.pendingSegments;
			state.pendingChunks.length = 0;
			state.pendingBytes = 0;
			state.pendingSegments = 0;
		}

		if (state.bytes > 0) {
			schedulePtyFlush(msg.terminalId);
		} else if (state.drainQueued) {
			state.drainQueued = false;
			schedulePtyFlush(msg.terminalId);
		}
	});

	function getAdaptiveMaxLinesBase(terminalId: TerminalId): number {
		const renderer = rendererInfo.get(terminalId)?.type;
		if (renderer === "webgl") {
			const webglAdaptive = runtimeConfig.ptyAdaptiveMaxLinesPerFrameWebgl ?? 0;
			if (webglAdaptive > 0) return webglAdaptive;
		}
		return runtimeConfig.ptyAdaptiveMaxLinesPerFrame ?? 0;
	}

	function resolvePtyMaxLines(
		terminalId: TerminalId,
		term: { rows?: number },
		adaptiveApplied: boolean,
		baseMaxLines: number,
	): number {
		if (adaptiveApplied) {
			if (
				runtimeConfig.ptyAdaptiveAutoTune &&
				adaptiveMaxLinesByTerminal.has(terminalId)
			) {
				return Math.max(1, adaptiveMaxLinesByTerminal.get(terminalId) ?? 1);
			}
			if (baseMaxLines > 0) return baseMaxLines;
		}
		const configured = runtimeConfig.ptyMaxLinesPerFrame ?? 0;
		if (configured > 0) return configured;
		const rows = term.rows ?? 0;
		return Math.max(1, rows - 1);
	}

	function resolvePtyMaxFrameMs(
		state: { adaptiveLatch: boolean },
		queueSegmentsBefore: number,
		queueBytesBefore: number,
	): {
		maxFrameMs: number;
		adaptiveApplied: boolean;
	} {
		const configured = runtimeConfig.ptyMaxFrameMs ?? 0;
		if (configured > 0) {
			return { maxFrameMs: configured, adaptiveApplied: false };
		}
		if (!runtimeConfig.ptyAdaptiveDrain) {
			return { maxFrameMs: 0, adaptiveApplied: false };
		}
		const hysteresisRatio = Math.max(
			0,
			Math.min(0.99, runtimeConfig.ptyAdaptiveQueueHysteresisRatio ?? 0),
		);
		const thresholdBytes = runtimeConfig.ptyAdaptiveQueueBytesThreshold ?? 0;
		if (thresholdBytes > 0) {
			if (queueBytesBefore <= 0 && queueSegmentsBefore <= 0) {
				return { maxFrameMs: 0, adaptiveApplied: false };
			}
			return {
				maxFrameMs: runtimeConfig.ptyAdaptiveFrameMs ?? 0,
				adaptiveApplied: true,
			};
		} else {
			const threshold = runtimeConfig.ptyAdaptiveQueueThreshold ?? 0;
			const lower = Math.max(0, Math.floor(threshold * hysteresisRatio));
			if (state.adaptiveLatch) {
				if (queueSegmentsBefore <= lower) {
					state.adaptiveLatch = false;
				} else {
					return {
						maxFrameMs: runtimeConfig.ptyAdaptiveFrameMs ?? 0,
						adaptiveApplied: true,
					};
				}
			}
			if (queueSegmentsBefore < threshold) {
				return { maxFrameMs: 0, adaptiveApplied: false };
			}
			state.adaptiveLatch = true;
		}
		return {
			maxFrameMs: runtimeConfig.ptyAdaptiveFrameMs ?? 0,
			adaptiveApplied: true,
		};
	}

	function resolveAdaptiveMinBytes(
		queueBytesBefore: number,
		adaptiveApplied: boolean,
		byteAdaptive: boolean,
		maxBytes: number,
	): number {
		if (!adaptiveApplied || !byteAdaptive) return 0;
		const thresholdBytes = runtimeConfig.ptyAdaptiveQueueBytesThreshold ?? 0;
		if (thresholdBytes <= 0) return 0;
		const minBytes = runtimeConfig.ptyAdaptiveMinBytesPerFrame ?? 0;
		const queueTarget = Math.min(queueBytesBefore, thresholdBytes);
		const minTarget = minBytes > 0 ? Math.min(queueBytesBefore, minBytes) : 0;
		const target = Math.max(queueTarget, minTarget);
		if (maxBytes > 0) return Math.min(target, maxBytes);
		return target;
	}

	function resolvePtyMaxBytesPerFrame(): number {
		return runtimeConfig.ptyMaxBytesPerFrame ?? 0;
	}

	function getPtyQueueState(id: TerminalId): {
		pending: boolean;
		bytes: number;
		segments: number;
		adaptiveLatch: boolean;
		drainInFlight: boolean;
		drainQueued: boolean;
		pendingChunks: Uint8Array[];
		pendingBytes: number;
		pendingSegments: number;
		mergeScheduled: boolean;
		mergeChunks: Uint8Array[];
		mergeBytes: number;
	} {
		let state = ptyQueueState.get(id);
		if (!state) {
			state = {
				pending: false,
				bytes: 0,
				segments: 0,
				adaptiveLatch: false,
				drainInFlight: false,
				drainQueued: false,
				pendingChunks: [],
				pendingBytes: 0,
				pendingSegments: 0,
				mergeScheduled: false,
				mergeChunks: [],
				mergeBytes: 0,
			};
			ptyQueueState.set(id, state);
		}
		return state;
	}

	function mergePtyChunks(
		chunks: Uint8Array[],
		totalBytes: number,
	): Uint8Array {
		if (chunks.length === 1) return chunks[0];
		const merged = new Uint8Array(totalBytes);
		let offset = 0;
		for (const chunk of chunks) {
			merged.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return merged;
	}

	function flushMergedPtyData(terminalId: TerminalId): void {
		const state = ptyQueueState.get(terminalId);
		if (!state) return;
		state.mergeScheduled = false;
		if (state.mergeBytes === 0) {
			state.mergeChunks.length = 0;
			return;
		}
		const merged = mergePtyChunks(state.mergeChunks, state.mergeBytes);
		state.mergeChunks.length = 0;
		state.mergeBytes = 0;
		if (state.drainInFlight) {
			state.pendingChunks.push(merged);
			state.pendingBytes += merged.byteLength;
			state.pendingSegments += 1;
		} else {
			ptyWorker.postMessage({ type: "enqueue", terminalId, data: merged }, [
				merged.buffer,
			]);
			state.bytes += merged.byteLength;
			state.segments += 1;
		}
		schedulePtyFlush(terminalId);
	}

	function schedulePtyFlush(id: TerminalId): void {
		const state = getPtyQueueState(id);
		if (state.pending) return;
		state.pending = true;
		requestAnimationFrame(() => {
			state.pending = false;
			flushPtyQueue(id);
		});
	}

	function startDirectWrite(
		terminalId: TerminalId,
		payload: string,
		repeat: number,
		finalPayload: string | undefined,
		writesPerFrame: number,
		token: string,
	): void {
		const terminal = terminals.get(terminalId);
		if (!terminal) {
			vscode.postMessage({
				type: "bench-direct-write-complete",
				terminalId,
				token,
			} satisfies PanelWebviewMessage);
			return;
		}
		const existing = directWriteState.get(terminalId);
		if (existing) {
			existing.cancelled = true;
		}
		const state = {
			token,
			payload,
			payloadBytes: payload.length,
			repeatRemaining: Math.max(0, repeat),
			repeatTotal: Math.max(0, repeat),
			finalPayload,
			finalPayloadBytes: finalPayload?.length ?? 0,
			writesPerFrame: Math.max(0, writesPerFrame),
			cancelled: false,
		};
		directWriteState.set(terminalId, state);
		profileCollector.recordEvent(
			"bootty:webview:bench-direct-write",
			{
				payloadBytes: payload.length,
				repeat,
				finalPayloadBytes: finalPayload?.length ?? 0,
				writesPerFrame: state.writesPerFrame,
			},
			{ terminalId },
		);
		requestAnimationFrame(() => runDirectWrite(terminalId));
	}

	function runDirectWrite(terminalId: TerminalId): void {
		const state = directWriteState.get(terminalId);
		if (!state || state.cancelled) return;
		const terminal = terminals.get(terminalId);
		if (!terminal) {
			directWriteState.delete(terminalId);
			vscode.postMessage({
				type: "bench-direct-write-complete",
				terminalId,
				token: state.token,
			} satisfies PanelWebviewMessage);
			return;
		}
		const term = terminal.term as unknown as {
			write: (data: string | Uint8Array) => void;
		};
		const unlimited = state.writesPerFrame <= 0;
		let writes = 0;
		while (
			state.repeatRemaining > 0 &&
			(unlimited || writes < state.writesPerFrame)
		) {
			term.write(state.payload);
			state.repeatRemaining -= 1;
			writes += 1;
		}
		if (state.repeatRemaining === 0 && state.finalPayload) {
			term.write(state.finalPayload);
			state.finalPayload = undefined;
		}
		if (state.repeatRemaining > 0 || state.finalPayload) {
			requestAnimationFrame(() => runDirectWrite(terminalId));
			return;
		}
		directWriteState.delete(terminalId);
		profileCollector.recordEvent(
			"bootty:webview:bench-direct-write-complete",
			{
				totalWrites: state.repeatTotal + (state.finalPayloadBytes > 0 ? 1 : 0),
				totalBytes:
					state.repeatTotal * state.payloadBytes + state.finalPayloadBytes,
			},
			{ terminalId },
		);
		requestAnimationFrame(() => {
			vscode.postMessage({
				type: "bench-direct-write-complete",
				terminalId,
				token: state.token,
			} satisfies PanelWebviewMessage);
		});
	}

	function scheduleBenchDrain(id: TerminalId, token: string): void {
		benchDrainState.set(id, { token });
		const check = () => {
			const state = getPtyQueueState(id);
			if (state.bytes === 0 && !state.pending && !state.drainInFlight) {
				requestAnimationFrame(() => {
					vscode.postMessage({
						type: "bench-drain-complete",
						terminalId: id,
						token,
					});
				});
				benchDrainState.delete(id);
				return;
			}
			requestAnimationFrame(check);
		};
		requestAnimationFrame(check);
	}

	function flushPtyQueue(id: TerminalId): void {
		const terminal = terminals.get(id);
		if (!terminal) return;
		const state = getPtyQueueState(id);
		if (state.drainInFlight) {
			state.drainQueued = true;
			return;
		}
		if (state.segments === 0) return;
		const term = terminal.term as unknown as { rows?: number };
		const queueSegmentsBefore = state.segments;
		const queueBytesBefore = state.bytes;
		const { maxFrameMs, adaptiveApplied } = resolvePtyMaxFrameMs(
			state,
			queueSegmentsBefore,
			queueBytesBefore,
		);
		const byteAdaptive =
			(runtimeConfig.ptyAdaptiveQueueBytesThreshold ?? 0) > 0;
		const baseMaxLines = getAdaptiveMaxLinesBase(id);
		const maxLines = byteAdaptive
			? 0
			: resolvePtyMaxLines(id, term, adaptiveApplied, baseMaxLines);
		const maxBytes = resolvePtyMaxBytesPerFrame();
		const minBytes = resolveAdaptiveMinBytes(
			queueBytesBefore,
			adaptiveApplied,
			byteAdaptive,
			maxBytes,
		);
		const token = drainToken++;
		pendingDrains.set(token, {
			terminalId: id,
			adaptiveApplied,
			byteAdaptive,
			maxLines,
			maxFrameMs,
			maxBytes,
			queueSegmentsBefore,
			queueBytesBefore,
		});
		state.drainInFlight = true;
		ptyWorker.postMessage({
			type: "drain",
			terminalId: id,
			maxLines,
			maxFrameMs,
			maxBytes,
			minBytes,
			token,
		});
	}

	// Runtime config (updated via update-config message)
	let runtimeConfig: RuntimeConfig = {
		bellStyle: "visual",
		renderer: RENDERER_MODE,
		debugLog: "",
		ptyMaxLinesPerFrame: 0,
		ptyMaxFrameMs: 0,
		ptyMaxBytesPerFrame: 0,
		ptyAdaptiveDrain: false,
		ptyAdaptiveFrameMs: 0,
		ptyAdaptiveQueueThreshold: 0,
		ptyAdaptiveMaxLinesPerFrame: 0,
		ptyAdaptiveMaxLinesPerFrameWebgl: 0,
		ptyAdaptiveAutoTune: true,
		ptyAdaptiveMinBytesPerFrame: 0,
		ptyAdaptiveQueueBytesThreshold: 0,
		ptyAdaptiveQueueHysteresisRatio: 0,
	};
	let runtimeConfigUpdated = false;

	// File existence cache
	const fileCache = createFileCache(5000, 100);

	// Batching state for file existence checks (reduced round-trips)
	// Each batch gets a unique ID; callbacks are tracked per-batch to avoid cross-batch interference
	let nextBatchId = 0;
	// Map: batchId -> Map<path, callbacks[]>
	const pendingBatches = new Map<
		number,
		Map<string, Array<(exists: boolean) => void>>
	>();
	// Current batch being accumulated (not yet sent)
	let currentBatchCallbacks = new Map<
		string,
		Array<(exists: boolean) => void>
	>();
	let currentBatchId = nextBatchId++;
	let batchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	const BATCH_DEBOUNCE_MS = 50;

	// Platform detection
	const IS_MAC = isMacPlatform(navigator);
	const IS_WINDOWS = isWindowsPlatform(navigator);

	// Initialize ghostty-web wasm (matching probe pattern)
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const GhosttyModule =
		(window as any).GhosttyWeb || (window as any).ghosttyWeb;

	if (!GhosttyModule) {
		throw new Error("ghostty-web failed to load: GhosttyWeb global not found.");
	}

	const Ghostty = GhosttyModule.Ghostty || GhosttyModule.default?.Ghostty;
	let ghosttyInstance: unknown = null;

	if (Ghostty && typeof Ghostty.load === "function") {
		ghosttyInstance = await Ghostty.load(WASM_URL);
	} else if (GhosttyModule.init && typeof GhosttyModule.init === "function") {
		await GhosttyModule.init();
	} else if (GhosttyModule.default?.init) {
		await GhosttyModule.default.init();
	}

	const Terminal = GhosttyModule.Terminal || GhosttyModule.default?.Terminal;
	const FitAddon = GhosttyModule.FitAddon || GhosttyModule.default?.FitAddon;

	if (!Terminal) throw new Error("ghostty-web Terminal not found");
	if (!FitAddon) throw new Error("ghostty-web FitAddon not found");

	// Pre-compiled file path pattern for link detection performance
	const FILE_PATH_PATTERN_SINGLE =
		/^((?:[a-zA-Z]:)?(?:\.{0,2}[\\/])?[\w.\\/-]+\.[a-zA-Z0-9]+)(?:[:(](\d+)(?:[,:](\d+))?[\])]?)?$/;

	// DOM elements
	const terminalsContainer = document.getElementById("terminals-container")!;
	const terminalListContainer = document.getElementById(
		"terminal-list-container",
	)!;

	// Terminal groups for split terminal support
	const groups = new Map<string, TerminalGroup>();

	// Initialize terminal list component
	const terminalList = new TerminalList(
		terminalListContainer,
		{
			onSelect: (id) => {
				// Update selection and notify extension
				terminalList.setSelected(id);
				activateTerminal(id);
				vscode.postMessage({
					type: "terminal-selected",
					terminalId: id,
				} satisfies PanelWebviewMessage);
			},
			onClose: (id) => {
				vscode.postMessage({
					type: "tab-close-requested",
					terminalId: id,
				} satisfies PanelWebviewMessage);
			},
			onSplit: (id) => {
				vscode.postMessage({
					type: "split-requested",
					terminalId: id,
				} satisfies PanelWebviewMessage);
			},
			onContextMenu: (id, x, y) => {
				const terminal = terminals.get(id);
				if (!terminal) return;

				// Find group ID for this terminal
				let terminalGroupId: string | undefined;
				for (const [gid, group] of groups) {
					if (group.terminals.includes(id)) {
						terminalGroupId = gid;
						break;
					}
				}

				// Build group name map for context menu
				const groupNames = new Map<string, string>();
				for (const [groupId, group] of groups) {
					const names = group.terminals
						.map((tid) => terminals.get(tid)?.title || "Terminal")
						.join(", ");
					groupNames.set(groupId, names);
				}

				contextMenu.setGroups(Array.from(groups.values()));
				contextMenu.show(
					id,
					x,
					y,
					!!terminalGroupId,
					terminalGroupId,
					groupNames,
				);
			},
			onMultiSelectContextMenu: (ids, x, y) => {
				contextMenu.showMultiSelect(ids, x, y);
			},
			onReorder: (ids) => {
				vscode.postMessage({
					type: "terminals-reordered",
					terminalIds: ids,
				} satisfies PanelWebviewMessage);
			},
			onGroupReorder: (groupId, terminalIds) => {
				vscode.postMessage({
					type: "group-reordered",
					groupId,
					terminalIds,
				} satisfies PanelWebviewMessage);
			},
			onWidthChange: (width) => {
				vscode.postMessage({
					type: "list-width-changed",
					width,
				} satisfies PanelWebviewMessage);
			},
			onNewTerminal: () => {
				vscode.postMessage({
					type: "new-tab-requested",
				} satisfies PanelWebviewMessage);
			},
		},
		180, // Default width
	);

	// Initialize context menu
	const contextMenu = new ContextMenu({
		onSplit: (id) => {
			vscode.postMessage({
				type: "split-requested",
				terminalId: id,
			} satisfies PanelWebviewMessage);
		},
		onUnsplit: (id) => {
			vscode.postMessage({
				type: "unsplit-requested",
				terminalId: id,
			} satisfies PanelWebviewMessage);
		},
		onJoin: (id, targetGroupId) => {
			vscode.postMessage({
				type: "join-requested",
				terminalId: id,
				targetGroupId,
			} satisfies PanelWebviewMessage);
		},
		onColorPicker: (id) => {
			// Request extension to show color picker
			vscode.postMessage({
				type: "color-picker-requested",
				terminalId: id,
			} satisfies PanelWebviewMessage);
		},
		onIconPicker: (id) => {
			// Request extension to show icon picker
			vscode.postMessage({
				type: "icon-picker-requested",
				terminalId: id,
			} satisfies PanelWebviewMessage);
		},
		onRename: (id) => {
			// Send request to extension to show VS Code input box
			vscode.postMessage({
				type: "rename-requested",
				terminalId: id,
			} satisfies PanelWebviewMessage);
		},
		onKill: (id) => {
			vscode.postMessage({
				type: "tab-close-requested",
				terminalId: id,
			} satisfies PanelWebviewMessage);
		},
		onGroupSelected: (ids) => {
			vscode.postMessage({
				type: "group-selected-requested",
				terminalIds: ids,
			} satisfies PanelWebviewMessage);
		},
		onKillSelected: (ids) => {
			// Kill each selected terminal
			for (const id of ids) {
				vscode.postMessage({
					type: "tab-close-requested",
					terminalId: id,
				} satisfies PanelWebviewMessage);
			}
		},
	});

	// ResizeObserver on terminals container to recalculate split pane widths
	let containerResizeTimer: ReturnType<typeof setTimeout> | null = null;
	const containerResizeObserver = new ResizeObserver(() => {
		if (containerResizeTimer) clearTimeout(containerResizeTimer);
		containerResizeTimer = setTimeout(() => {
			containerResizeTimer = null;
			// Recalculate split pane widths if there's an active terminal
			if (activeTerminalId) {
				activateTerminal(activeTerminalId);
			}
		}, 50);
	});
	containerResizeObserver.observe(terminalsContainer);

	// Read theme colors from VS Code CSS variables
	function getVSCodeThemeColors(): TerminalTheme {
		const style = getComputedStyle(document.documentElement);
		const get = (name: string, ...fallbacks: string[]): string | undefined => {
			let value = style.getPropertyValue(name).trim();
			if (!value) {
				for (const fallback of fallbacks) {
					value = style.getPropertyValue(fallback).trim();
					if (value) break;
				}
			}
			return value || undefined;
		};

		return {
			foreground: get(
				"--vscode-editor-foreground",
				"--vscode-foreground",
				"--vscode-terminal-foreground",
			),
			background: get(
				"--vscode-editor-background",
				"--vscode-panel-background",
				"--vscode-terminal-background",
			),
			cursor: get(
				"--vscode-editorCursor-foreground",
				"--vscode-terminalCursor-foreground",
			),
			cursorAccent: get(
				"--vscode-editorCursor-background",
				"--vscode-editor-background",
			),
			selectionBackground: get(
				"--vscode-editor-selectionBackground",
				"--vscode-terminal-selectionBackground",
			),
			selectionForeground: get(
				"--vscode-editor-selectionForeground",
				"--vscode-terminal-selectionForeground",
			),
			black: get("--vscode-terminal-ansiBlack"),
			red: get("--vscode-terminal-ansiRed"),
			green: get("--vscode-terminal-ansiGreen"),
			yellow: get("--vscode-terminal-ansiYellow"),
			blue: get("--vscode-terminal-ansiBlue"),
			magenta: get("--vscode-terminal-ansiMagenta"),
			cyan: get("--vscode-terminal-ansiCyan"),
			white: get("--vscode-terminal-ansiWhite"),
			brightBlack: get("--vscode-terminal-ansiBrightBlack"),
			brightRed: get("--vscode-terminal-ansiBrightRed"),
			brightGreen: get("--vscode-terminal-ansiBrightGreen"),
			brightYellow: get("--vscode-terminal-ansiBrightYellow"),
			brightBlue: get("--vscode-terminal-ansiBrightBlue"),
			brightMagenta: get("--vscode-terminal-ansiBrightMagenta"),
			brightCyan: get("--vscode-terminal-ansiBrightCyan"),
			brightWhite: get("--vscode-terminal-ansiBrightWhite"),
		};
	}

	// Flush batch of file existence checks to extension
	function flushBatchFileChecks(terminalId: TerminalId): void {
		if (currentBatchCallbacks.size === 0) return;

		// Move current batch to pending and start a new batch
		const batchId = currentBatchId;
		const batchCallbacks = currentBatchCallbacks;
		pendingBatches.set(batchId, batchCallbacks);

		// Start fresh batch for new requests
		currentBatchId = nextBatchId++;
		currentBatchCallbacks = new Map();

		const paths = Array.from(batchCallbacks.keys());
		vscode.postMessage({
			type: "batch-check-file-exists",
			terminalId,
			batchId,
			paths,
		});

		// Set timeout for this specific batch - resolve as false if no response
		setTimeout(() => {
			const batch = pendingBatches.get(batchId);
			if (batch) {
				pendingBatches.delete(batchId);
				for (const [path, callbacks] of batch) {
					fileCache.set(path, false);
					for (const cb of callbacks) {
						cb(false);
					}
				}
			}
		}, 2000);
	}

	// Check if a file exists via extension (with caching and batching)
	function _checkFileExists(
		path: string,
		terminalId: TerminalId,
	): Promise<boolean> {
		const cached = fileCache.get(path);
		if (cached !== undefined) {
			return Promise.resolve(cached);
		}

		return new Promise((resolve) => {
			// Add callback to current batch
			const existing = currentBatchCallbacks.get(path);
			if (existing) {
				// Path already in this batch, just add callback
				existing.push(resolve);
			} else {
				currentBatchCallbacks.set(path, [resolve]);
			}

			// Reset debounce timer
			if (batchDebounceTimer) {
				clearTimeout(batchDebounceTimer);
			}
			batchDebounceTimer = setTimeout(() => {
				batchDebounceTimer = null;
				flushBatchFileChecks(terminalId);
			}, BATCH_DEBOUNCE_MS);
		});
	}

	// Create a terminal instance
	function createTerminal(id: TerminalId, title: string): PanelTerminal {
		// Create container
		const wrapper = document.createElement("div");
		wrapper.className = "terminal-wrapper";
		wrapper.dataset.terminalId = id;

		const container = document.createElement("div");
		container.className = "terminal-container";
		wrapper.appendChild(container);
		terminalsContainer.appendChild(wrapper);

		// Create renderer based on current runtime config (reflects latest setting value)
		const rendererResult = createRenderer(
			runtimeConfig.renderer,
			() =>
				new WebGLRenderer({
					onContextLoss: () => {
						// WebGL context lost after repeated failures - renderer is degraded
						// Note: The terminal still uses the WebGL renderer (no runtime swap),
						// but it's no longer rendering. Report accurate status.
						console.warn(
							`[bootty] WebGL context lost for terminal ${id} - renderer degraded`,
						);
						const existingInfo = rendererInfo.get(id);
						rendererInfo.set(id, {
							type: existingInfo?.type ?? "webgl", // Keep actual type
							status: "degraded",
							fallback: existingInfo?.fallback ?? false,
							reason: "WebGL context lost after repeated failures",
						});
						vscode.postMessage({
							type: "renderer-status",
							terminalId: id,
							renderer: existingInfo?.type ?? ("webgl" as RendererType),
							status: "degraded",
							fallback: existingInfo?.fallback ?? false,
							reason: "WebGL context lost after repeated failures",
						});
					},
				}),
		);

		// Track renderer info for this terminal
		rendererInfo.set(id, {
			type: rendererResult.type,
			status: "active",
			fallback: rendererResult.fallback,
			reason: rendererResult.reason,
		});
		profileCollector.recordEvent(
			"bootty:renderer-info",
			{
				renderer: rendererResult.type,
				mode: runtimeConfig.renderer,
				fallback: rendererResult.fallback,
				reason: rendererResult.reason ?? null,
			},
			{ terminalId: id },
		);

		// Debug: log renderer result
		logWebgl(
			"rendererResult: type=%s hasRenderer=%s rendererType=%s",
			rendererResult.type,
			!!rendererResult.renderer,
			rendererResult.renderer?.constructor?.name,
		);

		// Create terminal (using any for ghostty-web Terminal options)
		const termOptions: any = {
			cols: 80,
			rows: 24,
			scrollback: SCROLLBACK,
			// Enable Option key as Meta on Mac for word navigation (Option+Left/Right)
			macOptionIsMeta: IS_MAC,
			// Use custom renderer if available
			renderer: rendererResult.renderer,
			onLinkClick: (url: string, event: MouseEvent) => {
				if (event.ctrlKey || event.metaKey) {
					// Use pre-compiled pattern for performance
					const fileMatch = url.match(FILE_PATH_PATTERN_SINGLE);
					if (fileMatch) {
						const [, filePath, lineStr, colStr] = fileMatch;
						const terminal = terminals.get(id);
						const absolutePath = terminal?.currentCwd
							? resolvePathUtil(filePath, terminal.currentCwd)
							: filePath;
						vscode.postMessage({
							type: "open-file",
							terminalId: id,
							path: absolutePath,
							line: lineStr ? Number.parseInt(lineStr, 10) : undefined,
							column: colStr ? Number.parseInt(colStr, 10) : undefined,
						});
						return true;
					}
					vscode.postMessage({ type: "open-url", terminalId: id, url });
					return true;
				}
				return false;
			},
		};
		if (ghosttyInstance) {
			termOptions.ghostty = ghosttyInstance;
		}
		logWebgl(
			"Creating Terminal with options.renderer: %s",
			termOptions.renderer?.constructor?.name,
		);
		const term = new Terminal(termOptions);

		const fitAddon = new FitAddon();
		term.loadAddon(fitAddon);
		term.open(container);
		logWebgl("Terminal opened, checking internal renderer...");
		scrollOffsets.set(id, 0);
		const scrollDisposable = (
			term as {
				onScroll?: (listener: (offset: number) => void) => {
					dispose?: () => void;
				};
			}
		).onScroll?.((offset) => {
			scrollOffsets.set(id, offset);
		});
		if (scrollDisposable) {
			scrollDisposables.set(id, scrollDisposable);
		}

		// Apply theme
		term.options.theme = getVSCodeThemeColors();

		// Watch for theme changes
		const themeObserver = new MutationObserver(() => {
			term.options.theme = getVSCodeThemeColors();
		});
		themeObserver.observe(document.body, {
			attributes: true,
			attributeFilter: ["class"],
		});
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["style"],
		});

		// Keybinding passthrough
		term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
			if (isSearchShortcut(event, IS_MAC)) {
				event.preventDefault();
				// Access search controller from terminals map (will exist by the time user presses keys)
				const terminal = terminals.get(id);
				terminal?.searchController.show();
				return true;
			}
			if (isNextTabShortcut(event, IS_MAC)) {
				event.preventDefault();
				vscode.postMessage({ type: "next-tab-requested" });
				return true;
			}
			if (isPrevTabShortcut(event, IS_MAC)) {
				event.preventDefault();
				vscode.postMessage({ type: "prev-tab-requested" });
				return true;
			}
			if (isDeleteLineShortcut(event, IS_MAC)) {
				event.preventDefault();
				// Send Ctrl+U directly to PTY (bypasses term.input which needs wasUserInput:true)
				vscode.postMessage({
					type: "terminal-input",
					terminalId: id,
					data: "\x15",
				});
				return true;
			}
			if (isLineStartShortcut(event, IS_MAC)) {
				event.preventDefault();
				// Send Ctrl+A (beginning of line)
				vscode.postMessage({
					type: "terminal-input",
					terminalId: id,
					data: "\x01",
				});
				return true;
			}
			if (isLineEndShortcut(event, IS_MAC)) {
				event.preventDefault();
				// Send Ctrl+E (end of line)
				vscode.postMessage({
					type: "terminal-input",
					terminalId: id,
					data: "\x05",
				});
				return true;
			}
			if (isClearScreenShortcut(event, IS_MAC)) {
				event.preventDefault();
				// Send Ctrl+L (clear screen)
				vscode.postMessage({
					type: "terminal-input",
					terminalId: id,
					data: "\x0c",
				});
				return true;
			}
			return getKeyHandlerResult(event, IS_MAC, term.hasSelection?.() ?? false);
		});

		// Custom wheel handler for alternate screen (tmux/vim) with mouse tracking
		// When mouse tracking is enabled, synthesize SGR mouse wheel sequences
		term.attachCustomWheelEventHandler((event: WheelEvent) => {
			// Only intercept on alternate screen WITH mouse tracking enabled
			// Apps like tmux with `set -g mouse on` need SGR sequences
			// Apps like less/vim without mouse mode need the default arrow-key fallback
			if (term.buffer.active.type === "alternate" && term.hasMouseTracking()) {
				// Mouse tracking enabled - synthesize wheel escape sequences
				// Button 64 = wheel up, 65 = wheel down (SGR encoding)
				const button = event.deltaY < 0 ? 64 : 65;
				const lines = Math.min(Math.ceil(Math.abs(event.deltaY) / 33), 5);

				// Compute cell coordinates from pixel position
				const metrics = term.renderer?.getMetrics();
				let col = 1,
					row = 1;
				if (metrics && metrics.width > 0 && metrics.height > 0) {
					col = Math.max(
						1,
						Math.min(Math.floor(event.offsetX / metrics.width) + 1, term.cols),
					);
					row = Math.max(
						1,
						Math.min(Math.floor(event.offsetY / metrics.height) + 1, term.rows),
					);
				}

				for (let i = 0; i < lines; i++) {
					// SGR mouse format: CSI < button ; col ; row M
					vscode.postMessage({
						type: "terminal-input",
						terminalId: id,
						data: `\x1b[<${button};${col};${row}M`,
					});
				}
				return true; // We handled it
			}

			// Let ghostty-web handle: normal screen scrolling OR alt-screen arrow-key fallback
			return false;
		});

		// Send input to PTY
		term.onData((data: string) => {
			vscode.postMessage({
				type: "terminal-input",
				terminalId: id,
				data,
			});
		});

		// Handle bell
		let bellTimer: ReturnType<typeof setTimeout> | null = null;
		term.onBell(() => {
			if (runtimeConfig.bellStyle === "none") return;
			// Show bell indicator in terminal list
			// Active terminal: transient (animates in/out)
			// Inactive terminal: persistent (until focused)
			const isActive = id === activeTerminalId;
			terminalList.setBellIndicator(id, true, isActive);
			// For active terminal, auto-hide after animation completes
			// Clear any existing timer so rapid bells reset the fade delay
			if (bellTimer) clearTimeout(bellTimer);
			if (isActive) {
				bellTimer = setTimeout(() => {
					bellTimer = null;
					terminalList.setBellIndicator(id, false);
				}, 1500); // Matches bell-transient animation duration
			}
			vscode.postMessage({ type: "terminal-bell", terminalId: id });
		});

		// Resize handling - when container resizes, fit all visible terminals in group
		let resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
		const resizeObserver = new ResizeObserver(() => {
			if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
			resizeDebounceTimer = setTimeout(() => {
				resizeDebounceTimer = null;
				// Only handle resize if this terminal is visible (active or in active group)
				if (activeTerminalId) {
					const visibleIds = getVisibleTerminalIds(activeTerminalId);
					if (visibleIds.includes(id)) {
						fitVisibleTerminals(visibleIds);
					}
				}
			}, 150);
		});
		resizeObserver.observe(container);

		// Bracketed paste mode: Handle paste events for this terminal
		// VS Code webviews may intercept paste events. We need to ensure paste
		// events are properly wrapped with bracketed paste sequences when mode 2004
		// is enabled by the shell.
		container.addEventListener("paste", (e: ClipboardEvent) => {
			const text = e.clipboardData?.getData("text/plain");
			if (!text) return;

			e.preventDefault();
			e.stopPropagation();

			// Use the terminal's paste() method which handles bracketed paste mode
			if (typeof (term as any).paste === "function") {
				(term as any).paste(text);
			} else {
				// Fallback: check hasBracketedPaste and wrap manually
				const hasBracketedPaste = (term as any).hasBracketedPaste?.() ?? false;
				if (hasBracketedPaste) {
					vscode.postMessage({
						type: "terminal-input",
						terminalId: id,
						data: `\x1b[200~${text}\x1b[201~`,
					});
				} else {
					vscode.postMessage({
						type: "terminal-input",
						terminalId: id,
						data: text,
					});
				}
			}
		});

		// Drag-and-drop
		container.addEventListener("dragover", (e) => {
			e.preventDefault();
			container.classList.add("drag-over");
		});
		container.addEventListener("dragleave", (e) => {
			e.preventDefault();
			container.classList.remove("drag-over");
		});
		container.addEventListener("drop", (e) => {
			e.preventDefault();
			container.classList.remove("drag-over");
			if (!e.dataTransfer) return;

			// Extract paths from both Finder drops and VS Code Explorer drops (Shift+drag)
			const rawPaths = extractPathsFromDataTransfer(e.dataTransfer);
			if (rawPaths.length > 0) {
				const quotedPaths = rawPaths.map((p) => quoteShellPath(p, IS_WINDOWS));
				vscode.postMessage({
					type: "terminal-input",
					terminalId: id,
					data: quotedPaths.join(" "),
				});
				// Focus terminal after drop
				term.focus?.();
				terminalList.setFocused(id);
			}
		});

		// Click handler to focus terminal when clicking in its pane
		container.addEventListener("mousedown", () => {
			// Focus this terminal and update list
			term.focus?.();
			terminalList.setFocused(id);
		});

		// Create search controller for this terminal
		const searchController = createSearchController(term);

		const panelTerminal: PanelTerminal = {
			id,
			title,
			term,
			fitAddon,
			container: wrapper,
			searchController,
			themeObserver,
			resizeObserver,
		};
		terminals.set(id, panelTerminal);

		return panelTerminal;
	}

	/** Get the group ID for a terminal, if it's in a group */
	function getTerminalGroupId(terminalId: TerminalId): string | undefined {
		for (const [groupId, group] of groups) {
			if (group.terminals.includes(terminalId)) {
				return groupId;
			}
		}
		return undefined;
	}

	/** Get all terminal IDs that should be visible when a terminal is selected */
	function getVisibleTerminalIds(selectedId: TerminalId): TerminalId[] {
		const groupId = getTerminalGroupId(selectedId);
		if (groupId) {
			const group = groups.get(groupId);
			return group ? [...group.terminals] : [selectedId];
		}
		return [selectedId];
	}

	/** Fit all visible terminals and send resize messages */
	function fitVisibleTerminals(visibleIds: TerminalId[]): void {
		const numPanes = visibleIds.length;
		if (numPanes === 0) return;

		// Calculate pane width (equal distribution)
		const containerWidth = terminalsContainer.clientWidth;
		const dividerWidth = 1; // 1px border between panes
		const paneWidth =
			(containerWidth - (numPanes - 1) * dividerWidth) / numPanes;

		for (let i = 0; i < visibleIds.length; i++) {
			const id = visibleIds[i];
			const terminal = terminals.get(id);
			if (!terminal) continue;

			const wrapper = terminal.container;

			// Position pane for split layout
			if (numPanes > 1) {
				wrapper.classList.add("split-pane");
				wrapper.style.left = `${i * (paneWidth + dividerWidth)}px`;
				wrapper.style.width = `${paneWidth}px`;
			} else {
				wrapper.classList.remove("split-pane");
				wrapper.style.left = "";
				wrapper.style.width = "";
			}

			// Fit terminal and send resize
			try {
				// biome-ignore lint/suspicious/noFocusedTests: This is xterm FitAddon.fit(), not a test
				(terminal.fitAddon as unknown as { fit: () => void }).fit();
				const term = terminal.term as unknown as {
					cols: number;
					rows: number;
				};
				vscode.postMessage({
					type: "terminal-resize",
					terminalId: id,
					cols: term.cols,
					rows: term.rows,
				});
			} catch (err) {
				console.warn("[bootty] Fit error:", err);
			}
		}
	}

	// Activate a terminal (show it and its group members side-by-side)
	function activateTerminal(id: TerminalId): void {
		const terminal = terminals.get(id);
		if (!terminal) return;

		activeTerminalId = id;

		// Sync terminal list state (for external activations like keyboard nav, initial load)
		terminalList.setActive(id);

		// Get all terminals that should be visible (entire group or just this terminal)
		const visibleIds = getVisibleTerminalIds(id);

		// Update terminal visibility - show all in group, hide others
		for (const [tid, t] of terminals) {
			const isVisible = visibleIds.includes(tid);
			t.container.classList.toggle("active", isVisible);
			if (!isVisible) {
				t.container.classList.remove("split-pane");
			}
			const termInstance = t.term as {
				pauseRendering?: () => void;
				resumeRendering?: () => void;
			};
			if (isVisible && !document.hidden) {
				termInstance.resumeRendering?.();
			} else {
				termInstance.pauseRendering?.();
			}
		}

		// Fit visible terminals and send resize messages
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				fitVisibleTerminals(visibleIds);

				// Focus the activated terminal
				const term = terminal.term as unknown as {
					cols: number;
					rows: number;
					focus?: () => void;
				};
				term.focus?.();
				terminalList.setFocused(id);

				// Notify extension of activation (use the clicked terminal)
				vscode.postMessage({
					type: "tab-activated",
					terminalId: id,
					cols: term.cols,
					rows: term.rows,
				} satisfies PanelWebviewMessage);
			});
		});

		saveState();
	}

	// Remove a terminal
	function removeTerminal(id: TerminalId): void {
		const terminal = terminals.get(id);
		if (!terminal) return;

		ptyWorker.postMessage({ type: "reset", terminalId: id });

		// Dispose terminal instance to stop render loop and release resources
		const termInstance = terminal.term as { dispose?: () => void };
		termInstance.dispose?.();

		// Clean up observers
		terminal.themeObserver.disconnect();
		terminal.resizeObserver.disconnect();

		// Clean up search controller
		terminal.searchController.destroy();

		// Remove DOM elements
		terminal.container.remove();

		scrollDisposables.get(id)?.dispose?.();
		scrollDisposables.delete(id);
		scrollOffsets.delete(id);
		terminals.delete(id);
		ptyQueueState.delete(id);
		scrollRafState.delete(id);

		// Activate another terminal if this was active
		if (activeTerminalId === id) {
			const remaining = Array.from(terminals.keys());
			if (remaining.length > 0) {
				activateTerminal(remaining[remaining.length - 1]);
			} else {
				activeTerminalId = null;
			}
		}

		saveState();
	}

	// Rename a terminal
	function renameTerminal(id: TerminalId, title: string): void {
		const terminal = terminals.get(id);
		if (!terminal) return;

		terminal.title = title;
		saveState();
	}

	// Save webview state
	function saveState(): void {
		const tabs: WebviewState["tabs"] = [];
		const currentCwd: Record<TerminalId, string> = {};

		for (const [id, t] of terminals) {
			tabs.push({
				id,
				title: t.title,
				active: id === activeTerminalId,
			});
			if (t.currentCwd) {
				currentCwd[id] = t.currentCwd;
			}
		}

		vscode.setState({ tabs, currentCwd } as WebviewState);
	}

	// Clear focus indicator when webview loses focus (VS Code focus change)
	window.addEventListener("blur", () => {
		terminalList.setFocused(null);
	});

	// Pause rendering when the webview is hidden; resume visible terminals when shown.
	document.addEventListener("visibilitychange", () => {
		const visibleIds = activeTerminalId
			? getVisibleTerminalIds(activeTerminalId)
			: [];
		for (const [tid, t] of terminals) {
			const isVisible = visibleIds.includes(tid);
			const termInstance = t.term as {
				pauseRendering?: () => void;
				resumeRendering?: () => void;
			};
			if (document.hidden || !isVisible) {
				termInstance.pauseRendering?.();
			} else {
				termInstance.resumeRendering?.();
			}
		}
	});

	// Handle messages from extension
	window.addEventListener("message", (e) => {
		const msg = e.data as PanelExtensionMessage;

		switch (msg.type) {
			case "add-tab": {
				const terminal = createTerminal(msg.terminalId, msg.title);
				// Add to terminal list UI
				const listItem: TerminalListItem = {
					id: msg.terminalId,
					title: msg.title,
					icon: msg.icon,
					color: msg.color,
					groupId: msg.groupId,
				};
				terminalList.addTerminal(listItem, msg.insertAfter);
				if (msg.makeActive) {
					activateTerminal(msg.terminalId);
					terminalList.setSelected(msg.terminalId);
				} else {
					// Pause rendering for hidden terminals to avoid extra rAF loops
					const termInstance = terminal.term as {
						pauseRendering?: () => void;
					};
					termInstance.pauseRendering?.();
				}
				// Send terminal-ready and renderer-status
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						try {
							// biome-ignore lint/suspicious/noFocusedTests: This is xterm FitAddon.fit(), not a test
							(terminal.fitAddon as unknown as { fit: () => void }).fit();
							const term = terminal.term as unknown as {
								cols: number;
								rows: number;
							};
							vscode.postMessage({
								type: "terminal-ready",
								terminalId: msg.terminalId,
								cols: term.cols,
								rows: term.rows,
							});
							// Report renderer status
							const info = rendererInfo.get(msg.terminalId);
							if (info) {
								vscode.postMessage({
									type: "renderer-status",
									terminalId: msg.terminalId,
									renderer: info.type,
									status: info.status,
									fallback: info.fallback,
									reason: info.reason,
								});
							}
						} catch (err) {
							console.warn("[bootty] Fit error:", err);
						}
					});
				});
				break;
			}

			case "remove-tab":
				removeTerminal(msg.terminalId);
				terminalList.removeTerminal(msg.terminalId);
				break;

			case "rename-tab":
				renameTerminal(msg.terminalId, msg.title);
				terminalList.renameTerminal(msg.terminalId, msg.title);
				break;

			case "activate-tab":
				activateTerminal(msg.terminalId);
				terminalList.setSelected(msg.terminalId);
				break;

			case "focus-terminal": {
				if (activeTerminalId) {
					const terminal = terminals.get(activeTerminalId);
					if (terminal) {
						const term = terminal.term as unknown as { focus?: () => void };
						term.focus?.();
						terminalList.setFocused(activeTerminalId);
					}
				}
				break;
			}

			case "hydrate-state":
				// Restore list width from extension state
				terminalList.setWidth(msg.listWidth);
				break;

			case "group-created":
				groups.set(msg.group.id, msg.group);
				terminalList.updateGroup(msg.group);
				// Re-layout panes if active terminal is in this group
				if (activeTerminalId) {
					const activeGroup = getTerminalGroupId(activeTerminalId);
					if (activeGroup === msg.group.id) {
						activateTerminal(activeTerminalId);
					}
				}
				break;

			case "group-destroyed": {
				// Check if active terminal was in this group BEFORE deleting
				const destroyedGroup = groups.get(msg.groupId);
				const wasInDestroyedGroup =
					activeTerminalId &&
					destroyedGroup?.terminals.includes(activeTerminalId);

				groups.delete(msg.groupId);
				terminalList.removeGroup(msg.groupId);

				// Re-layout panes if active terminal was in destroyed group (now standalone)
				if (wasInDestroyedGroup && activeTerminalId) {
					activateTerminal(activeTerminalId);
				}
				break;
			}

			case "split-terminal":
				// Update group membership for split terminal
				terminalList.setTerminalGroup(msg.terminalId, msg.groupId);
				// Re-run layout if active terminal is in this group
				if (activeTerminalId) {
					const activeGroup = getTerminalGroupId(activeTerminalId);
					if (activeGroup === msg.groupId) {
						activateTerminal(activeTerminalId);
					}
				}
				break;

			case "unsplit-terminal":
				// Terminal is now standalone
				terminalList.setTerminalGroup(msg.terminalId, undefined);
				// Re-run layout if this terminal was active or in active group
				if (activeTerminalId === msg.terminalId) {
					activateTerminal(msg.terminalId);
				} else if (activeTerminalId) {
					// Remaining group members might need re-layout
					activateTerminal(activeTerminalId);
				}
				break;

			case "join-terminal":
				// Terminal joined a group
				terminalList.setTerminalGroup(msg.terminalId, msg.groupId);
				// Re-run layout if active terminal is in the target group
				if (activeTerminalId) {
					const activeGroup = getTerminalGroupId(activeTerminalId);
					if (activeGroup === msg.groupId) {
						activateTerminal(activeTerminalId);
					}
				}
				break;

			case "update-terminal-color":
				terminalList.setTerminalColor(msg.terminalId, msg.color);
				break;

			case "update-terminal-icon":
				terminalList.setTerminalIcon(msg.terminalId, msg.icon);
				break;

			case "reorder-terminals":
				terminalList.reorderItems(msg.terminalIds);
				break;

			case "show-search": {
				if (activeTerminalId) {
					const terminal = terminals.get(activeTerminalId);
					terminal?.searchController.show();
				}
				break;
			}

			case "pty-data": {
				const terminal = terminals.get(msg.terminalId);
				if (terminal) {
					if (msg.data.byteLength > 0) {
						const state = getPtyQueueState(msg.terminalId);
						state.mergeChunks.push(msg.data);
						state.mergeBytes += msg.data.byteLength;
						if (!state.mergeScheduled) {
							const terminalId = msg.terminalId;
							state.mergeScheduled = true;
							queueMicrotask(() => flushMergedPtyData(terminalId));
						}
					}
				}
				break;
			}

			case "pty-exit": {
				const terminal = terminals.get(msg.terminalId);
				if (terminal) {
					ptyWorker.postMessage({
						type: "reset",
						terminalId: msg.terminalId,
					});
					const state = getPtyQueueState(msg.terminalId);
					state.bytes = 0;
					state.segments = 0;
					state.pendingChunks.length = 0;
					state.pendingBytes = 0;
					state.pendingSegments = 0;
					state.mergeChunks.length = 0;
					state.mergeBytes = 0;
					state.mergeScheduled = false;
					state.drainInFlight = false;
					state.drainQueued = false;
					const term = terminal.term as unknown as {
						write: (data: string | Uint8Array) => void;
						getViewportY?: () => number;
						getScrollbackLength?: () => number;
						scrollToLine?: (line: number) => void;
					};
					const hasScrollListener = scrollDisposables.has(msg.terminalId);
					const scrollOffset = hasScrollListener
						? (scrollOffsets.get(msg.terminalId) ?? 0)
						: (term.getViewportY?.() ?? 0);
					const scrollbackBefore = term.getScrollbackLength?.() ?? 0;
					term.write(
						`\r\n\x1b[90m[Process exited with code ${msg.exitCode}]\x1b[0m\r\n`,
					);
					if (scrollOffset > 0 && term.scrollToLine) {
						const scrollbackAfter = term.getScrollbackLength?.() ?? 0;
						const delta = scrollbackAfter - scrollbackBefore;
						term.scrollToLine(scrollOffset + delta);
					}
				}
				break;
			}

			case "resize": {
				const terminal = terminals.get(msg.terminalId);
				if (terminal) {
					(
						terminal.term as unknown as {
							resize: (cols: number, rows: number) => void;
						}
					).resize(msg.cols, msg.rows);
				}
				break;
			}

			case "update-settings": {
				const terminal = terminals.get(msg.terminalId);
				if (terminal) {
					const term = terminal.term as unknown as {
						options: { fontFamily?: string; fontSize?: number };
						cols: number;
						rows: number;
					};
					if (msg.settings.fontFamily !== undefined) {
						term.options.fontFamily = msg.settings.fontFamily;
					}
					if (msg.settings.fontSize !== undefined) {
						term.options.fontSize = msg.settings.fontSize;
					}
					// biome-ignore lint/suspicious/noFocusedTests: This is xterm FitAddon.fit(), not a test
					(terminal.fitAddon as unknown as { fit: () => void }).fit();
					vscode.postMessage({
						type: "terminal-resize",
						terminalId: msg.terminalId,
						cols: term.cols,
						rows: term.rows,
					});
				}
				break;
			}

			case "update-theme": {
				const terminal = terminals.get(msg.terminalId);
				if (terminal) {
					const baseTheme = getVSCodeThemeColors();
					const mergedTheme: TerminalTheme = { ...baseTheme };
					for (const [key, value] of Object.entries(msg.theme)) {
						if (value !== undefined) {
							(mergedTheme as Record<string, string | undefined>)[key] = value;
						}
					}
					(
						terminal.term as unknown as {
							options: { theme: TerminalTheme };
						}
					).options.theme = mergedTheme;
				}
				break;
			}

			case "update-cwd": {
				const terminal = terminals.get(msg.terminalId);
				if (terminal) {
					terminal.currentCwd = msg.cwd;
				}
				break;
			}

			case "batch-file-exists-result": {
				// Resolve batch file existence checks for the specific batch
				const batch = pendingBatches.get(msg.batchId);
				if (batch) {
					pendingBatches.delete(msg.batchId);
					for (const result of msg.results) {
						const callbacks = batch.get(result.path);
						if (callbacks) {
							fileCache.set(result.path, result.exists);
							for (const cb of callbacks) {
								cb(result.exists);
							}
						}
					}
				}
				break;
			}

			case "update-config": {
				runtimeConfig = msg.config;
				adaptiveMaxLinesByTerminal.clear();
				for (const state of ptyQueueState.values()) {
					state.adaptiveLatch = false;
				}
				runtimeConfigUpdated = true;
				// Enable/disable debug logging dynamically
				// Note: localStorage is also set for persistence across reloads
				if (msg.config.debugLog) {
					localStorage.setItem("debug", msg.config.debugLog);
					debug.enable(msg.config.debugLog);
				} else {
					localStorage.removeItem("debug");
					debug.disable();
				}
				if (msg.token) {
					vscode.postMessage({ type: "config-applied", token: msg.token });
				}
				break;
			}
			case "bench-drain-request":
				scheduleBenchDrain(msg.terminalId, msg.token);
				break;
			case "bench-direct-write":
				startDirectWrite(
					msg.terminalId,
					msg.payload,
					msg.repeat,
					msg.finalPayload,
					msg.writesPerFrame ?? 0,
					msg.token,
				);
				break;

			case "profile-start":
				profileCollector.start(msg.sessionId);
				profileCollector.recordEvent("bootty:webview:runtime-config", {
					bellStyle: runtimeConfig.bellStyle,
					renderer: runtimeConfig.renderer,
					ptyMaxLinesPerFrame: runtimeConfig.ptyMaxLinesPerFrame,
					ptyMaxFrameMs: runtimeConfig.ptyMaxFrameMs,
					ptyMaxBytesPerFrame: runtimeConfig.ptyMaxBytesPerFrame,
					ptyAdaptiveDrain: runtimeConfig.ptyAdaptiveDrain,
					ptyAdaptiveFrameMs: runtimeConfig.ptyAdaptiveFrameMs,
					ptyAdaptiveQueueThreshold: runtimeConfig.ptyAdaptiveQueueThreshold,
					ptyAdaptiveMaxLinesPerFrame:
						runtimeConfig.ptyAdaptiveMaxLinesPerFrame,
					ptyAdaptiveMaxLinesPerFrameWebgl:
						runtimeConfig.ptyAdaptiveMaxLinesPerFrameWebgl,
					ptyAdaptiveAutoTune: runtimeConfig.ptyAdaptiveAutoTune,
					ptyAdaptiveMinBytesPerFrame:
						runtimeConfig.ptyAdaptiveMinBytesPerFrame,
					ptyAdaptiveQueueBytesThreshold:
						runtimeConfig.ptyAdaptiveQueueBytesThreshold,
					ptyAdaptiveQueueHysteresisRatio:
						runtimeConfig.ptyAdaptiveQueueHysteresisRatio,
					configUpdated: runtimeConfigUpdated,
				});
				for (const [terminalId, info] of rendererInfo.entries()) {
					profileCollector.recordEvent(
						"bootty:renderer-info",
						{
							renderer: info.type,
							mode: runtimeConfig.renderer,
							fallback: info.fallback,
							reason: info.reason ?? null,
						},
						{ terminalId },
					);
				}
				break;
			case "profile-stop":
				profileCollector.stop(msg.sessionId);
				break;
		}
	});

	// ==========================================================================
	// Keyboard shortcut interception
	// ==========================================================================
	// Some keybindings defined in package.json need to be intercepted here
	// because the terminal captures keyboard events. Keep these in sync:
	//
	// | package.json keybinding | webview interception |
	// |-------------------------|----------------------|
	// | ctrl+` (togglePanel)    | YES - intercept here |
	// | ctrl+shift+` (newTerm)  | NO - doesn't conflict|
	// | cmd+shift+[ (prevTab)   | NO - VS Code handles |
	// | cmd+shift+] (nextTab)   | NO - VS Code handles |
	// | cmd+\ (splitTerminal)   | YES - intercept here |
	// ==========================================================================
	document.addEventListener(
		"keydown",
		(e: KeyboardEvent) => {
			// Ctrl+` (or Cmd+` on Mac) - toggle panel
			if (e.key === "`" && e.ctrlKey && !e.shiftKey && !e.altKey) {
				e.preventDefault();
				e.stopPropagation();
				vscode.postMessage({
					type: "toggle-panel-requested",
				} satisfies PanelWebviewMessage);
				return;
			}

			// Cmd+\ (Mac) or Ctrl+\ (Windows/Linux) - split terminal
			if (
				e.key === "\\" &&
				(e.metaKey || e.ctrlKey) &&
				!e.shiftKey &&
				!e.altKey
			) {
				e.preventDefault();
				e.stopPropagation();
				if (activeTerminalId) {
					vscode.postMessage({
						type: "split-requested",
						terminalId: activeTerminalId,
					} satisfies PanelWebviewMessage);
				}
				return;
			}
		},
		true,
	); // Use capture phase to intercept before terminal

	// Send panel-ready to extension
	vscode.postMessage({ type: "panel-ready" } satisfies PanelWebviewMessage);

	// Restore tabs from saved state if available
	if (savedState?.tabs && savedState.tabs.length > 0) {
		// The extension will recreate terminals via add-tab messages
		// State restoration is handled by panel-view-provider
	}

	// Periodic state save
	setInterval(saveState, 30000);
};

boottyPanelInit().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	const stack = error instanceof Error ? error.stack : undefined;
	console.error("BooTTY panel webview init error", error);
	vscode.postMessage({
		type: "webview-error",
		scope: "panel",
		message,
		stack,
	});
});
