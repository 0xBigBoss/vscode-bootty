// Type-only imports (stripped at build time)

// Import extracted utilities for testability (bundled by esbuild)
import {
	createFileCache,
	isWindowsPlatform,
	quoteShellPath,
	resolvePath as resolvePathUtil,
} from "../file-cache";
import {
	getKeyHandlerResult,
	isDeleteLineShortcut,
	isMacPlatform,
	isSearchShortcut,
} from "../keybinding-utils";
import type {
	ExtensionMessage,
	RuntimeConfig,
	TerminalTheme,
} from "../types/messages";
import type { TerminalId } from "../types/terminal";

// Import modular components
import {
	createFileLinkProvider,
	FILE_PATH_PATTERN_SINGLE,
} from "./file-link-provider";
import { createSearchController } from "./search-controller";
import { createThemeObserver, getVSCodeThemeColors } from "./theme-utils";

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
(async () => {
	// Read injected config from body data attributes
	const TERMINAL_ID = document.body.dataset.terminalId as TerminalId;
	const WASM_URL = document.body.dataset.wasmUrl || "";

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
	let runtimeConfig: RuntimeConfig = { bellStyle: "visual" };

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

	const termOptions: {
		cols: number;
		rows: number;
		ghostty?: unknown;
		macOptionIsMeta?: boolean;
		onLinkClick?: (url: string, event: MouseEvent) => boolean;
	} = {
		cols: 80,
		rows: 24,
		// Enable Option key as Meta on Mac for word navigation (Option+Left/Right)
		macOptionIsMeta: IS_MAC,
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

	// Initial fit - use double-rAF to ensure layout is complete before measuring
	// VS Code webviews may not have final dimensions until after paint
	requestAnimationFrame(() => {
		requestAnimationFrame(() => {
			fitAddon.fit();
			// Backup fit after 100ms in case webview layout isn't fully settled
			setTimeout(() => fitAddon.fit(), 100);
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
	window.addEventListener("message", (e) => {
		const msg = e.data as ExtensionMessage;
		switch (msg.type) {
			case "pty-data":
				term.write(msg.data);
				break;
			case "pty-exit":
				term.write(
					`\r\n\x1b[90m[Process exited with code ${msg.exitCode}]\x1b[0m\r\n`,
				);
				break;
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
				// Recalculate dimensions after font change and notify PTY
				fitAddon.fit();
				vscode.postMessage({
					type: "terminal-resize",
					terminalId: TERMINAL_ID,
					cols: term.cols,
					rows: term.rows,
				});
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
				break;
			}

			case "show-search": {
				searchController.show();
				break;
			}
		}
	});

	// Now that listener is registered, send ready with measured dimensions
	vscode.postMessage({
		type: "terminal-ready",
		terminalId: TERMINAL_ID,
		cols: term.cols,
		rows: term.rows,
	});

	// Send input to PTY
	term.onData((data: string) => {
		vscode.postMessage({
			type: "terminal-input",
			terminalId: TERMINAL_ID,
			data,
		});
	});

	// Handle bell notification (visual flash and notify extension for audio/system notification)
	term.onBell(() => {
		if (runtimeConfig.bellStyle === "none") return;
		// Visual bell: brief flash of the terminal container
		const container = document.getElementById("terminal-container");
		if (container) {
			container.classList.add("bell-flash");
			setTimeout(() => container.classList.remove("bell-flash"), 150);
		}
		// Notify extension for system-level notification (audio, status bar, etc.)
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

		// Get dropped files
		const files = e.dataTransfer?.files;
		if (!files || files.length === 0) return;

		// Build paths string (space-separated, quoted for shell)
		// Uses extracted utility with platform-aware quoting
		const paths: string[] = [];
		for (let i = 0; i < files.length; i++) {
			const file = files[i];
			// In VS Code webviews, file.path contains the full filesystem path
			// Note: This is a VS Code-specific extension to the File API
			const path = (file as File & { path?: string }).path;
			if (path) {
				// Use platform-aware quoting (POSIX vs Windows)
				paths.push(quoteShellPath(path, IS_WINDOWS));
			}
		}

		if (paths.length > 0) {
			// Send paths to terminal as user input
			vscode.postMessage({
				type: "terminal-input",
				terminalId: TERMINAL_ID,
				data: paths.join(" "),
			});
		}
	});
})();
