import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { BooTTYPanelViewProvider } from "./panel-view-provider";
import { TerminalManager } from "./terminal-manager";
import {
	TerminalTreeDataProvider,
	type TerminalTreeItem,
} from "./terminal-tree-provider";
import type { TerminalId, TerminalLocation } from "./types/terminal";

let manager: TerminalManager | undefined;
let panelProvider: BooTTYPanelViewProvider | undefined;
let treeProvider: TerminalTreeDataProvider | undefined;

/** Check for deprecated ghostty.* settings and warn user */
function checkDeprecatedSettings(): void {
	const deprecatedSettings = [
		"ghostty.fontFamily",
		"ghostty.fontSize",
		"ghostty.defaultTerminalLocation",
		"ghostty.bell",
		"ghostty.notifications",
	];

	const ghosttyConfig = vscode.workspace.getConfiguration("ghostty");
	const foundSettings: string[] = [];

	for (const setting of deprecatedSettings) {
		const key = setting.replace("ghostty.", "");
		const value = ghosttyConfig.inspect(key);
		// Check if user has explicitly set this setting (not just default)
		if (
			value?.globalValue !== undefined ||
			value?.workspaceValue !== undefined ||
			value?.workspaceFolderValue !== undefined
		) {
			foundSettings.push(setting);
		}
	}

	if (foundSettings.length > 0) {
		vscode.window
			.showWarningMessage(
				`BooTTY: Found deprecated "ghostty.*" settings. Please migrate to "bootty.*" settings. Found: ${foundSettings.join(", ")}`,
				"Open Settings",
			)
			.then((selection) => {
				if (selection === "Open Settings") {
					vscode.commands.executeCommand(
						"workbench.action.openSettings",
						"bootty",
					);
				}
			});
	}
}

/** Resolve cwd: ensure it's a directory, fallback to workspace or home */
function resolveCwd(uri?: vscode.Uri): string | undefined {
	if (!uri?.fsPath) {
		// Use first workspace folder or undefined (PtyService uses home)
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}

	try {
		const stat = fs.statSync(uri.fsPath);
		if (stat.isDirectory()) {
			return uri.fsPath;
		}
		// If file, use its parent directory
		return path.dirname(uri.fsPath);
	} catch {
		// Path doesn't exist, fallback
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}
}

/** Get default terminal location from settings */
function getDefaultLocation(): TerminalLocation {
	const config = vscode.workspace.getConfiguration("bootty");
	return config.get<TerminalLocation>("defaultTerminalLocation", "panel");
}

