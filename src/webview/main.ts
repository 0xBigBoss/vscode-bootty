// Type-only imports (stripped at build time)

import debug from "debug";

// Enable debug logging early from localStorage (before any debug() calls)
// This ensures WebGLRenderer constructor/attach logs are captured
const storedDebug = localStorage.getItem("debug");
if (storedDebug) {
	debug.enable(storedDebug);
}

// Import WebGL renderer (bundled by esbuild)
import { WebGLRenderer } from "@0xbigboss/libghostty-webgl";

// Import extracted utilities for testability (bundled by esbuild)
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
	isSearchShortcut,
} from "../keybinding-utils";
import type {
	ExtensionMessage,
	RendererMode,
	RendererStatus,
	RendererType,
	RuntimeConfig,
	TerminalTheme,
	TestSampleCell,
	TestSampleTrailingCellsResult,
} from "../types/messages";
import type { TerminalId } from "../types/terminal";
// Import modular components
import {
	createFileLinkProvider,
	FILE_PATH_PATTERN_SINGLE,
} from "./file-link-provider";
import { createProfileCollector } from "./profile-collector";
import type { RendererResult } from "./renderer-utils";
import { createRenderer } from "./renderer-utils";
import { createSearchController } from "./search-controller";
import { createThemeObserver, getVSCodeThemeColors } from "./theme-utils";

const logPty = debug("bootty:webview:pty");
const logInput = debug("bootty:webview:input");

const utf8Decoder = new TextDecoder("utf-8");
function previewBytes(bytes: Uint8Array, limit = 256): string {
	if (bytes.length <= limit) {
		const text = utf8Decoder.decode(bytes);
		const hex = Array.from(bytes)
			.map((b) => b.toString(16).padStart(2, "0"))
			.join(" ");
		return `len=${bytes.length} text=${JSON.stringify(text)} hex=${hex}`;
	}
	const head = bytes.subarray(0, limit);
	const tail = bytes.subarray(bytes.length - limit);
	const headText = utf8Decoder.decode(head);
	const tailText = utf8Decoder.decode(tail);
	const headHex = Array.from(head)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join(" ");
	const tailHex = Array.from(tail)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join(" ");
	return `len=${bytes.length} head=${JSON.stringify(headText)} headHex=${headHex} tail=${JSON.stringify(tailText)} tailHex=${tailHex}`;
}

function computeCellHasInk(data: Uint8ClampedArray): boolean {
	const buckets = new Map<
		number,
		{ count: number; r: number; g: number; b: number }
	>();
	let maxKey = 0;
	let maxCount = 0;
	for (let i = 0; i < data.length; i += 4) {
		const a = data[i + 3];
		if (a < 16) continue;
		const r = data[i];
		const g = data[i + 1];
		const b = data[i + 2];
		const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
		const entry = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
		entry.count += 1;
		entry.r += r;
		entry.g += g;
		entry.b += b;
		buckets.set(key, entry);
		if (entry.count > maxCount) {
			maxCount = entry.count;
			maxKey = key;
		}
	}
	if (maxCount === 0) return false;
	const bgEntry = buckets.get(maxKey);
	if (!bgEntry) return false;
	const bgR = bgEntry.r / bgEntry.count;
	const bgG = bgEntry.g / bgEntry.count;
	const bgB = bgEntry.b / bgEntry.count;
	const threshold = 40;
	for (let i = 0; i < data.length; i += 4) {
		const a = data[i + 3];
		if (a < 16) continue;
		const r = data[i];
		const g = data[i + 1];
		const b = data[i + 2];
		const diff = Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB);
		if (diff > threshold) {
			return true;
		}
	}
	return false;
}

function sampleTrailingCells(
	term: unknown,
	count: number,
): TestSampleTrailingCellsResult {
	const termApi = term as {
		cols: number;
		rows: number;
		renderer?: {
			getCanvas: () => HTMLCanvasElement;
			getMetrics: () => { width: number; height: number };
		};
		wasmTerm?: {
			getCursor: () => { x: number; y: number };
			getLine: (row: number) => Array<{ codepoint: number }> | null;
		};
	};
	const renderer = termApi.renderer;
	if (!renderer) {
		return { cursorX: 0, cursorY: 0, cells: [], error: "renderer-unavailable" };
	}
	const canvas = renderer.getCanvas();
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) {
		return {
			cursorX: 0,
			cursorY: 0,
			cells: [],
			error: "canvas-2d-unavailable",
		};
	}
	const wasm = termApi.wasmTerm;
	if (!wasm) {
		return { cursorX: 0, cursorY: 0, cells: [], error: "wasm-unavailable" };
	}
	const cursor = wasm.getCursor();
	const row = cursor.y;
	const cols = Math.max(0, termApi.cols);
	const metrics = renderer.getMetrics();
	if (!cols || !metrics.width || !metrics.height) {
		return {
			cursorX: cursor.x,
			cursorY: cursor.y,
			cells: [],
			error: "metrics-unavailable",
		};
	}
	const dpr = canvas.width / (cols * metrics.width);
	const startCol = Math.max(0, cursor.x - count);
	const endCol = Math.max(startCol, cursor.x);
	const line = wasm.getLine(row) ?? [];
	const cells: TestSampleCell[] = [];
	for (let col = startCol; col < endCol; col += 1) {
		const cell = line[col];
		const codepoint = cell?.codepoint ?? 0;
		const char = codepoint ? String.fromCodePoint(codepoint) : "";
		const cellX = Math.floor(col * metrics.width * dpr);
		const cellY = Math.floor(row * metrics.height * dpr);
		const cellW = Math.max(1, Math.floor(metrics.width * dpr));
		const cellH = Math.max(1, Math.floor(metrics.height * dpr));
		const image = ctx.getImageData(cellX, cellY, cellW, cellH);
		const hasInk = computeCellHasInk(image.data);
		cells.push({ col, codepoint, char, hasInk });
	}
	return { cursorX: cursor.x, cursorY: cursor.y, cells };
}

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
	currentCwd?: string;
	// Scrollback content as lines of text (extracted from buffer on state save)
	scrollbackContent?: string[];
}

