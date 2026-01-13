import * as vscode from "vscode";
import type { BooTTYPanelViewProvider } from "./panel-view-provider";
import { PtyService } from "./pty-service";
import {
	createVSCodeConfigGetter,
	resolveDisplaySettings,
} from "./settings-resolver";
import {
	createTerminalId,
	EXIT_CLOSE_DELAY_MS,
	MAX_DATA_QUEUE_SIZE,
	READY_TIMEOUT_MS,
	resolveConfig,
} from "./terminal-utils";
import type {
	ExtensionMessage,
	PanelWebviewMessage,
	RuntimeConfig,
	TerminalGroup,
	TerminalTheme,
	WebviewMessage,
} from "./types/messages";
import type {
	EditorTerminalInstance,
	PanelTerminalInstance,
	TerminalConfig,
	TerminalId,
	TerminalInstance,
	TerminalLocation,
} from "./types/terminal";
import { createWebviewPanel } from "./webview-provider";

/** Get display settings using the shared resolver (tested in settings-resolver.test.ts) */
function getDisplaySettings() {
	const configGetter = createVSCodeConfigGetter((section) =>
		vscode.workspace.getConfiguration(section),
	);
	return resolveDisplaySettings(configGetter);
}

/** Get terminal theme colors from workbench.colorCustomizations with theme-scoped override support */
function resolveTerminalTheme(): TerminalTheme {
	const workbenchConfig = vscode.workspace.getConfiguration("workbench");
	const colorCustomizations =
		workbenchConfig.get<Record<string, unknown>>("colorCustomizations") ?? {};

	// Get current theme name for theme-scoped overrides (e.g., "[Monokai]": {...})
	// Read from workbench.colorTheme setting since activeColorTheme.label is not in public API
	const currentThemeName = workbenchConfig.get<string>("colorTheme");

	// Start with global color customizations (top-level keys without brackets)
	const mergedColors: Record<string, string> = {};
	for (const [key, value] of Object.entries(colorCustomizations)) {
		if (typeof value === "string" && !key.startsWith("[")) {
			mergedColors[key] = value;
		}
	}

	// Apply theme-scoped overrides if current theme matches
	if (currentThemeName) {
		const themeScopedKey = `[${currentThemeName}]`;
		const themeScopedColors = colorCustomizations[themeScopedKey];
		if (themeScopedColors && typeof themeScopedColors === "object") {
			for (const [key, value] of Object.entries(
				themeScopedColors as Record<string, unknown>,
			)) {
				if (typeof value === "string") {
					mergedColors[key] = value;
				} else if (value === null) {
					// null means "unset this color" - remove global override for this theme
					delete mergedColors[key];
				}
			}
		}
	}

	return {
		foreground: mergedColors["terminal.foreground"],
		background: mergedColors["terminal.background"],
		cursor: mergedColors["terminal.cursor.foreground"],
		cursorAccent: mergedColors["terminal.cursor.background"],
		selectionBackground: mergedColors["terminal.selectionBackground"],
		selectionForeground: mergedColors["terminal.selectionForeground"],
		black: mergedColors["terminal.ansiBlack"],
		red: mergedColors["terminal.ansiRed"],
		green: mergedColors["terminal.ansiGreen"],
		yellow: mergedColors["terminal.ansiYellow"],
		blue: mergedColors["terminal.ansiBlue"],
		magenta: mergedColors["terminal.ansiMagenta"],
		cyan: mergedColors["terminal.ansiCyan"],
		white: mergedColors["terminal.ansiWhite"],
		brightBlack: mergedColors["terminal.ansiBrightBlack"],
		brightRed: mergedColors["terminal.ansiBrightRed"],
		brightGreen: mergedColors["terminal.ansiBrightGreen"],
		brightYellow: mergedColors["terminal.ansiBrightYellow"],
		brightBlue: mergedColors["terminal.ansiBrightBlue"],
		brightMagenta: mergedColors["terminal.ansiBrightMagenta"],
		brightCyan: mergedColors["terminal.ansiBrightCyan"],
		brightWhite: mergedColors["terminal.ansiBrightWhite"],
	};
}