export function activate(context: vscode.ExtensionContext) {
	// Check for deprecated ghostty.* settings and warn user
	checkDeprecatedSettings();

	// Create panel view provider
	panelProvider = new BooTTYPanelViewProvider(context.extensionUri);

	// Create tree data provider for terminal list
	treeProvider = new TerminalTreeDataProvider();

	// Create terminal manager with panel provider and tree provider
	manager = new TerminalManager(context, panelProvider, treeProvider);
	context.subscriptions.push(manager); // Auto-dispose on deactivate

	// Set up message routing from panel to terminal manager
	panelProvider.setMessageHandler((message) => {
		manager!.handlePanelMessage(message);
	});

	// Wire up tree provider selection handler
	treeProvider.setSelectHandler((terminalId) => {
		panelProvider!.activateTerminal(terminalId);
	});

	// Wire up tree provider close handler
	treeProvider.setCloseHandler((terminalId) => {
		manager!.destroyTerminalById(terminalId);
	});

	// Register panel view provider
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			BooTTYPanelViewProvider.viewType,
			panelProvider,
			{
				webviewOptions: {
					retainContextWhenHidden: true,
				},
			},
		),
	);

	// Register tree view provider
	const treeView = vscode.window.createTreeView("boottyTerminalList", {
		treeDataProvider: treeProvider,
		showCollapseAll: false,
	});
	treeProvider.setTreeView(treeView);
	context.subscriptions.push(treeView);

	// Helper to create terminal, showing panel first if location is panel
	async function createTerminalWithLocation(
		location: TerminalLocation,
		cwd?: string,
	) {
		if (location === "panel") {
			// Show panel first so webview can send terminal-ready
			await panelProvider!.show();
		}
		manager!.createTerminal({ cwd, location });
	}

	// Register commands
	context.subscriptions.push(
		// New terminal (respects defaultTerminalLocation setting)
		vscode.commands.registerCommand("bootty.newTerminal", async () => {
			await createTerminalWithLocation(getDefaultLocation(), resolveCwd());
		}),

		// New terminal in editor (explicit)
		vscode.commands.registerCommand("bootty.newTerminalInEditor", () =>
			manager!.createTerminal({
				cwd: resolveCwd(),
				location: "editor",
			}),
		),

		// New terminal in panel (explicit)
		vscode.commands.registerCommand("bootty.newTerminalInPanel", async () => {
			await createTerminalWithLocation("panel", resolveCwd());
		}),

		// Toggle panel (show/hide, auto-create terminal if empty)
		vscode.commands.registerCommand("bootty.togglePanel", async () => {
			if (panelProvider!.isVisible) {
				// Hide the panel
				await vscode.commands.executeCommand("workbench.action.closePanel");
			} else {
				// Show panel
				await panelProvider!.show();
				// Auto-create terminal if panel is empty
				if (!manager!.hasPanelTerminals()) {
					manager!.createTerminal({
						cwd: resolveCwd(),
						location: "panel",
					});
				}
				// Focus the active terminal
				panelProvider!.focusTerminal();
			}
		}),

		// New terminal here (from explorer context menu)
		vscode.commands.registerCommand(
			"bootty.newTerminalHere",
			async (uri?: vscode.Uri) => {
				await createTerminalWithLocation(getDefaultLocation(), resolveCwd(uri));
			},
		),

		// Tab navigation
		vscode.commands.registerCommand("bootty.nextTab", () => {
			const ids = treeProvider?.getTerminalIds() ?? [];
			const activeId = treeProvider?.getActiveTerminalId();
			if (ids.length === 0) return;
			if (!activeId) {
				panelProvider?.activateTerminal(ids[0]);
				return;
			}
			const currentIndex = ids.indexOf(activeId);
			const nextIndex = (currentIndex + 1) % ids.length;
			panelProvider?.activateTerminal(ids[nextIndex]);
		}),
		vscode.commands.registerCommand("bootty.previousTab", () => {
			const ids = treeProvider?.getTerminalIds() ?? [];
			const activeId = treeProvider?.getActiveTerminalId();
			if (ids.length === 0) return;
			if (!activeId) {
				panelProvider?.activateTerminal(ids[ids.length - 1]);
				return;
			}
			const currentIndex = ids.indexOf(activeId);
			const prevIndex = (currentIndex - 1 + ids.length) % ids.length;
			panelProvider?.activateTerminal(ids[prevIndex]);
		}),

		// Tree view commands
		vscode.commands.registerCommand(
			"bootty.selectTerminal",
			(terminalId: TerminalId) => {
				treeProvider?.handleSelect(terminalId);
			},
		),
		vscode.commands.registerCommand(
			"bootty.closeTerminal",
			(item: TerminalTreeItem) => {
				if (item?.terminalId) {
					treeProvider?.handleClose(item.terminalId);
				}
			},
		),
		vscode.commands.registerCommand(
			"bootty.renameTerminal",
			async (item: TerminalTreeItem) => {
				if (!item?.terminalId) return;
				const newName = await vscode.window.showInputBox({
					prompt: "Enter new terminal name",
					value: item.label as string,
				});
				if (newName !== undefined) {
					manager?.renameTerminal(item.terminalId, newName);
				}
			},
		),

		// Search in terminal (Cmd+F / Ctrl+F)
		vscode.commands.registerCommand("bootty.search", () => {
			// Try active editor terminal first (keybinding context determines which is focused)
			if (manager?.showSearchInActiveEditor()) {
				return;
			}
			// Fall back to panel terminal
			panelProvider?.showSearch();
		}),
	);
}

export function deactivate() {
	// manager.dispose() called automatically via subscriptions
}