// Wrap in async IIFE for top-level await (IIFE build target)
const boottyInit = async (): Promise<void> => {
	// Read injected config from body data attributes
	const TERMINAL_ID = document.body.dataset.terminalId as TerminalId;
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
		source: "editor",
		terminalId: TERMINAL_ID,
		postMessage: (message) => vscode.postMessage(message),
	});

	// Track current renderer info for status reporting
	let currentRendererType: RendererType = "canvas";
	let currentRendererStatus: RendererStatus = "active";
	let rendererFallback = false;
	let rendererReason: string | undefined;

	// Restore persisted state (survives tab switches due to retainContextWhenHidden,
	// and partial state survives window moves via VS Code's webview state API)
	const savedState = vscode.getState() as WebviewState | undefined;

	// State for file path detection
	let currentCwd: string | undefined = savedState?.currentCwd;

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
	const BATCH_DEBOUNCE_MS = 50; // Wait 50ms to collect paths before sending batch

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
		ptyFlushFastPathBytes: 0,
		ptyFlushFastPathSegments: 0,
	};
	let runtimeConfigUpdated = false;
	let adaptiveMaxLines: number | null = null;
	let adaptiveLatchActive = false;

	// File existence cache with TTL (uses extracted utility for testability)
	const fileCache = createFileCache(5000, 100); // 5s TTL, max 100 entries

	// Platform detection (cached at startup)
	const IS_MAC = isMacPlatform(navigator);
	const IS_WINDOWS = isWindowsPlatform(navigator);

	// Initialize ghostty-web wasm (matching probe pattern)
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const GhosttyModule =
		(window as any).GhosttyWeb || (window as any).ghosttyWeb;

	// Guard for missing global (script load failure)
	if (!GhosttyModule) {
		throw new Error(
			"ghostty-web failed to load: GhosttyWeb global not found. Check script loading and CSP.",
		);
	}

	// Prefer Ghostty.load(wasmUrl) if available, fallback to init()
	const Ghostty = GhosttyModule.Ghostty || GhosttyModule.default?.Ghostty;
	let ghosttyInstance: unknown = null;

	if (Ghostty && typeof Ghostty.load === "function") {
		ghosttyInstance = await Ghostty.load(WASM_URL);
	} else if (GhosttyModule.init && typeof GhosttyModule.init === "function") {
		await GhosttyModule.init();
	} else if (GhosttyModule.default?.init) {
		await GhosttyModule.default.init();
	}

	// Create terminal
	const Terminal = GhosttyModule.Terminal || GhosttyModule.default?.Terminal;
	if (!Terminal) {
		throw new Error("ghostty-web Terminal not found");
	}

	// Flush batch of file existence checks to extension
	function flushBatchFileChecks(): void {
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
			terminalId: TERMINAL_ID,
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
	function checkFileExists(path: string): Promise<boolean> {
		// Check cache first (uses extracted utility)
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
				flushBatchFileChecks();
			}, BATCH_DEBOUNCE_MS);
		});
	}

	// Resolve path relative to CWD (uses extracted utility)
	function resolvePath(path: string): string {
		return resolvePathUtil(path, currentCwd);
	}

	// Handle file link click
	function handleFileLinkClick(
		path: string,
		line?: number,
		column?: number,
	): void {
		const absolutePath = resolvePath(path);
		vscode.postMessage({
			type: "open-file",
			terminalId: TERMINAL_ID,
			path: absolutePath,
			line,
			column,
		});
	}

	async function findFileLinksForText(
		text: string,
		limit: number | undefined,
	): Promise<number> {
		const buffer = (term as unknown as { buffer?: any }).buffer;
		if (!buffer?.active) {
			return 0;
		}
		const length = buffer.active.length ?? 0;
		const maxLines =
			typeof limit === "number" && Number.isFinite(limit)
				? Math.max(1, Math.floor(limit))
				: length;
		const start = Math.max(0, length - maxLines);
		let matches = 0;
		for (let y = start; y < length; y += 1) {
			const line = buffer.active.getLine(y);
			if (!line) continue;
			const lineText = line.translateToString(true);
			if (!lineText.includes(text)) continue;
			const links = await new Promise<unknown[]>((resolve) => {
				filePathLinkProvider.provideLinks(y, (value) =>
					resolve(value ? (value as unknown[]) : []),
				);
			});
			matches += links.length;
		}
		return matches;
	}

	// Create renderer based on mode
	let rendererResult: RendererResult;
	try {
		rendererResult = createRenderer(
			RENDERER_MODE,
			() =>
				new WebGLRenderer({
					onContextLoss: () => {
						// WebGL context lost after repeated failures - renderer is degraded
						// Note: The terminal still uses the WebGL renderer (no runtime swap),
						// but it's no longer rendering. Report accurate status.
						console.warn("[bootty] WebGL context lost - renderer degraded");
						currentRendererStatus = "degraded";
						rendererReason = "WebGL context lost after repeated failures";
						vscode.postMessage({
							type: "renderer-status",
							terminalId: TERMINAL_ID,
							renderer: currentRendererType, // Still "webgl" - no actual swap
							status: "degraded",
							fallback: rendererFallback,
							reason: "WebGL context lost after repeated failures",
						});
					},
				}),
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn("[bootty] WebGL renderer init failed:", message);
		rendererResult = {
			renderer: undefined,
			type: "canvas",
			fallback: true,
			reason: `WebGL renderer init failed: ${message}`,
		};
	}

	currentRendererType = rendererResult.type;
	rendererFallback = rendererResult.fallback;
	rendererReason = rendererResult.reason;
	profileCollector.recordEvent("bootty:renderer-info", {
		renderer: rendererResult.type,
		mode: RENDERER_MODE,
		fallback: rendererResult.fallback,
		reason: rendererResult.reason ?? null,
	});

	const termOptions: {
		cols: number;
		rows: number;
		scrollback?: number;
		ghostty?: unknown;
		macOptionIsMeta?: boolean;
		renderer?: unknown;
		onLinkClick?: (url: string, event: MouseEvent) => boolean;
	} = {
		cols: 80,
		rows: 24,
		scrollback: SCROLLBACK,
		// Enable Option key as Meta on Mac for word navigation (Option+Left/Right)
		macOptionIsMeta: IS_MAC,
		// Use custom renderer if available
		renderer: rendererResult.renderer,
		// Handle link clicks by posting message to extension (window.open doesn't work in webviews)
		onLinkClick: (url: string, event: MouseEvent) => {
			// Only open links when Ctrl/Cmd is held (standard terminal behavior)
			if (event.ctrlKey || event.metaKey) {
				// Check if this looks like a file path (uses pre-compiled pattern)
				const fileMatch = url.match(FILE_PATH_PATTERN_SINGLE);
				if (fileMatch) {
					const [, filePath, lineStr, colStr] = fileMatch;
					const line = lineStr ? parseInt(lineStr, 10) : undefined;
					const col = colStr ? parseInt(colStr, 10) : undefined;
					handleFileLinkClick(filePath, line, col);
					return true;
				}
				// Otherwise treat as URL
				vscode.postMessage({ type: "open-url", terminalId: TERMINAL_ID, url });
				return true; // Handled
			}
			return false; // Not handled
		},
	};
	if (ghosttyInstance) {
		termOptions.ghostty = ghosttyInstance;
	}
	const term = new Terminal(termOptions);

	// Get FitAddon from ghostty-web module
	const FitAddon = GhosttyModule.FitAddon || GhosttyModule.default?.FitAddon;
	if (!FitAddon) {
		throw new Error("ghostty-web FitAddon not found");
	}

	const fitAddon = new FitAddon();
	term.loadAddon(fitAddon);
	term.open(document.getElementById("terminal-container")!);
	const safeFit = (): boolean => {
		try {
			fitAddon.fit();
			return true;
		} catch (err) {
			console.warn("[bootty] Fit error:", err);
			return false;
		}
	};
	let hasScrollListener = false;
	const scrollDisposable = (
		term as {
			onScroll?: (listener: (offset: number) => void) => {
				dispose?: () => void;
			};
		}
	).onScroll?.((offset) => {
		currentScrollOffset = offset;
	});
	if (scrollDisposable) {
		hasScrollListener = true;
	}

	// Initial fit - use double-rAF to ensure layout is complete before measuring
	// VS Code webviews may not have final dimensions until after paint
	requestAnimationFrame(() => {
		requestAnimationFrame(() => {
			safeFit();
			// Backup fit after 100ms in case webview layout isn't fully settled
			setTimeout(() => safeFit(), 100);
		});
	});

	// Create and register file path link provider (uses extracted module)
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const filePathLinkProvider = createFileLinkProvider((term as any).buffer, {
		getCwd: () => currentCwd,
		checkFileExists,
		onFileClick: handleFileLinkClick,
	});

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	if (typeof (term as any).registerLinkProvider === "function") {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(term as any).registerLinkProvider(filePathLinkProvider);
	}

	// Apply initial theme from CSS variables (uses extracted module)
	term.options.theme = getVSCodeThemeColors();

	// Watch for theme changes (uses extracted module)
	createThemeObserver((theme) => {
		term.options.theme = theme;
	});

	// Create search controller (uses extracted module)
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const searchController = createSearchController(term as any);

	// Keybinding passthrough: let VS Code handle Cmd/Ctrl combos
	// Uses extracted utilities for testability
	term.attachCustomKeyEventHandler(
		(event: KeyboardEvent): boolean | undefined => {
			// Intercept Cmd+F / Ctrl+F for search (uses extracted utility)
			if (isSearchShortcut(event, IS_MAC)) {
				event.preventDefault();
				searchController.show();
				return true; // We handled it
			}

			// Intercept Cmd+Backspace for delete line (Mac only)
			if (isDeleteLineShortcut(event, IS_MAC)) {
				event.preventDefault();
				// Send Ctrl+U directly to PTY (bypasses term.input which needs wasUserInput:true)
				vscode.postMessage({
					type: "terminal-input",
					terminalId: TERMINAL_ID,
					data: "\x15",
				});
				return true;
			}
			// Intercept Cmd+Left for beginning of line (Mac only)
			if (isLineStartShortcut(event, IS_MAC)) {
				event.preventDefault();
				// Send Ctrl+A (beginning of line)
				vscode.postMessage({
					type: "terminal-input",
					terminalId: TERMINAL_ID,
					data: "\x01",
				});
				return true;
			}
			// Intercept Cmd+Right for end of line (Mac only)
			if (isLineEndShortcut(event, IS_MAC)) {
				event.preventDefault();
				// Send Ctrl+E (end of line)
				vscode.postMessage({
					type: "terminal-input",
					terminalId: TERMINAL_ID,
					data: "\x05",
				});
				return true;
			}
			// Intercept Cmd+K for clear screen (Mac only)
			if (isClearScreenShortcut(event, IS_MAC)) {
				event.preventDefault();
				// Send Ctrl+L (clear screen)
				vscode.postMessage({
					type: "terminal-input",
					terminalId: TERMINAL_ID,
					data: "\x0c",
				});
				return true;
			}

			// Delegate to extracted utility for consistent keybinding logic
			return getKeyHandlerResult(event, IS_MAC, term.hasSelection?.() ?? false);
		},
	);

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
					terminalId: TERMINAL_ID,
					data: `\x1b[<${button};${col};${row}M`,
				});
			}
			return true; // We handled it
		}

		// Let ghostty-web handle: normal screen scrolling OR alt-screen arrow-key fallback
		return false;
	});

	// Register message listener BEFORE posting terminal-ready
	// This ensures the ready-triggered flush doesn't arrive before handler exists
	// Scroll preservation state: coalesce multiple writes into single RAF
	let scrollRafPending = false;
	let scrollRafScrollOffset = 0;
	let scrollRafScrollbackBefore = 0;
	let currentScrollOffset = 0;
	let ptyQueueBytes = 0;
	let ptyQueueSegments = 0;
	let ptyFlushPending = false;
	let ptyDrainInFlight = false;
	let ptyDrainQueued = false;
	let ptyMergeScheduled = false;
	let suppressPtyDuringDirectWrite = false;
	const pendingPtyChunks: Uint8Array[] = [];
	let pendingPtyBytes = 0;
	let pendingPtySegments = 0;
	const pendingPtyMerge: Uint8Array[] = [];
	let pendingPtyMergeBytes = 0;
	let drainToken = 0;
	const pendingDrains = new Map<
		number,
		{
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
		if (msg.type !== "drain-result" || msg.terminalId !== TERMINAL_ID) {
			return;
		}
		const pending = pendingDrains.get(msg.token);
		pendingDrains.delete(msg.token);
		ptyDrainInFlight = false;

		if (pending) {
			ptyQueueBytes = msg.queueBytesAfter;
			ptyQueueSegments = msg.queueSegmentsAfter;
			if (profileCollector.isActive()) {
				profileCollector.recordEvent("bootty:webview:pty-drain", {
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
					autoTuneMaxLines: adaptiveMaxLines,
				});
			}
			if (
				pending.adaptiveApplied &&
				!pending.byteAdaptive &&
				runtimeConfig.ptyAdaptiveAutoTune &&
				pending.maxFrameMs > 0 &&
				(getAdaptiveMaxLinesBase() ?? 0) > 0
			) {
				const baseMaxLines = getAdaptiveMaxLinesBase();
				const hitMaxLines = msg.drainedLines >= pending.maxLines;
				const targetMs = pending.maxFrameMs;
				if (hitMaxLines && msg.durationMs < targetMs * 0.6) {
					adaptiveMaxLines = Math.min(
						baseMaxLines,
						Math.max(pending.maxLines + 1, Math.ceil(pending.maxLines * 1.5)),
					);
				} else if (msg.durationMs > targetMs * 1.1) {
					adaptiveMaxLines = Math.max(1, Math.floor(pending.maxLines * 0.7));
				} else if (adaptiveMaxLines === null) {
					adaptiveMaxLines = pending.maxLines;
				}
			}
		}

		const output = msg.output;
		if (output.byteLength > 0) {
			logPty(
				"drain-result drainedBytes=%d drainedLines=%d queueBytesBefore=%d queueBytesAfter=%d output=%s",
				msg.drainedBytes,
				msg.drainedLines,
				msg.queueBytesBefore,
				msg.queueBytesAfter,
				previewBytes(output),
			);
			const termApi = term as unknown as {
				getViewportY?: () => number;
				getScrollbackLength?: () => number;
				scrollToLine?: (line: number) => void;
			};
			const scrollOffset = hasScrollListener
				? currentScrollOffset
				: (termApi.getViewportY?.() ?? 0);
			if (!scrollRafPending && scrollOffset > 0) {
				scrollRafScrollOffset = scrollOffset;
				scrollRafScrollbackBefore = termApi.getScrollbackLength?.() ?? 0;
			}
			const writeStart = profileCollector.startSpan();
			logPty("pty-write %s", previewBytes(output));
			term.write(output);
			profileCollector.recordDuration("bootty:webview:pty-write", writeStart, {
				bytes: output.byteLength,
			});
			if (scrollOffset > 0 && termApi.scrollToLine && !scrollRafPending) {
				scrollRafPending = true;
				const scrollToLine = termApi.scrollToLine;
				requestAnimationFrame(() => {
					scrollRafPending = false;
					const scrollbackAfter = termApi.getScrollbackLength?.() ?? 0;
					const delta = scrollbackAfter - scrollRafScrollbackBefore;
					scrollToLine(scrollRafScrollOffset + delta);
				});
			}
		}

		if (pendingPtyChunks.length > 0) {
			for (const chunk of pendingPtyChunks) {
				ptyWorker.postMessage(
					{ type: "enqueue", terminalId: TERMINAL_ID, data: chunk },
					[chunk.buffer],
				);
			}
			ptyQueueBytes += pendingPtyBytes;
			ptyQueueSegments += pendingPtySegments;
			pendingPtyChunks.length = 0;
			pendingPtyBytes = 0;
			pendingPtySegments = 0;
		}

		if (ptyQueueBytes > 0) {
			schedulePtyFlush();
		} else if (ptyDrainQueued) {
			ptyDrainQueued = false;
			schedulePtyFlush();
		}
	});
	let directWriteState: {
		token: string;
		payload: string;
		payloadBytes: number;
		repeatRemaining: number;
		repeatTotal: number;
		finalPayload?: string;
		finalPayloadBytes: number;
		writesPerFrame: number;
		cancelled: boolean;
	} | null = null;

	function getAdaptiveMaxLinesBase(): number {
		if (currentRendererType === "webgl") {
			const webglAdaptive = runtimeConfig.ptyAdaptiveMaxLinesPerFrameWebgl ?? 0;
			if (webglAdaptive > 0) return webglAdaptive;
		}
		return runtimeConfig.ptyAdaptiveMaxLinesPerFrame ?? 0;
	}

	function resolvePtyMaxLines(
		adaptiveApplied: boolean,
		baseMaxLines: number,
	): number {
		if (adaptiveApplied) {
			if (runtimeConfig.ptyAdaptiveAutoTune && adaptiveMaxLines !== null) {
				return Math.max(1, adaptiveMaxLines);
			}
			if (baseMaxLines > 0) return baseMaxLines;
		}
		const configured = runtimeConfig.ptyMaxLinesPerFrame ?? 0;
		if (configured > 0) return configured;
		const rows = (term as { rows?: number }).rows ?? 0;
		return Math.max(1, rows - 1);
	}

	function resolvePtyMaxFrameMs(
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
			if (adaptiveLatchActive) {
				if (queueSegmentsBefore <= lower) {
					adaptiveLatchActive = false;
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
			adaptiveLatchActive = true;
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

	function flushMergedPtyData(): void {
		ptyMergeScheduled = false;
		if (pendingPtyMergeBytes === 0) {
			pendingPtyMerge.length = 0;
			return;
		}
		const merged = mergePtyChunks(pendingPtyMerge, pendingPtyMergeBytes);
		pendingPtyMerge.length = 0;
		pendingPtyMergeBytes = 0;
		if (ptyDrainInFlight) {
			pendingPtyChunks.push(merged);
			pendingPtyBytes += merged.byteLength;
			pendingPtySegments += 1;
		} else {
			ptyWorker.postMessage(
				{ type: "enqueue", terminalId: TERMINAL_ID, data: merged },
				[merged.buffer],
			);
			ptyQueueBytes += merged.byteLength;
			ptyQueueSegments += 1;
		}
		schedulePtyFlush();
	}

	function shouldUseFastPtyFlush(): boolean {
		const maxBytes = runtimeConfig.ptyFlushFastPathBytes ?? 0;
		const maxSegments = runtimeConfig.ptyFlushFastPathSegments ?? 0;
		if (maxBytes <= 0 && maxSegments <= 0) return false;
		const totalBytes = ptyQueueBytes + pendingPtyBytes + pendingPtyMergeBytes;
		const totalSegments =
			ptyQueueSegments + pendingPtySegments + pendingPtyMerge.length;
		const bytesOk = maxBytes <= 0 || totalBytes <= maxBytes;
		const segmentsOk = maxSegments <= 0 || totalSegments <= maxSegments;
		return bytesOk && segmentsOk;
	}

	function isPtyQueueIdle(): boolean {
		if (ptyMergeScheduled) return false;
		if (ptyFlushPending) return false;
		if (ptyDrainInFlight) return false;
		if (ptyQueueBytes > 0 || ptyQueueSegments > 0) return false;
		if (pendingPtyBytes > 0 || pendingPtySegments > 0) return false;
		if (pendingPtyMergeBytes > 0 || pendingPtyMerge.length > 0) return false;
		return true;
	}

	function waitForPtyIdle(onIdle: () => void): void {
		if (isPtyQueueIdle()) {
			onIdle();
			return;
		}
		requestAnimationFrame(() => waitForPtyIdle(onIdle));
	}

	function schedulePtyFlush(): void {
		if (ptyFlushPending) return;
		ptyFlushPending = true;
		const useFastPath = shouldUseFastPtyFlush();
		const runFlush = () => {
			ptyFlushPending = false;
			flushPtyQueue();
		};
		if (useFastPath) {
			queueMicrotask(runFlush);
		} else {
			requestAnimationFrame(runFlush);
		}
	}

	function scheduleBenchDrain(token: string): void {
		const check = () => {
			if (ptyQueueBytes === 0 && !ptyFlushPending && !ptyDrainInFlight) {
				requestAnimationFrame(() => {
					vscode.postMessage({
						type: "bench-drain-complete",
						terminalId: TERMINAL_ID,
						token,
					});
				});
				return;
			}
			requestAnimationFrame(check);
		};
		requestAnimationFrame(check);
	}

	function startDirectWrite(
		payload: string,
		repeat: number,
		finalPayload: string | undefined,
		writesPerFrame: number,
		token: string,
	): void {
		const existing = directWriteState;
		if (existing) {
			existing.cancelled = true;
		}
		directWriteState = {
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
		profileCollector.recordEvent("bootty:webview:bench-direct-write", {
			payloadBytes: payload.length,
			repeat,
			finalPayloadBytes: finalPayload?.length ?? 0,
			writesPerFrame: directWriteState.writesPerFrame,
		});
		requestAnimationFrame(runDirectWrite);
	}

	function runDirectWrite(): void {
		if (!directWriteState || directWriteState.cancelled) return;
		const state = directWriteState;
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
			requestAnimationFrame(runDirectWrite);
			return;
		}
		directWriteState = null;
		profileCollector.recordEvent("bootty:webview:bench-direct-write-complete", {
			totalWrites: state.repeatTotal + (state.finalPayloadBytes > 0 ? 1 : 0),
			totalBytes:
				state.repeatTotal * state.payloadBytes + state.finalPayloadBytes,
		});
		requestAnimationFrame(() => {
			vscode.postMessage({
				type: "bench-direct-write-complete",
				terminalId: TERMINAL_ID,
				token: state.token,
			});
		});
	}

	function flushPtyQueue(): void {
		if (ptyDrainInFlight) {
			ptyDrainQueued = true;
			return;
		}
		if (ptyQueueSegments === 0) return;
		const queueSegmentsBefore = ptyQueueSegments;
		const queueBytesBefore = ptyQueueBytes;
		const { maxFrameMs, adaptiveApplied } = resolvePtyMaxFrameMs(
			queueSegmentsBefore,
			queueBytesBefore,
		);
		const byteAdaptive =
			(runtimeConfig.ptyAdaptiveQueueBytesThreshold ?? 0) > 0;
		const baseMaxLines = getAdaptiveMaxLinesBase();
		const maxLines = byteAdaptive
			? 0
			: resolvePtyMaxLines(adaptiveApplied, baseMaxLines);
		const maxBytes = resolvePtyMaxBytesPerFrame();
		const minBytes = resolveAdaptiveMinBytes(
			queueBytesBefore,
			adaptiveApplied,
			byteAdaptive,
			maxBytes,
		);
		const token = drainToken++;
		pendingDrains.set(token, {
			adaptiveApplied,
			byteAdaptive,
			maxLines,
			maxFrameMs,
			maxBytes,
			queueSegmentsBefore,
			queueBytesBefore,
		});
		ptyDrainInFlight = true;
		ptyWorker.postMessage({
			type: "drain",
			terminalId: TERMINAL_ID,
			maxLines,
			maxFrameMs,
			maxBytes,
			minBytes,
			token,
		});
	}

	window.addEventListener("message", async (e) => {
		const msg = e.data as ExtensionMessage;
		switch (msg.type) {
			case "test-find-text": {
				const buffer = (term as unknown as { buffer?: any }).buffer;
				let found = false;
				if (buffer?.active) {
					const length = buffer.active.length ?? 0;
					const limit =
						typeof msg.limit === "number" && Number.isFinite(msg.limit)
							? Math.max(1, Math.floor(msg.limit))
							: length;
					const start = Math.max(0, length - limit);
					for (let y = start; y < length; y += 1) {
						const line = buffer.active.getLine(y);
						const lineText = line?.translateToString(true);
						if (lineText?.includes(msg.text)) {
							found = true;
							break;
						}
					}
				}
				vscode.postMessage({
					type: "test-find-text-result",
					terminalId: TERMINAL_ID,
					token: msg.token,
					found,
				});
				break;
			}
			case "test-file-links": {
				const matches = await findFileLinksForText(msg.text, msg.limit);
				vscode.postMessage({
					type: "test-file-links-result",
					terminalId: TERMINAL_ID,
					token: msg.token,
					matches,
				});
				break;
			}
			case "test-search": {
				if (msg.action === "show") {
					searchController.show();
				} else if (msg.action === "hide") {
					searchController.hide();
				}
				if (msg.action !== "hide" && typeof msg.query === "string") {
					searchController.setQuery(msg.query);
				}
				const state = searchController.getState();
				vscode.postMessage({
					type: "test-search-result",
					terminalId: TERMINAL_ID,
					token: msg.token,
					state,
				});
				break;
			}
			case "test-sample-trailing-cells": {
				requestAnimationFrame(() => {
					const result = sampleTrailingCells(term, Math.max(1, msg.count));
					suppressPtyDuringDirectWrite = false;
					vscode.postMessage({
						type: "test-sample-trailing-cells-result",
						terminalId: TERMINAL_ID,
						token: msg.token,
						result,
					});
				});
				break;
			}
			case "test-direct-write": {
				waitForPtyIdle(() => {
					suppressPtyDuringDirectWrite = true;
					term.write(msg.payload);
					requestAnimationFrame(() => {
						vscode.postMessage({
							type: "test-direct-write-result",
							terminalId: TERMINAL_ID,
							token: msg.token,
						});
					});
				});
				break;
			}
			case "pty-data": {
				if (msg.data.byteLength > 0) {
					if (suppressPtyDuringDirectWrite) break;
					pendingPtyMerge.push(msg.data);
					pendingPtyMergeBytes += msg.data.byteLength;
					if (!ptyMergeScheduled) {
						ptyMergeScheduled = true;
						queueMicrotask(flushMergedPtyData);
					}
				}
				break;
			}
			case "pty-exit": {
				ptyWorker.postMessage({
					type: "reset",
					terminalId: TERMINAL_ID,
				});
				ptyQueueBytes = 0;
				ptyQueueSegments = 0;
				pendingPtyChunks.length = 0;
				pendingPtyBytes = 0;
				pendingPtySegments = 0;
				pendingPtyMerge.length = 0;
				pendingPtyMergeBytes = 0;
				ptyMergeScheduled = false;
				ptyDrainInFlight = false;
				ptyDrainQueued = false;
				const termApi = term as unknown as {
					getViewportY?: () => number;
					getScrollbackLength?: () => number;
					scrollToLine?: (line: number) => void;
				};
				const scrollOffset = hasScrollListener
					? currentScrollOffset
					: (termApi.getViewportY?.() ?? 0);
				const scrollbackBefore = termApi.getScrollbackLength?.() ?? 0;
				term.write(
					`\r\n\x1b[90m[Process exited with code ${msg.exitCode}]\x1b[0m\r\n`,
				);
				if (scrollOffset > 0 && termApi.scrollToLine) {
					const scrollbackAfter = termApi.getScrollbackLength?.() ?? 0;
					const delta = scrollbackAfter - scrollbackBefore;
					termApi.scrollToLine(scrollOffset + delta);
				}
				break;
			}
			case "bench-drain-request": {
				if (msg.terminalId === TERMINAL_ID) {
					scheduleBenchDrain(msg.token);
				}
				break;
			}
			case "bench-direct-write": {
				if (msg.terminalId === TERMINAL_ID) {
					startDirectWrite(
						msg.payload,
						msg.repeat,
						msg.finalPayload,
						msg.writesPerFrame ?? 0,
						msg.token,
					);
				}
				break;
			}
			case "resize":
				term.resize(msg.cols, msg.rows);
				break;
			case "update-settings":
				// Hot reload font settings
				if (msg.settings.fontFamily !== undefined) {
					term.options.fontFamily = msg.settings.fontFamily;
				}
				if (msg.settings.fontSize !== undefined) {
					term.options.fontSize = msg.settings.fontSize;
				}
				if (msg.settings.cursorStyle !== undefined) {
					term.options.cursorStyle = msg.settings.cursorStyle;
				}
				// Recalculate dimensions after font change and notify PTY
				if (safeFit()) {
					vscode.postMessage({
						type: "terminal-resize",
						terminalId: TERMINAL_ID,
						cols: term.cols,
						rows: term.rows,
					});
				}
				break;
			case "update-theme": {
				// Hot reload theme colors from extension (colorCustomizations overrides)
				// Merge with CSS variables as base, allowing explicit customizations to override
				// Note: existing cell content keeps original colors (terminal limitation)
				const baseTheme = getVSCodeThemeColors();
				const mergedTheme: TerminalTheme = { ...baseTheme };
				// Only override defined values from colorCustomizations
				for (const [key, value] of Object.entries(msg.theme)) {
					if (value !== undefined) {
						(mergedTheme as Record<string, string | undefined>)[key] = value;
					}
				}
				term.options.theme = mergedTheme;
				break;
			}
			case "update-cwd":
				// Track current working directory for relative path resolution
				currentCwd = msg.cwd;
				// State is saved periodically and on visibility change, no need to save here
				break;
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
				adaptiveMaxLines = null;
				adaptiveLatchActive = false;
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

			case "show-search": {
				searchController.show();
				break;
			}

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
				profileCollector.recordEvent("bootty:renderer-info", {
					renderer: currentRendererType,
					mode: runtimeConfig.renderer,
					fallback: rendererFallback,
					reason: rendererReason ?? null,
				});
				break;
			case "profile-stop":
				profileCollector.stop(msg.sessionId);
				break;
		}
	});

	// Now that listener is registered, send ready with measured dimensions
	vscode.postMessage({
		type: "terminal-ready",
		terminalId: TERMINAL_ID,
		cols: term.cols,
		rows: term.rows,
	});

	// Report renderer status to extension
	vscode.postMessage({
		type: "renderer-status",
		terminalId: TERMINAL_ID,
		renderer: currentRendererType,
		status: currentRendererStatus,
		fallback: rendererFallback,
		reason: rendererReason,
	});

	// Send input to PTY
	term.onData((data: string) => {
		logInput(
			"terminal-input terminal=%s len=%d data=%s",
			TERMINAL_ID,
			data.length,
			JSON.stringify(data),
		);
		vscode.postMessage({
			type: "terminal-input",
			terminalId: TERMINAL_ID,
			data,
		});
	});

	// Handle bell notification
	// Editor terminals don't have a terminal list for bell icons, so just notify extension
	term.onBell(() => {
		if (runtimeConfig.bellStyle === "none") return;
		vscode.postMessage({ type: "terminal-bell", terminalId: TERMINAL_ID });
	});

	// Handle resize: re-fit on container resize, notify extension
	// Debounce to prevent overwhelming WASM during rapid resize (window drag)
	// Note: ghostty-web has a known crash during resize while rendering - wrap in try-catch
	let resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	const RESIZE_DEBOUNCE_MS = 150; // Higher debounce to reduce crash likelihood

	const resizeObserver = new ResizeObserver(() => {
		if (resizeDebounceTimer) {
			clearTimeout(resizeDebounceTimer);
		}
		resizeDebounceTimer = setTimeout(() => {
			resizeDebounceTimer = null;
			try {
				fitAddon.fit();
				vscode.postMessage({
					type: "terminal-resize",
					terminalId: TERMINAL_ID,
					cols: term.cols,
					rows: term.rows,
				});
			} catch (err) {
				// ghostty-web WASM can crash during resize while rendering
				console.warn("[bootty] Resize error (WASM bug):", err);
			}
		}, RESIZE_DEBOUNCE_MS);
	});
	resizeObserver.observe(document.getElementById("terminal-container")!);

	// Scrollback persistence: extract buffer content for state saving
	function extractScrollbackContent(): string[] {
		const lines: string[] = [];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const buffer = (term as any).buffer;
		if (!buffer?.active) return lines;

		const length = buffer.active.length;
		// Limit to prevent excessive state size (max 5000 lines)
		const maxLines = Math.min(length, 5000);
		for (let y = 0; y < maxLines; y++) {
			const line = buffer.active.getLine(y);
			if (line) {
				lines.push(line.translateToString(true));
			}
		}
		return lines;
	}

	// Save state when document becomes hidden (webview about to be destroyed)
	document.addEventListener("visibilitychange", () => {
		const termInstance = term as {
			pauseRendering?: () => void;
			resumeRendering?: () => void;
		};
		if (document.hidden) {
			termInstance.pauseRendering?.();
		} else {
			termInstance.resumeRendering?.();
		}
		if (document.hidden) {
			const scrollbackContent = extractScrollbackContent();
			vscode.setState({
				currentCwd,
				scrollbackContent,
			} as WebviewState);
		}
	});

	// Also save state periodically (every 30 seconds) as backup
	setInterval(() => {
		const scrollbackContent = extractScrollbackContent();
		vscode.setState({
			currentCwd,
			scrollbackContent,
		} as WebviewState);
	}, 30000);

	// Restore scrollback content if available from saved state
	if (
		savedState?.scrollbackContent &&
		savedState.scrollbackContent.length > 0
	) {
		// Write restored content with dim styling to indicate it's history
		const restoredContent = savedState.scrollbackContent.join("\r\n");
		term.write(`\x1b[90m${restoredContent}\x1b[0m\r\n`);
		term.write("\x1b[90m--- Session restored ---\x1b[0m\r\n");
	}

	// Bracketed paste mode: Handle paste events explicitly
	// VS Code webviews may intercept paste events before they reach the terminal
	// container. We add a document-level listener to catch these events and use
	// the terminal's paste() method which correctly wraps text with bracketed
	// paste sequences (\x1b[200~ ... \x1b[201~) when the shell has enabled mode 2004.
	document.addEventListener("paste", (e: ClipboardEvent) => {
		// Skip handling for input elements (search overlay, etc.)
		const target = e.target as HTMLElement;
		if (
			target.tagName === "INPUT" ||
			target.tagName === "TEXTAREA" ||
			target.isContentEditable
		) {
			return;
		}

		const text = e.clipboardData?.getData("text/plain");
		if (!text) return;

		e.preventDefault();
		e.stopPropagation();

		// Use the terminal's paste() method which handles bracketed paste mode
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		if (typeof (term as any).paste === "function") {
			(term as any).paste(text);
		} else {
			// Fallback: check hasBracketedPaste and wrap manually
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const hasBracketedPaste = (term as any).hasBracketedPaste?.() ?? false;
			if (hasBracketedPaste) {
				vscode.postMessage({
					type: "terminal-input",
					terminalId: TERMINAL_ID,
					data: `\x1b[200~${text}\x1b[201~`,
				});
			} else {
				vscode.postMessage({
					type: "terminal-input",
					terminalId: TERMINAL_ID,
					data: text,
				});
			}
		}
	});

	// Drag-and-drop files: paste file path into terminal
	const container = document.getElementById("terminal-container")!;

	container.addEventListener("dragover", (e) => {
		e.preventDefault();
		e.stopPropagation();
		container.classList.add("drag-over");
	});

	container.addEventListener("dragleave", (e) => {
		e.preventDefault();
		e.stopPropagation();
		container.classList.remove("drag-over");
	});

	container.addEventListener("drop", (e) => {
		e.preventDefault();
		e.stopPropagation();
		container.classList.remove("drag-over");

		if (!e.dataTransfer) return;

		// Extract paths from both Finder drops and VS Code Explorer drops (Shift+drag)
		const rawPaths = extractPathsFromDataTransfer(e.dataTransfer);
		if (rawPaths.length > 0) {
			const quotedPaths = rawPaths.map((p) => quoteShellPath(p, IS_WINDOWS));
			vscode.postMessage({
				type: "terminal-input",
				terminalId: TERMINAL_ID,
				data: quotedPaths.join(" "),
			});
			// Focus terminal after drop
			term.focus?.();
		}
	});
};

boottyInit().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	const stack = error instanceof Error ? error.stack : undefined;
	console.error("BooTTY webview init error", error);
	const terminalId = document.body.dataset.terminalId as TerminalId | undefined;
	vscode.postMessage({
		type: "webview-error",
		scope: "editor",
		terminalId,
		message,
		stack,
	});
});
