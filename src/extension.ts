import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { BooTTYPanelViewProvider } from "./panel-view-provider";
import { TerminalManager } from "./terminal-manager";
import type { TerminalLocation } from "./types/terminal";

let manager: TerminalManager | undefined;
let panelProvider: BooTTYPanelViewProvider | undefined;

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

	// Create terminal manager with panel provider
	manager = new TerminalManager(context, panelProvider);
	context.subscriptions.push(manager); // Auto-dispose on deactivate

	// Set up message routing from panel to terminal manager
	panelProvider.setMessageHandler((message) => {
		manager!.handlePanelMessage(message);
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
			panelProvider?.nextTab();
		}),
		vscode.commands.registerCommand("bootty.previousTab", () => {
			panelProvider?.previousTab();
		}),
	);
}

export function deactivate() {
	// manager.dispose() called automatically via subscriptions
}