/** Get the first workspace folder path, or undefined if none open */
function getWorkspaceCwd(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Persisted terminal state for a single terminal */
interface PersistedTerminalState {
	id: TerminalId;
	index?: number; // Terminal number for "Terminal N" naming
	userTitle?: string;
	icon?: string;
	colorKey?: string; // Stored key (e.g., "red") - resolved to hex on load
	color?: string; // Legacy: direct hex value (for backward compat)
	groupId?: string;
	orderIndex: number;
}

/** Persisted workspace state */
interface PersistedWorkspaceState {
	terminals: PersistedTerminalState[];
	groups: TerminalGroup[];
	activeTerminalId?: TerminalId;
	listWidth: number;
}

/** Storage keys for workspaceState */
const STATE_KEY = "bootty.terminalState";

export class TerminalManager implements vscode.Disposable {
	private terminals = new Map<TerminalId, TerminalInstance>();
	private groups = new Map<string, TerminalGroup>(); // Split groups
	private terminalToGroup = new Map<TerminalId, string>(); // Reverse lookup
	private terminalOrder: TerminalId[] = []; // Ordered list of terminal IDs
	private activeTerminalId: TerminalId | null = null; // Currently selected terminal
	private listWidth = 180; // Persisted list width
	private persistedTerminals: PersistedTerminalState[] = []; // Terminals to restore on hydration
	private ptyService: PtyService;
	private context: vscode.ExtensionContext;
	private panelProvider: BooTTYPanelViewProvider;
	private usedIndices = new Set<number>(); // Track used indices for reuse

	constructor(
		context: vscode.ExtensionContext,
		panelProvider: BooTTYPanelViewProvider,
	) {
		this.context = context;
		this.panelProvider = panelProvider;
		this.ptyService = new PtyService();

		// Restore persisted state
		this.loadPersistedState();

		// Listen for configuration changes (font settings hot reload)
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (
					e.affectsConfiguration("bootty") ||
					e.affectsConfiguration("editor.fontFamily") ||
					e.affectsConfiguration("editor.fontSize")
				) {
					this.broadcastSettingsUpdate();
				}
				// Theme colors from workbench.colorCustomizations
				if (e.affectsConfiguration("workbench.colorCustomizations")) {
					this.broadcastThemeUpdate();
				}
			}),
		);

		// Listen for color theme changes (user switches dark/light theme)
		context.subscriptions.push(
			vscode.window.onDidChangeActiveColorTheme(() => {
				this.broadcastThemeUpdate();
			}),
		);
	}

	/** Get the next available terminal index (reuses freed indices) */
	private getNextIndex(): number {
		let index = 1;
		while (this.usedIndices.has(index)) {
			index++;
		}
		this.usedIndices.add(index);
		return index;
	}

	/** Release a terminal index for reuse */
	private releaseIndex(index: number | undefined): void {
		if (index !== undefined) {
			this.usedIndices.delete(index);
		}
	}

	/** Type-safe message posting using discriminated union */
	private postToTerminal(id: TerminalId, message: ExtensionMessage): void {
		const instance = this.terminals.get(id);
		if (!instance || !instance.ready) return;

		if (instance.location === "editor") {
			// TypeScript knows instance.panel exists here
			instance.panel.webview.postMessage(message);
		} else {
			// instance.location === 'panel' - use panel provider
			this.panelProvider.postMessage(message);
		}
	}

	/** Show search in the active editor terminal (if any) */
	showSearchInActiveEditor(): boolean {
		for (const instance of this.terminals.values()) {
			if (instance.location === "editor" && instance.panel.active) {
				instance.panel.webview.postMessage({ type: "show-search" });
				return true;
			}
		}
		return false;
	}

	/** Broadcast updated settings to all ready terminals */
	private broadcastSettingsUpdate(): void {
		const settings = getDisplaySettings();
		for (const [id, instance] of this.terminals) {
			if (instance.ready) {
				this.postToTerminal(id, {
					type: "update-settings",
					terminalId: id,
					settings,
				});
			}
		}
	}

	/** Broadcast updated theme to all ready terminals */
	private broadcastThemeUpdate(): void {
		const theme = resolveTerminalTheme();
		for (const [id, instance] of this.terminals) {
			if (instance.ready) {
				this.postToTerminal(id, {
					type: "update-theme",
					terminalId: id,
					theme,
				});
			}
			// Re-resolve terminal list colors when theme changes
			if (instance.colorKey) {
				const newColor = TerminalManager.resolveColorKey(instance.colorKey);
				if (newColor && newColor !== instance.color) {
					instance.color = newColor;
					this.panelProvider.postMessage({
						type: "update-terminal-color",
						terminalId: id,
						color: newColor,
					});
				}
			}
		}
	}

	/** Get runtime config from VS Code settings */
	private getRuntimeConfig(): RuntimeConfig {
		const bellStyle = vscode.workspace
			.getConfiguration("bootty")
			.get<"visual" | "none">("bell", "visual");
		return { bellStyle };
	}

	createTerminal(config?: Partial<TerminalConfig>): TerminalId | null {
		const location: TerminalLocation = config?.location ?? "panel";
		return location === "editor"
			? this.createEditorTerminal(config)
			: this.createPanelTerminal(config);
	}

	/** Create terminal in editor tab */
	private createEditorTerminal(
		config?: Partial<TerminalConfig>,
	): TerminalId | null {
		const id = createTerminalId();
		const index = this.getNextIndex();
		const panel = createWebviewPanel(this.context.extensionUri, id);
		const instance: EditorTerminalInstance = {
			id,
			location: "editor",
			config: config ?? {},
			panel,
			ready: false,
			dataQueue: [],
			title: `Terminal ${index}`,
			index,
		};
		this.terminals.set(id, instance);

		// Setup message handler for webview -> extension
		panel.webview.onDidReceiveMessage(
			(message: WebviewMessage) => this.handleWebviewMessage(message),
			undefined,
			this.context.subscriptions,
		);

		// Spawn PTY
		const spawnResult = this.spawnPty(id, config);
		if (!spawnResult.ok) {
			panel.dispose();
			this.terminals.delete(id);
			this.releaseIndex(index);
			return null;
		}

		// Set ready timeout
		instance.readyTimeout = setTimeout(() => {
			if (!instance.ready) {
				vscode.window.showErrorMessage(
					"Terminal failed to initialize (timeout)",
				);
				this.destroyTerminal(id);
			}
		}, READY_TIMEOUT_MS);

		// Cleanup on panel close
		panel.onDidDispose(() => this.destroyTerminal(id));
		return id;
	}

	/** Create terminal in panel tab */
	private createPanelTerminal(
		config?: Partial<TerminalConfig>,
	): TerminalId | null {
		const id = createTerminalId();
		const index = this.getNextIndex();
		const title = `Terminal ${index}`;
		const instance: PanelTerminalInstance = {
			id,
			location: "panel",
			config: config ?? {},
			ready: false,
			dataQueue: [],
			title,
			index,
		};
		this.terminals.set(id, instance);

		// Spawn PTY
		const spawnResult = this.spawnPty(id, config);
		if (!spawnResult.ok) {
			this.terminals.delete(id);
			this.releaseIndex(index);
			return null;
		}

		// Set ready timeout
		instance.readyTimeout = setTimeout(() => {
			if (!instance.ready) {
				vscode.window.showErrorMessage(
					"Terminal failed to initialize (timeout)",
				);
				this.destroyTerminal(id);
			}
		}, READY_TIMEOUT_MS);

		// Add tab to panel (panel handles message routing)
		this.panelProvider.addTerminal(id, title, true);

		// Add to terminal order for persistence
		this.terminalOrder.push(id);
		this.activeTerminalId = id;
		this.savePersistedState();

		return id;
	}

	/** Spawn PTY process for terminal */
	private spawnPty(
		id: TerminalId,
		config?: Partial<TerminalConfig>,
	): { ok: true } | { ok: false; error: string } {
		const resolvedConfig = resolveConfig(config);
		const result = this.ptyService.spawn(id, resolvedConfig, {
			onData: (data) => this.handlePtyData(id, data),
			onExit: (code) => this.handlePtyExit(id, code),
			onError: (error) => this.handlePtyError(id, error),
		});

		if (!result.ok) {
			vscode.window.showErrorMessage(
				`Failed to start terminal: ${result.error}`,
			);
			return { ok: false, error: result.error };
		}
		return { ok: true };
	}

	/** Handle messages from panel webview */
	handlePanelMessage(message: PanelWebviewMessage): void {
		switch (message.type) {
			case "panel-ready":
				// Panel webview loaded, send hydration state
				this.handlePanelReady();
				break;
			case "terminal-ready":
				this.handleTerminalReady(
					message.terminalId,
					message.cols,
					message.rows,
				);
				break;
			case "tab-activated":
				// Tab switch with resize
				this.handleTerminalResize(
					message.terminalId,
					message.cols,
					message.rows,
				);
				// Update active terminal
				this.activeTerminalId = message.terminalId;
				break;
			case "tab-close-requested":
				this.destroyTerminal(message.terminalId);
				break;
			case "new-tab-requested":
				this.createTerminal({ location: "panel", cwd: getWorkspaceCwd() });
				// Focus the newly created terminal
				this.panelProvider.postMessage({ type: "focus-terminal" });
				break;
			// NOTE: new-tab-requested-with-title is deprecated.
			// Terminal restoration is now handled via extension state and hydrate-state message.
			case "tab-renamed":
				this.handleTabRenamed(message.terminalId, message.title);
				break;
			case "rename-requested":
				this.handleRenameRequested(message.terminalId);
				break;
			case "toggle-panel-requested":
			case "next-tab-requested":
			case "prev-tab-requested":
				// Handled by panel-view-provider, not terminal-manager
				break;
			// NEW: Terminal list messages (Phase 1-4)
			case "terminal-selected":
				// Selection change - persist active terminal
				this.activeTerminalId = message.terminalId;
				this.savePersistedState();
				break;
			case "split-requested":
				this.handleSplitTerminal(message.terminalId);
				break;
			case "unsplit-requested":
				this.handleUnsplitTerminal(message.terminalId);
				break;
			case "join-requested":
				this.handleJoinTerminal(message.terminalId, message.targetGroupId);
				break;
			case "color-picker-requested":
				this.handleColorPickerRequested(message.terminalId);
				break;
			case "icon-picker-requested":
				this.handleIconPickerRequested(message.terminalId);
				break;
			case "terminals-reordered":
				this.handleTerminalsReordered(message.terminalIds);
				break;
			case "group-reordered":
				this.handleGroupReordered(message.groupId, message.terminalIds);
				break;
			case "list-width-changed":
				this.handleListWidthChanged(message.width);
				break;
			case "group-selected-requested":
				this.handleGroupSelectedTerminals(message.terminalIds);
				break;
			default:
				// Handle common WebviewMessage types
				this.handleWebviewMessage(message as WebviewMessage);
		}
	}

	/** Handle messages from editor webview */
	private handleWebviewMessage(message: WebviewMessage): void {
		switch (message.type) {
			case "terminal-ready":
				this.handleTerminalReady(
					message.terminalId,
					message.cols,
					message.rows,
				);
				break;
			case "terminal-input":
				this.handleTerminalInput(message.terminalId, message.data);
				break;
			case "terminal-resize":
				this.handleTerminalResize(
					message.terminalId,
					message.cols,
					message.rows,
				);
				break;
			case "open-url":
				this.handleOpenUrl(message.url);
				break;
			case "open-file":
				this.handleOpenFile(message.path, message.line, message.column);
				break;
			case "batch-check-file-exists":
				this.handleBatchCheckFileExists(
					message.terminalId,
					message.batchId,
					message.paths,
				);
				break;
			case "terminal-bell":
				this.handleTerminalBell(message.terminalId);
				break;
		}
	}

	/** Handle tab rename from panel */
	private handleTabRenamed(id: TerminalId, title: string): void {
		const instance = this.terminals.get(id);
		if (instance) {
			instance.title = title;
			this.savePersistedState();
		}
	}

	/** Handle rename request - show VS Code input box */
	private async handleRenameRequested(id: TerminalId): Promise<void> {
		const instance = this.terminals.get(id);
		if (!instance) return;

		const newTitle = await vscode.window.showInputBox({
			prompt: "Enter new terminal name",
			value: instance.title,
			validateInput: (value) => {
				if (!value.trim()) {
					return "Terminal name cannot be empty";
				}
				return null;
			},
		});

		if (newTitle && newTitle !== instance.title) {
			instance.title = newTitle;
			this.panelProvider.renameTerminal(id, newTitle);
			this.savePersistedState();
		}
	}

	/** Check if there are any terminals in the panel */
	hasPanelTerminals(): boolean {
		for (const instance of this.terminals.values()) {
			if (instance.location === "panel") {
				return true;
			}
		}
		return false;
	}

	/** Parse OSC 7 escape sequence for CWD tracking */
	private parseOSC7(data: string): string | undefined {
		// OSC 7 format: ESC ] 7 ; file://hostname/path ESC \ (or BEL)
		const match = data.match(
			/\x1b\]7;file:\/\/[^/]*([^\x07\x1b]+)(?:\x07|\x1b\\)/,
		);
		if (match) {
			return decodeURIComponent(match[1]);
		}
		return undefined;
	}

	/** Parse OSC 9 escape sequence for notifications (iTerm2 style) */
	private parseOSC9(data: string): string | undefined {
		// OSC 9 format: ESC ] 9 ; message BEL (or ST)
		// ESC = \x1b, BEL = \x07, ST = ESC \
		const match = data.match(/\x1b\]9;([^\x07\x1b]*)(?:\x07|\x1b\\)/);
		if (match) {
			return match[1];
		}
		return undefined;
	}

	/** Show VS Code notification for OSC 9 message */
	private handleOSC9Notification(message: string): void {
		const enabled = vscode.workspace
			.getConfiguration("bootty")
			.get<boolean>("notifications", true);
		if (!enabled) return;

		vscode.window.showInformationMessage(message);
	}

	private handlePtyData(id: TerminalId, data: string): void {
		const instance = this.terminals.get(id);
		if (!instance) return;

		// Check for OSC 7 CWD update
		const cwd = this.parseOSC7(data);
		if (cwd) {
			instance.currentCwd = cwd;
			// Notify webview of CWD change for relative path resolution
			if (instance.ready) {
				this.postToTerminal(id, {
					type: "update-cwd",
					terminalId: id,
					cwd,
				});
			}
		}

		// Check for OSC 9 notification
		const notification = this.parseOSC9(data);
		if (notification) {
			this.handleOSC9Notification(notification);
		}

		if (!instance.ready) {
			// Buffer until ready, with cap to prevent memory bloat
			if (instance.dataQueue.length < MAX_DATA_QUEUE_SIZE) {
				instance.dataQueue.push(data);
			}
			// Silently drop if over cap (better than OOM)
		} else {
			this.postToTerminal(id, {
				type: "pty-data",
				terminalId: id,
				data,
			});
		}
	}

	private handleTerminalReady(
		id: TerminalId,
		cols: number,
		rows: number,
	): void {
		const instance = this.terminals.get(id);
		if (!instance) return;

		// Clear the ready timeout
		if (instance.readyTimeout) {
			clearTimeout(instance.readyTimeout);
			instance.readyTimeout = undefined;
		}

		// Resize PTY to webview-measured dimensions
		this.ptyService.resize(id, cols, rows);

		// Mark ready BEFORE posting messages so postToTerminal works
		instance.ready = true;

		// Send initial display settings
		const settings = getDisplaySettings();
		this.postToTerminal(id, {
			type: "update-settings",
			terminalId: id,
			settings,
		});

		// Send initial theme
		const theme = resolveTerminalTheme();
		this.postToTerminal(id, {
			type: "update-theme",
			terminalId: id,
			theme,
		});

		// Send runtime config (bell style, etc.)
		const config = this.getRuntimeConfig();
		this.postToTerminal(id, {
			type: "update-config",
			config,
		});

		// Flush buffered data
		for (const data of instance.dataQueue) {
			this.postToTerminal(id, {
				type: "pty-data",
				terminalId: id,
				data,
			});
		}
		instance.dataQueue = [];
	}

	private handleTerminalInput(id: TerminalId, data: string): void {
		// Forward webview input to PTY
		this.ptyService.write(id, data);
	}

	private handleTerminalResize(
		id: TerminalId,
		cols: number,
		rows: number,
	): void {
		// Webview detected resize, propagate to PTY
		this.ptyService.resize(id, cols, rows);
	}

	// Allowed URL schemes for external opening (security: prevent command injection)
	private static readonly ALLOWED_URL_SCHEMES = new Set([
		"http",
		"https",
		"mailto",
		"ftp",
		"ssh",
		"git",
		"tel",
	]);

	private handleOpenUrl(url: string): void {
		// Parse and validate URL before opening
		let uri: vscode.Uri;
		try {
			uri = vscode.Uri.parse(url, true); // strict mode
		} catch {
			console.warn(`[bootty] Invalid URL: ${url}`);
			return;
		}

		// Security: only allow safe schemes (prevent command:, vscode:, file: etc.)
		if (!TerminalManager.ALLOWED_URL_SCHEMES.has(uri.scheme)) {
			console.warn(
				`[bootty] Blocked URL with disallowed scheme: ${uri.scheme}`,
			);
			return;
		}

		// Open URL externally using VS Code's API (works in webviews)
		vscode.env.openExternal(uri).then(
			(success) => {
				if (!success) {
					console.warn(`[bootty] Failed to open URL: ${url}`);
				}
			},
			(error) => {
				console.error(`[bootty] Error opening URL: ${error}`);
			},
		);
	}

	private async handleOpenFile(
		path: string,
		line?: number,
		column?: number,
	): Promise<void> {
		try {
			const uri = vscode.Uri.file(path);
			const doc = await vscode.workspace.openTextDocument(uri);
			const editor = await vscode.window.showTextDocument(doc);

			if (line !== undefined) {
				const position = new vscode.Position(
					Math.max(0, line - 1), // Convert to 0-indexed
					column !== undefined ? Math.max(0, column - 1) : 0,
				);
				editor.selection = new vscode.Selection(position, position);
				editor.revealRange(
					new vscode.Range(position, position),
					vscode.TextEditorRevealType.InCenter,
				);
			}
		} catch (error) {
			console.warn(`[bootty] Failed to open file: ${path}`, error);
		}
	}

	private async handleBatchCheckFileExists(
		terminalId: TerminalId,
		batchId: number,
		paths: string[],
	): Promise<void> {
		const instance = this.terminals.get(terminalId);
		if (!instance) return;

		// Check all paths in parallel
		const results = await Promise.all(
			paths.map(async (path) => {
				try {
					await vscode.workspace.fs.stat(vscode.Uri.file(path));
					return { path, exists: true };
				} catch {
					return { path, exists: false };
				}
			}),
		);

		this.postToTerminal(terminalId, {
			type: "batch-file-exists-result",
			batchId,
			results,
		});
	}

	private handleTerminalBell(_id: TerminalId): void {
		// Bell indicator is now handled in the webview terminal list
		// No status bar notification needed - matches VS Code's native behavior
	}

	private handlePtyExit(id: TerminalId, exitCode: number): void {
		const instance = this.terminals.get(id);
		if (!instance) return;

		// Notify webview of exit (shows "[Process exited with code N]")
		this.postToTerminal(id, {
			type: "pty-exit",
			terminalId: id,
			exitCode,
		});

		// Close panel after brief delay to allow user to see exit message
		// (Aligns with success criteria: "Exit command closes terminal cleanly")
		setTimeout(() => {
			this.destroyTerminal(id);
		}, EXIT_CLOSE_DELAY_MS);
	}

	private handlePtyError(id: TerminalId, error: Error): void {
		const instance = this.terminals.get(id);
		if (!instance) return;

		// "read EIO" is expected when PTY closes (shell exited) - don't show as error
		const isExpectedClose =
			error.message.includes("EIO") || error.message.includes("EOF");
		if (!isExpectedClose) {
			vscode.window.showErrorMessage(`Terminal error: ${error.message}`);
		}
		this.destroyTerminal(id);
	}

	private destroyTerminal(id: TerminalId): void {
		// Idempotency guard: remove from map FIRST to prevent re-entry
		const instance = this.terminals.get(id);
		if (!instance) return; // Already destroyed
		this.terminals.delete(id);

		// Release index for reuse
		this.releaseIndex(instance.index);

		// Remove from terminal order
		const orderIndex = this.terminalOrder.indexOf(id);
		if (orderIndex >= 0) {
			this.terminalOrder.splice(orderIndex, 1);
		}

		// Remove from any group
		const groupId = this.terminalToGroup.get(id);
		if (groupId) {
			const group = this.groups.get(groupId);
			if (group) {
				const idx = group.terminals.indexOf(id);
				if (idx >= 0) {
					group.terminals.splice(idx, 1);
				}
				// Dissolve group if only 1 terminal left
				if (group.terminals.length <= 1) {
					for (const tid of group.terminals) {
						this.terminalToGroup.delete(tid);
					}
					this.groups.delete(groupId);
					this.panelProvider.postMessage({
						type: "group-destroyed",
						groupId,
					});
				} else {
					// Group still has 2+ members - send update to webview
					this.panelProvider.postMessage({
						type: "group-created",
						group: { id: groupId, terminals: group.terminals },
					});
				}
			}
			this.terminalToGroup.delete(id);
		}

		// Update active terminal if this was active
		if (this.activeTerminalId === id) {
			// Select adjacent terminal
			const remaining = this.getTerminalIds();
			this.activeTerminalId =
				remaining.length > 0 ? remaining[remaining.length - 1] : null;
		}

		// Clear ready timeout if pending
		if (instance.readyTimeout) {
			clearTimeout(instance.readyTimeout);
			instance.readyTimeout = undefined;
		}

		// Kill PTY process (safe to call if already dead)
		this.ptyService.kill(id);

		// Location-aware teardown
		if (instance.location === "editor") {
			// Editor: dispose the WebviewPanel (onDidDispose guard above prevents re-entry)
			instance.panel.dispose();
		} else {
			// Panel: just remove the tab, do NOT dispose the panel WebviewView
			this.panelProvider.removeTerminal(id);

			// Hide panel when last terminal is closed
			const remainingPanelTerminals = [...this.terminals.values()].filter(
				(t) => t.location === "panel",
			);
			if (remainingPanelTerminals.length === 0) {
				vscode.commands.executeCommand("workbench.action.closePanel");
			}

			// Persist state after terminal removal
			this.savePersistedState();
		}
	}

	/** Public method to destroy a terminal by ID (used by tree provider close handler) */
	destroyTerminalById(id: TerminalId): void {
		this.destroyTerminal(id);
	}

	/** Public method to split a terminal (used by split command) */
	splitTerminal(terminalId: TerminalId): void {
		this.handleSplitTerminal(terminalId);
	}

	/** Terminal color options with theme key mapping and fallback colors */
	private static readonly TERMINAL_COLORS: ReadonlyArray<{
		id: string; // Stored key (e.g., "red")
		label: string;
		description: string;
		themeKey: keyof TerminalTheme;
		fallback: string;
	}> = [
		{
			id: "red",
			label: "Red",
			description: "terminal.ansiRed",
			themeKey: "red",
			fallback: "#f14c4c",
		},
		{
			id: "orange",
			label: "Orange",
			description: "terminal.ansiBrightRed",
			themeKey: "brightRed",
			fallback: "#f5a623",
		},
		{
			id: "yellow",
			label: "Yellow",
			description: "terminal.ansiYellow",
			themeKey: "yellow",
			fallback: "#e2c541",
		},
		{
			id: "green",
			label: "Green",
			description: "terminal.ansiGreen",
			themeKey: "green",
			fallback: "#4fb86e",
		},
		{
			id: "blue",
			label: "Blue",
			description: "terminal.ansiBlue",
			themeKey: "blue",
			fallback: "#3b8eea",
		},
		{
			id: "purple",
			label: "Purple",
			description: "terminal.ansiBrightMagenta",
			themeKey: "brightMagenta",
			fallback: "#a95ec7",
		},
		{
			id: "magenta",
			label: "Magenta",
			description: "terminal.ansiMagenta",
			themeKey: "magenta",
			fallback: "#e3699e",
		},
		{
			id: "cyan",
			label: "Cyan",
			description: "terminal.ansiCyan",
			themeKey: "cyan",
			fallback: "#4ec9b0",
		},
	];

	/** Resolve a color key to its current hex value from theme */
	private static resolveColorKey(colorKey: string): string | undefined {
		const colorDef = TerminalManager.TERMINAL_COLORS.find(
			(c) => c.id === colorKey,
		);
		if (!colorDef) return undefined;
		const theme = resolveTerminalTheme();
		return theme[colorDef.themeKey] ?? colorDef.fallback;
	}

	/** Terminal icon options for quick pick */
	private static readonly TERMINAL_ICONS = [
		"terminal",
		"terminal-bash",
		"terminal-cmd",
		"terminal-powershell",
		"star",
		"flame",
		"bug",
		"beaker",
		"rocket",
		"heart",
		"zap",
		"cloud",
	] as const;

	/** Generate a colored circle SVG as a data URI */
	private static colorSvgDataUri(color: string): vscode.Uri {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="${color}"/></svg>`;
		const encoded = Buffer.from(svg).toString("base64");
		return vscode.Uri.parse(`data:image/svg+xml;base64,${encoded}`);
	}

	/** Handle color picker request - show VS Code quick pick */
	private async handleColorPickerRequested(
		terminalId: TerminalId,
	): Promise<void> {
		const instance = this.terminals.get(terminalId);
		if (!instance) return;

		// Get theme colors from workbench.colorCustomizations
		const theme = resolveTerminalTheme();

		// Build items with dynamically colored SVG icons
		const items: (vscode.QuickPickItem & {
			colorKey: string;
			color: string;
		})[] = TerminalManager.TERMINAL_COLORS.map((c) => {
			// Use theme color if set, otherwise fall back to default
			const color = theme[c.themeKey] ?? c.fallback;
			return {
				label: c.label,
				description: c.description,
				iconPath: TerminalManager.colorSvgDataUri(color),
				colorKey: c.id,
				color,
			};
		});

		// Add reset option (no icon)
		items.push({ label: "Reset to default", colorKey: "", color: "" });

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: "Select a color for the terminal",
		});

		if (selected) {
			// Store the color key for dynamic resolution on theme changes
			instance.colorKey = selected.colorKey || undefined;
			instance.color = selected.color || undefined;
			// Forward to webview to update list UI
			this.panelProvider.postMessage({
				type: "update-terminal-color",
				terminalId,
				color: selected.color,
			});
			this.savePersistedState();
		}
	}

	/** Handle icon picker request - show VS Code quick pick */
	private async handleIconPickerRequested(
		terminalId: TerminalId,
	): Promise<void> {
		const instance = this.terminals.get(terminalId);
		if (!instance) return;

		const items = TerminalManager.TERMINAL_ICONS.map((icon) => ({
			label: `$(${icon}) ${icon}`,
			icon,
		}));

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: "Select an icon for the terminal",
		});

		if (selected) {
			instance.icon = selected.icon;
			// Forward to webview to update list UI
			this.panelProvider.postMessage({
				type: "update-terminal-icon",
				terminalId,
				icon: selected.icon,
			});
			this.savePersistedState();
		}
	}

	/** Handle terminals reorder */
	private handleTerminalsReordered(terminalIds: TerminalId[]): void {
		// Update terminal order
		this.terminalOrder = terminalIds;
		this.savePersistedState();
	}

	/** Handle group reorder (within-group drag) */
	private handleGroupReordered(
		groupId: string,
		terminalIds: TerminalId[],
	): void {
		const group = this.groups.get(groupId);
		if (!group) return;

		// Update group's terminal order
		group.terminals = terminalIds;

		// Also update terminalOrder to reflect the new within-group order
		// Find where this group's terminals are in terminalOrder and replace them
		const groupTerminalSet = new Set(terminalIds);
		const firstGroupIndex = this.terminalOrder.findIndex((id) =>
			groupTerminalSet.has(id),
		);
		if (firstGroupIndex !== -1) {
			// Remove all group terminals from their current positions
			this.terminalOrder = this.terminalOrder.filter(
				(id) => !groupTerminalSet.has(id),
			);
			// Insert them back in the new order at the original position
			this.terminalOrder.splice(firstGroupIndex, 0, ...terminalIds);
		}

		// Send updated group back to webview so pane order updates
		this.panelProvider.postMessage({
			type: "group-created",
			group: { id: groupId, terminals: terminalIds },
		});
		this.savePersistedState();
	}

	/** Handle list width change */
	private handleListWidthChanged(width: number): void {
		this.listWidth = width;
		this.savePersistedState();
	}

	/** Rename a terminal (updates panel tab) */
	renameTerminal(id: TerminalId, title: string): void {
		const instance = this.terminals.get(id);
		if (!instance) return;

		instance.title = title;

		if (instance.location === "panel") {
			this.panelProvider.renameTerminal(id, title);
			this.savePersistedState();
		}
		// Editor terminals: title is shown in panel title, which we could also update
	}

	/** Handle split terminal request - creates a new terminal in a group with the source */
	private handleSplitTerminal(sourceTerminalId: TerminalId): void {
		const sourceInstance = this.terminals.get(sourceTerminalId);
		if (!sourceInstance || sourceInstance.location !== "panel") return;

		// Generate group ID if not already in a group
		let groupId = this.terminalToGroup.get(sourceTerminalId);
		let group: TerminalGroup;

		if (groupId) {
			// Already in a group - add to it
			group = this.groups.get(groupId)!;
		} else {
			// Create new group
			groupId = createTerminalId(); // Use same UUID generator for groups
			group = { id: groupId, terminals: [sourceTerminalId] };
			this.groups.set(groupId, group);
			this.terminalToGroup.set(sourceTerminalId, groupId);
		}

		// Create the new split terminal (with makeActive: false, inserted after source)
		const newId = this.createPanelTerminalForSplit(
			sourceInstance.currentCwd ?? getWorkspaceCwd(),
			sourceTerminalId,
		);
		if (!newId) return;

		// Add new terminal to the group (insert after source)
		const insertIndex = group.terminals.indexOf(sourceTerminalId) + 1;
		group.terminals.splice(insertIndex, 0, newId);
		this.terminalToGroup.set(newId, groupId);

		// Send group-created AFTER add-tab but with correct member list
		this.panelProvider.postMessage({
			type: "group-created",
			group: { id: groupId, terminals: group.terminals },
		});

		// Send split-terminal message
		this.panelProvider.postMessage({
			type: "split-terminal",
			terminalId: newId,
			newTerminalId: newId,
			groupId,
			insertAfter: sourceTerminalId,
		});

		// Persist state
		this.savePersistedState();
	}

	/** Handle grouping multiple selected terminals into a new group */
	private handleGroupSelectedTerminals(terminalIds: TerminalId[]): void {
		// Need at least 2 terminals to group
		if (terminalIds.length < 2) return;

		// Verify all terminals exist and are panel terminals
		const validIds: TerminalId[] = [];
		for (const id of terminalIds) {
			const instance = this.terminals.get(id);
			if (instance && instance.location === "panel") {
				validIds.push(id);
			}
		}
		if (validIds.length < 2) return;

		// Remove any selected terminals from their current groups first
		for (const id of validIds) {
			const existingGroupId = this.terminalToGroup.get(id);
			if (existingGroupId) {
				const existingGroup = this.groups.get(existingGroupId);
				if (existingGroup) {
					existingGroup.terminals = existingGroup.terminals.filter(
						(tid) => tid !== id,
					);
					if (existingGroup.terminals.length <= 1) {
						// Group is no longer valid, clean up
						for (const remainingId of existingGroup.terminals) {
							this.terminalToGroup.delete(remainingId);
						}
						this.groups.delete(existingGroupId);
						this.panelProvider.postMessage({
							type: "group-destroyed",
							groupId: existingGroupId,
						});
					} else {
						// Update the group
						this.panelProvider.postMessage({
							type: "group-created",
							group: existingGroup,
						});
					}
				}
				this.terminalToGroup.delete(id);
			}
		}

		// Create new group with all selected terminals (preserving their order in the list)
		const groupId = createTerminalId();
		const group: TerminalGroup = { id: groupId, terminals: validIds };
		this.groups.set(groupId, group);

		// Set group membership for all terminals
		for (const id of validIds) {
			this.terminalToGroup.set(id, groupId);
		}

		// Update terminalOrder: move all grouped terminals together at the first one's position
		const groupedSet = new Set(validIds);
		const firstIndex = this.terminalOrder.findIndex((id) => groupedSet.has(id));
		if (firstIndex !== -1) {
			// Remove all grouped terminals from their current positions
			this.terminalOrder = this.terminalOrder.filter(
				(id) => !groupedSet.has(id),
			);
			// Insert them back together at the first one's original position
			this.terminalOrder.splice(firstIndex, 0, ...validIds);
		}

		// Send group-created message
		this.panelProvider.postMessage({
			type: "group-created",
			group,
		});

		// Persist state
		this.savePersistedState();
	}

	/** Create a panel terminal for split (doesn't auto-activate, inserts after source) */
	private createPanelTerminalForSplit(
		cwd: string | undefined,
		insertAfter: TerminalId,
	): TerminalId | null {
		const id = createTerminalId();
		const index = this.getNextIndex();
		const title = `Terminal ${index}`;
		const instance: PanelTerminalInstance = {
			id,
			location: "panel",
			config: { cwd },
			ready: false,
			dataQueue: [],
			title,
			index,
		};
		this.terminals.set(id, instance);

		// Spawn PTY
		const spawnResult = this.spawnPty(id, { cwd });
		if (!spawnResult.ok) {
			this.terminals.delete(id);
			this.releaseIndex(index);
			return null;
		}

		// Set ready timeout
		instance.readyTimeout = setTimeout(() => {
			if (!instance.ready) {
				vscode.window.showErrorMessage(
					"Terminal failed to initialize (timeout)",
				);
				this.destroyTerminal(id);
			}
		}, READY_TIMEOUT_MS);

		// Add tab to panel WITHOUT makeActive (split doesn't change selection)
		// Pass insertAfter so the webview inserts it in the correct position
		this.panelProvider.addTerminal(id, title, false, { insertAfter });

		// Insert after source terminal in terminalOrder (not append)
		const sourceIndex = this.terminalOrder.indexOf(insertAfter);
		if (sourceIndex >= 0) {
			this.terminalOrder.splice(sourceIndex + 1, 0, id);
		} else {
			// Fallback: append if source not found
			this.terminalOrder.push(id);
		}

		return id;
	}

	/** Handle unsplit terminal request - removes terminal from its group */
	private handleUnsplitTerminal(terminalId: TerminalId): void {
		const groupId = this.terminalToGroup.get(terminalId);
		if (!groupId) return; // Not in a group

		const group = this.groups.get(groupId);
		if (!group) return;

		// Remove from group first
		const index = group.terminals.indexOf(terminalId);
		if (index >= 0) {
			group.terminals.splice(index, 1);
		}
		this.terminalToGroup.delete(terminalId);

		// Find last remaining terminal in group AFTER removal (for repositioning)
		const lastGroupTerminal =
			group.terminals.length > 0
				? group.terminals[group.terminals.length - 1]
				: undefined;

		// Reposition unsplit terminal in terminalOrder to be after the remaining group
		const currentOrderIndex = this.terminalOrder.indexOf(terminalId);
		if (currentOrderIndex >= 0) {
			this.terminalOrder.splice(currentOrderIndex, 1);
		}
		// Find the last remaining group member's position and insert after it
		if (lastGroupTerminal) {
			const lastMemberIndex = this.terminalOrder.indexOf(lastGroupTerminal);
			if (lastMemberIndex >= 0) {
				this.terminalOrder.splice(lastMemberIndex + 1, 0, terminalId);
			} else {
				this.terminalOrder.push(terminalId);
			}
		} else {
			// No remaining group members, append at end
			this.terminalOrder.push(terminalId);
		}

		// Check if group should be destroyed
		if (group.terminals.length <= 1) {
			// Destroy the group - remaining terminal becomes standalone
			for (const tid of group.terminals) {
				this.terminalToGroup.delete(tid);
			}
			this.groups.delete(groupId);
			this.panelProvider.postMessage({
				type: "group-destroyed",
				groupId,
			});
		} else {
			// Update group
			this.panelProvider.postMessage({
				type: "group-created",
				group: { id: groupId, terminals: group.terminals },
			});
		}

		// Notify webview of unsplit
		this.panelProvider.postMessage({
			type: "unsplit-terminal",
			terminalId,
		});

		// Send updated order to webview
		this.panelProvider.postMessage({
			type: "reorder-terminals",
			terminalIds: this.terminalOrder,
		});

		// Persist state
		this.savePersistedState();
	}

	/** Handle join terminal request - adds terminal to an existing group */
	private handleJoinTerminal(
		terminalId: TerminalId,
		targetGroupId: string,
	): void {
		const instance = this.terminals.get(terminalId);
		if (!instance || instance.location !== "panel") return;

		// First unsplit from current group if in one (without sending reorder yet)
		const currentGroupId = this.terminalToGroup.get(terminalId);
		if (currentGroupId) {
			this.handleUnsplitTerminalWithoutReorder(terminalId);
		}

		// Add to target group
		const targetGroup = this.groups.get(targetGroupId);
		if (!targetGroup) return;

		targetGroup.terminals.push(terminalId);
		this.terminalToGroup.set(terminalId, targetGroupId);

		// Reposition terminal in terminalOrder to be with target group
		const currentOrderIndex = this.terminalOrder.indexOf(terminalId);
		if (currentOrderIndex >= 0) {
			this.terminalOrder.splice(currentOrderIndex, 1);
		}
		// Insert after the last member of target group
		const lastTargetMember =
			targetGroup.terminals[targetGroup.terminals.length - 2]; // -2 because we just pushed
		const lastMemberIndex = this.terminalOrder.indexOf(lastTargetMember);
		if (lastMemberIndex >= 0) {
			this.terminalOrder.splice(lastMemberIndex + 1, 0, terminalId);
		} else {
			this.terminalOrder.push(terminalId);
		}

		// Notify webview
		this.panelProvider.postMessage({
			type: "group-created",
			group: { id: targetGroupId, terminals: targetGroup.terminals },
		});
		this.panelProvider.postMessage({
			type: "join-terminal",
			terminalId,
			groupId: targetGroupId,
		});
		this.panelProvider.postMessage({
			type: "reorder-terminals",
			terminalIds: this.terminalOrder,
		});

		// Persist state
		this.savePersistedState();
	}

	/** Handle unsplit without sending reorder (used by join which does its own reorder) */
	private handleUnsplitTerminalWithoutReorder(terminalId: TerminalId): void {
		const groupId = this.terminalToGroup.get(terminalId);
		if (!groupId) return;

		const group = this.groups.get(groupId);
		if (!group) return;

		// Remove from group
		const index = group.terminals.indexOf(terminalId);
		if (index >= 0) {
			group.terminals.splice(index, 1);
		}
		this.terminalToGroup.delete(terminalId);

		// Check if group should be destroyed
		if (group.terminals.length <= 1) {
			for (const tid of group.terminals) {
				this.terminalToGroup.delete(tid);
			}
			this.groups.delete(groupId);
			this.panelProvider.postMessage({
				type: "group-destroyed",
				groupId,
			});
		} else {
			this.panelProvider.postMessage({
				type: "group-created",
				group: { id: groupId, terminals: group.terminals },
			});
		}

		this.panelProvider.postMessage({
			type: "unsplit-terminal",
			terminalId,
		});
	}

	/** Load persisted state from workspaceState */
	private loadPersistedState(): void {
		const state =
			this.context.workspaceState.get<PersistedWorkspaceState>(STATE_KEY);
		if (!state) return;

		// Restore list width
		this.listWidth = state.listWidth ?? 180;

		// Store terminals for hydration (they'll be recreated when panel is ready)
		this.persistedTerminals = state.terminals ?? [];

		// Pre-populate usedIndices from persisted terminals to avoid duplicate numbering
		for (const terminal of this.persistedTerminals) {
			if (terminal.index !== undefined) {
				this.usedIndices.add(terminal.index);
			}
		}

		// Restore groups (but don't rebuild terminalToGroup yet - terminals don't exist)
		// Groups will be sent to webview during hydration
		for (const group of state.groups) {
			this.groups.set(group.id, {
				id: group.id,
				terminals: [...group.terminals],
			});
		}

		// Restore active terminal ID (will be used during hydration)
		this.activeTerminalId = state.activeTerminalId ?? null;
	}

	/** Save state to workspaceState */
	private savePersistedState(): void {
		const terminals: PersistedTerminalState[] = [];

		for (let i = 0; i < this.terminalOrder.length; i++) {
			const id = this.terminalOrder[i];
			const instance = this.terminals.get(id);
			if (instance && instance.location === "panel") {
				terminals.push({
					id,
					index: instance.index,
					userTitle: instance.title,
					icon: instance.icon,
					colorKey: instance.colorKey,
					color: instance.color, // Keep for backward compat
					groupId: this.terminalToGroup.get(id),
					orderIndex: i,
				});
			}
		}

		const groups: TerminalGroup[] = Array.from(this.groups.values());

		const state: PersistedWorkspaceState = {
			terminals,
			groups,
			activeTerminalId: this.activeTerminalId ?? undefined,
			listWidth: this.listWidth,
		};

		this.context.workspaceState.update(STATE_KEY, state);
	}

	/** Get ordered terminal IDs for panel terminals */
	getTerminalIds(): TerminalId[] {
		return this.terminalOrder.filter((id) => {
			const instance = this.terminals.get(id);
			return instance?.location === "panel";
		});
	}

	/** Get the active terminal ID */
	getActiveTerminalId(): TerminalId | undefined {
		return this.activeTerminalId ?? undefined;
	}

	/** Handle panel-ready by recreating terminals and sending hydration state */
	handlePanelReady(): void {
		// Send hydrate-state with UI configuration
		this.panelProvider.postMessage({
			type: "hydrate-state",
			listWidth: this.listWidth,
		});

		// Recreate terminals from persisted state (add-tab includes groupId)
		const savedActiveId = this.activeTerminalId;
		for (const persisted of this.persistedTerminals) {
			const newId = this.createPanelTerminalForHydration(persisted);
			if (newId && persisted.groupId) {
				// Rebuild terminalToGroup mapping
				this.terminalToGroup.set(newId, persisted.groupId);
			}
		}

		// Send group-created AFTER add-tab messages so webview has terminals
		for (const group of this.groups.values()) {
			this.panelProvider.postMessage({
				type: "group-created",
				group: { id: group.id, terminals: group.terminals },
			});
		}

		// Clear persisted terminals (they've been recreated)
		this.persistedTerminals = [];

		// Auto-create a terminal if none exist (fresh start or all previously killed)
		const panelTerminals = [...this.terminals.values()].filter(
			(t) => t.location === "panel",
		);
		if (panelTerminals.length === 0) {
			this.createPanelTerminal();
			return; // createPanelTerminal handles activation
		}

		// Activate the saved active terminal
		if (savedActiveId && this.terminals.has(savedActiveId)) {
			this.panelProvider.postMessage({
				type: "activate-tab",
				terminalId: savedActiveId,
			});
			this.panelProvider.postMessage({
				type: "focus-terminal",
			});
		}
	}

	/** Create a panel terminal for hydration (doesn't auto-activate) */
	private createPanelTerminalForHydration(
		persisted: PersistedTerminalState,
	): TerminalId | null {
		const id = persisted.id; // Use the persisted ID
		// Use persisted index if available; indices were pre-populated in loadPersistedState
		const index = persisted.index ?? this.getNextIndex();
		const title = persisted.userTitle ?? `Terminal ${index}`;
		// Resolve color: prefer colorKey (dynamic), fall back to legacy color (static)
		const colorKey = persisted.colorKey;
		const color = colorKey
			? TerminalManager.resolveColorKey(colorKey)
			: persisted.color;
		const instance: PanelTerminalInstance = {
			id,
			location: "panel",
			config: {},
			ready: false,
			dataQueue: [],
			title,
			index,
			icon: persisted.icon,
			colorKey,
			color,
		};
		this.terminals.set(id, instance);

		// Spawn PTY (use workspace cwd since we don't persist cwd)
		const spawnResult = this.spawnPty(id, { cwd: getWorkspaceCwd() });
		if (!spawnResult.ok) {
			this.terminals.delete(id);
			this.releaseIndex(index);
			return null;
		}

		// Set ready timeout
		instance.readyTimeout = setTimeout(() => {
			if (!instance.ready) {
				vscode.window.showErrorMessage(
					"Terminal failed to initialize (timeout)",
				);
				this.destroyTerminal(id);
			}
		}, READY_TIMEOUT_MS);

		// Add tab to panel with all customizations in one message
		this.panelProvider.addTerminal(id, title, false, {
			icon: persisted.icon,
			color,
			groupId: persisted.groupId,
		});

		// Add to terminal order
		this.terminalOrder.push(id);

		return id;
	}

	dispose(): void {
		// Save state before disposing
		this.savePersistedState();

		for (const [id, instance] of this.terminals) {
			if (instance.readyTimeout) {
				clearTimeout(instance.readyTimeout);
			}
			this.ptyService.kill(id);
			if (instance.location === "editor") {
				instance.panel.dispose();
			}
			// Panel terminals: don't dispose panel WebviewView, just let it clean up
		}
		this.terminals.clear();
		this.ptyService.dispose();
	}
}
