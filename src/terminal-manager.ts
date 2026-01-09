import * as vscode from "vscode";
import type { GhosttyPanelViewProvider } from "./panel-view-provider";
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

/** Get terminal theme colors from workbench.colorCustomizations */
function resolveTerminalTheme(): TerminalTheme {
	const colorCustomizations =
		vscode.workspace
			.getConfiguration("workbench")
			.get<Record<string, string>>("colorCustomizations") ?? {};

	return {
		foreground: colorCustomizations["terminal.foreground"],
		background: colorCustomizations["terminal.background"],
		cursor: colorCustomizations["terminal.cursor.foreground"],
		cursorAccent: colorCustomizations["terminal.cursor.background"],
		selectionBackground: colorCustomizations["terminal.selectionBackground"],
		selectionForeground: colorCustomizations["terminal.selectionForeground"],
		black: colorCustomizations["terminal.ansiBlack"],
		red: colorCustomizations["terminal.ansiRed"],
		green: colorCustomizations["terminal.ansiGreen"],
		yellow: colorCustomizations["terminal.ansiYellow"],
		blue: colorCustomizations["terminal.ansiBlue"],
		magenta: colorCustomizations["terminal.ansiMagenta"],
		cyan: colorCustomizations["terminal.ansiCyan"],
		white: colorCustomizations["terminal.ansiWhite"],
		brightBlack: colorCustomizations["terminal.ansiBrightBlack"],
		brightRed: colorCustomizations["terminal.ansiBrightRed"],
		brightGreen: colorCustomizations["terminal.ansiBrightGreen"],
		brightYellow: colorCustomizations["terminal.ansiBrightYellow"],
		brightBlue: colorCustomizations["terminal.ansiBrightBlue"],
		brightMagenta: colorCustomizations["terminal.ansiBrightMagenta"],
		brightCyan: colorCustomizations["terminal.ansiBrightCyan"],
		brightWhite: colorCustomizations["terminal.ansiBrightWhite"],
	};
}

/** Get the first workspace folder path, or undefined if none open */
function getWorkspaceCwd(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export class TerminalManager implements vscode.Disposable {
	private terminals = new Map<TerminalId, TerminalInstance>();
	private ptyService: PtyService;
	private context: vscode.ExtensionContext;
	private panelProvider: GhosttyPanelViewProvider;
	private terminalCounter = 0; // For generating tab titles

	constructor(
		context: vscode.ExtensionContext,
		panelProvider: GhosttyPanelViewProvider,
	) {
		this.context = context;
		this.panelProvider = panelProvider;
		this.ptyService = new PtyService();

		// Listen for configuration changes (font settings hot reload)
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (
					e.affectsConfiguration("ghostty") ||
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
		}
	}

	/** Get runtime config from VS Code settings */
	private getRuntimeConfig(): RuntimeConfig {
		const bellStyle = vscode.workspace
			.getConfiguration("ghostty")
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
		const panel = createWebviewPanel(this.context.extensionUri, id);
		const instance: EditorTerminalInstance = {
			id,
			location: "editor",
			config: config ?? {},
			panel,
			ready: false,
			dataQueue: [],
			title: `Terminal ${++this.terminalCounter}`,
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
		const title = `Terminal ${++this.terminalCounter}`;
		const instance: PanelTerminalInstance = {
			id,
			location: "panel",
			config: config ?? {},
			ready: false,
			dataQueue: [],
			title,
		};
		this.terminals.set(id, instance);

		// Spawn PTY
		const spawnResult = this.spawnPty(id, config);
		if (!spawnResult.ok) {
			this.terminals.delete(id);
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
		return id;
	}

	/** Create terminal in panel tab with specific title (for state restoration) */
	private createPanelTerminalWithTitle(
		title: string,
		makeActive: boolean,
	): TerminalId | null {
		const id = createTerminalId();
		const cwd = getWorkspaceCwd();
		const instance: PanelTerminalInstance = {
			id,
			location: "panel",
			config: { cwd },
			ready: false,
			dataQueue: [],
			title,
		};
		this.terminals.set(id, instance);

		// Spawn PTY
		const spawnResult = this.spawnPty(id, { cwd });
		if (!spawnResult.ok) {
			this.terminals.delete(id);
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

		// Add tab to panel with specified title and active state
		this.panelProvider.addTerminal(id, title, makeActive);
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
				// Panel webview loaded, ready to receive messages
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
				break;
			case "tab-close-requested":
				this.destroyTerminal(message.terminalId);
				break;
			case "new-tab-requested":
				this.createTerminal({ location: "panel", cwd: getWorkspaceCwd() });
				break;
			case "new-tab-requested-with-title":
				this.createPanelTerminalWithTitle(message.title, message.makeActive);
				break;
			case "tab-renamed":
				this.handleTabRenamed(message.terminalId, message.title);
				break;
			case "toggle-panel-requested":
				// Handled by panel-view-provider, not terminal-manager
				break;
			default:
				// Handle common WebviewMessage types
				this.handleWebviewMessage(message);
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
			.getConfiguration("ghostty")
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
			console.warn(`[ghostty-terminal] Invalid URL: ${url}`);
			return;
		}

		// Security: only allow safe schemes (prevent command:, vscode:, file: etc.)
		if (!TerminalManager.ALLOWED_URL_SCHEMES.has(uri.scheme)) {
			console.warn(
				`[ghostty-terminal] Blocked URL with disallowed scheme: ${uri.scheme}`,
			);
			return;
		}

		// Open URL externally using VS Code's API (works in webviews)
		vscode.env.openExternal(uri).then(
			(success) => {
				if (!success) {
					console.warn(`[ghostty-terminal] Failed to open URL: ${url}`);
				}
			},
			(error) => {
				console.error(`[ghostty-terminal] Error opening URL: ${error}`);
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
			console.warn(`[ghostty-terminal] Failed to open file: ${path}`, error);
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

	private handleTerminalBell(id: TerminalId): void {
		const instance = this.terminals.get(id);
		if (!instance) return;

		// Check bell setting
		const bellStyle = vscode.workspace
			.getConfiguration("ghostty")
			.get<string>("bell", "visual");
		if (bellStyle === "none") return;

		// Show brief status bar notification (less intrusive than info message)
		// This provides audio feedback via VS Code's accessibility settings
		const statusBarItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Right,
			1000,
		);
		statusBarItem.text = "$(bell) Terminal Bell";
		statusBarItem.backgroundColor = new vscode.ThemeColor(
			"statusBarItem.warningBackground",
		);
		statusBarItem.show();

		// Auto-hide after 2 seconds
		setTimeout(() => {
			statusBarItem.dispose();
		}, 2000);
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

		vscode.window.showErrorMessage(`Terminal error: ${error.message}`);
		this.destroyTerminal(id);
	}

	private destroyTerminal(id: TerminalId): void {
		// Idempotency guard: remove from map FIRST to prevent re-entry
		const instance = this.terminals.get(id);
		if (!instance) return; // Already destroyed
		this.terminals.delete(id);

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
		}
	}

	dispose(): void {
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
