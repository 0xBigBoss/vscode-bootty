/**
 * Panel webview script for multi-terminal management.
 * Handles tab bar UI and multiple terminal instances within a single webview.
 */

import {
	createFileCache,
	isWindowsPlatform,
	quoteShellPath,
	resolvePath as resolvePathUtil,
} from "../file-cache";
import {
	getKeyHandlerResult,
	isMacPlatform,
	isNextTabShortcut,
	isPrevTabShortcut,
	isSearchShortcut,
} from "../keybinding-utils";
import type {
	PanelExtensionMessage,
	PanelWebviewMessage,
	RuntimeConfig,
	TerminalGroup,
	TerminalTheme,
} from "../types/messages";
import type { TerminalId } from "../types/terminal";
import { ContextMenu } from "./context-menu";
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
(async () => {
	const WASM_URL = document.body.dataset.wasmUrl || "";

	// Restore persisted state
	const savedState = vscode.getState() as WebviewState | undefined;

	// Terminal instances
	const terminals = new Map<TerminalId, PanelTerminal>();
	let activeTerminalId: TerminalId | null = null;

	// Runtime config (updated via update-config message)
	let runtimeConfig: RuntimeConfig = { bellStyle: "visual" };

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

		// Create terminal (using any for ghostty-web Terminal options)
		const termOptions: any = {
			cols: 80,
			rows: 24,
			// Enable Option key as Meta on Mac for word navigation (Option+Left/Right)
			macOptionIsMeta: IS_MAC,
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
		const term = new Terminal(termOptions);

		const fitAddon = new FitAddon();
		term.loadAddon(fitAddon);
		term.open(container);

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
			return getKeyHandlerResult(event, IS_MAC, term.hasSelection?.() ?? false);
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
		term.onBell(() => {
			if (runtimeConfig.bellStyle === "none") return;
			container.classList.add("bell-flash");
			setTimeout(() => container.classList.remove("bell-flash"), 150);
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
			const files = e.dataTransfer?.files;
			if (!files || files.length === 0) return;
			const paths: string[] = [];
			for (let i = 0; i < files.length; i++) {
				const file = files[i];
				const path = (file as File & { path?: string }).path;
				if (path) {
					paths.push(quoteShellPath(path, IS_WINDOWS));
				}
			}
			if (paths.length > 0) {
				vscode.postMessage({
					type: "terminal-input",
					terminalId: id,
					data: paths.join(" "),
				});
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

		// Clean up observers
		terminal.themeObserver.disconnect();
		terminal.resizeObserver.disconnect();

		// Clean up search controller
		terminal.searchController.destroy();

		// Remove DOM elements
		terminal.container.remove();

		terminals.delete(id);

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
				}
				// Send terminal-ready
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
					(terminal.term as unknown as { write: (data: string) => void }).write(
						msg.data,
					);
				}
				break;
			}

			case "pty-exit": {
				const terminal = terminals.get(msg.terminalId);
				if (terminal) {
					(terminal.term as unknown as { write: (data: string) => void }).write(
						`\r\n\x1b[90m[Process exited with code ${msg.exitCode}]\x1b[0m\r\n`,
					);
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
				break;
			}
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
})();
