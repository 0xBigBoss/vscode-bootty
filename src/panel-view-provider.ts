import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type {
	PanelExtensionMessage,
	PanelWebviewMessage,
} from "./types/messages";
import type { PanelTab, TerminalId } from "./types/terminal";

/** Callback for routing messages from panel webview to terminal manager */
export type PanelMessageHandler = (message: PanelWebviewMessage) => void;

/**
 * WebviewViewProvider for the BooTTY terminal panel in the bottom area.
 * Manages multiple terminal tabs within a single WebviewView.
 */
export class BooTTYPanelViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "boottyTerminalPanel";

	private _view?: vscode.WebviewView;
	private _isReady = false; // True after panel-ready received
	private _messageQueue: PanelExtensionMessage[] = []; // Queue for messages before ready
	private _pendingTerminals: Array<{
		id: TerminalId;
		title: string;
		makeActive: boolean;
	}> = [];
	private _messageHandler?: PanelMessageHandler;
	private _disposables: vscode.Disposable[] = [];

	constructor(private readonly _extensionUri: vscode.Uri) {}

	/** Set the message handler for routing messages to terminal manager */
	setMessageHandler(handler: PanelMessageHandler): void {
		this._messageHandler = handler;
	}

	/** Called by VS Code when the panel view is opened */
	resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		this._view = webviewView;
		this._isReady = false;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this._extensionUri, "out"),
				vscode.Uri.joinPath(
					this._extensionUri,
					"node_modules",
					"@0xbigboss",
					"ghostty-web",
					"dist",
				),
			],
		};

		webviewView.webview.html = this._getHtml(webviewView.webview);

		// Restore state from previous session if available
		const previousState = context.state as { tabs?: PanelTab[] } | undefined;
		if (previousState?.tabs && previousState.tabs.length > 0) {
			// Queue pending terminals to recreate after panel-ready
			for (const tab of previousState.tabs) {
				this._pendingTerminals.push({
					id: tab.id,
					title: tab.title,
					makeActive: tab.active,
				});
			}
		}

		// Handle visibility changes - flush queue when visible
		this._disposables.push(
			webviewView.onDidChangeVisibility(() => {
				if (webviewView.visible && this._isReady) {
					this._flushMessageQueue();
				}
			}),
		);

		// Handle disposal - clean up but don't destroy terminals
		this._disposables.push(
			webviewView.onDidDispose(() => {
				this._view = undefined;
				this._isReady = false;
				// Note: DO NOT destroy terminals here - they persist across panel hides
				for (const d of this._disposables) {
					d.dispose();
				}
				this._disposables = [];
			}),
		);

		// Listen for messages from webview
		this._disposables.push(
			webviewView.webview.onDidReceiveMessage(
				(message: PanelWebviewMessage) => {
					if (message.type === "panel-ready") {
						this._isReady = true;
						this._flushMessageQueue();
						// Restore terminals from saved state with metadata
						for (const pending of this._pendingTerminals) {
							this._messageHandler?.({
								type: "new-tab-requested-with-title",
								title: pending.title,
								makeActive: pending.makeActive,
							});
						}
						this._pendingTerminals = [];
					}
					// Handle toggle-panel-requested by executing the toggle command
					if (message.type === "toggle-panel-requested") {
						vscode.commands.executeCommand("bootty.togglePanel");
						return;
					}
					// Route all messages to the handler
					this._messageHandler?.(message);
				},
			),
		);
	}

	/** Post a message to the panel webview */
	postMessage(message: PanelExtensionMessage): void {
		if (this._isReady && this._view?.visible) {
			this._view.webview.postMessage(message);
		} else {
			this._messageQueue.push(message);
		}
	}

	/** Add a terminal tab to the panel */
	addTerminal(id: TerminalId, title: string, makeActive: boolean): void {
		this.postMessage({
			type: "add-tab",
			terminalId: id,
			title,
			makeActive,
		});
	}

	/** Remove a terminal tab from the panel */
	removeTerminal(id: TerminalId): void {
		this.postMessage({
			type: "remove-tab",
			terminalId: id,
		});
	}

	/** Rename a terminal tab */
	renameTerminal(id: TerminalId, title: string): void {
		this.postMessage({
			type: "rename-tab",
			terminalId: id,
			title,
		});
	}

	/** Activate a specific terminal tab */
	activateTerminal(id: TerminalId): void {
		this.postMessage({
			type: "activate-tab",
			terminalId: id,
		});
	}

	/** Navigate to next tab */
	nextTab(): void {
		this.postMessage({ type: "next-tab" });
	}

	/** Navigate to previous tab */
	previousTab(): void {
		this.postMessage({ type: "previous-tab" });
	}

	/** Focus the active terminal */
	focusTerminal(): void {
		this.postMessage({ type: "focus-terminal" });
	}

	/** Check if the panel is visible */
	get isVisible(): boolean {
		return this._view?.visible ?? false;
	}

	/** Check if the panel is ready to receive messages */
	get isReady(): boolean {
		return this._isReady;
	}

	/** Show the panel view */
	async show(): Promise<void> {
		await vscode.commands.executeCommand(
			`${BooTTYPanelViewProvider.viewType}.focus`,
		);
	}

	private _flushMessageQueue(): void {
		if (!this._view || !this._isReady) return;
		for (const msg of this._messageQueue) {
			this._view.webview.postMessage(msg);
		}
		this._messageQueue = [];
	}

	private _getHtml(webview: vscode.Webview): string {
		const extensionPath = this._extensionUri.fsPath;
		const ghosttyWebPath = path.join(
			extensionPath,
			"node_modules",
			"@0xbigboss",
			"ghostty-web",
			"dist",
		);

		const ghosttyWebJsUri = webview.asWebviewUri(
			vscode.Uri.file(path.join(ghosttyWebPath, "ghostty-web.umd.cjs")),
		);
		const wasmUri = webview.asWebviewUri(
			vscode.Uri.file(path.join(ghosttyWebPath, "ghostty-vt.wasm")),
		);
		const mainJsUri = webview.asWebviewUri(
			vscode.Uri.file(
				path.join(extensionPath, "out", "webview", "panel-main.js"),
			),
		);
		const stylesUri = webview.asWebviewUri(
			vscode.Uri.file(
				path.join(extensionPath, "out", "webview", "panel-styles.css"),
			),
		);

		// Read template and replace placeholders
		const templatePath = path.join(
			extensionPath,
			"out",
			"webview",
			"panel-template.html",
		);
		let html = fs.readFileSync(templatePath, "utf8");

		html = html
			.replace(/\{\{cspSource\}\}/g, webview.cspSource)
			.replace(/\{\{wasmUri\}\}/g, wasmUri.toString())
			.replace(/\{\{ghosttyWebJsUri\}\}/g, ghosttyWebJsUri.toString())
			.replace(/\{\{mainJsUri\}\}/g, mainJsUri.toString())
			.replace(/\{\{stylesUri\}\}/g, stylesUri.toString());

		return html;
	}
}
