import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { TerminalId } from "./types/terminal";

function createWebviewHtml(
	panel: vscode.WebviewPanel,
	extensionPath: string,
	terminalId: TerminalId,
): string {
	const ghosttyWebPath = path.join(
		extensionPath,
		"node_modules",
		"@0xbigboss",
		"ghostty-web",
		"dist",
	);

	const ghosttyWebJsUri = panel.webview.asWebviewUri(
		vscode.Uri.file(path.join(ghosttyWebPath, "ghostty-web.umd.cjs")),
	);
	const wasmUri = panel.webview.asWebviewUri(
		vscode.Uri.file(path.join(ghosttyWebPath, "ghostty-vt.wasm")),
	);
	const mainJsUri = panel.webview.asWebviewUri(
		vscode.Uri.file(path.join(extensionPath, "out", "webview", "main.js")),
	);
	const stylesUri = panel.webview.asWebviewUri(
		vscode.Uri.file(path.join(extensionPath, "out", "webview", "styles.css")),
	);

	// Read template and replace all placeholders including terminalId
	const templatePath = path.join(
		extensionPath,
		"out",
		"webview",
		"template.html",
	);
	let html = fs.readFileSync(templatePath, "utf8");

	html = html
		.replace(/\{\{cspSource\}\}/g, panel.webview.cspSource)
		.replace(/\{\{terminalId\}\}/g, terminalId) // Critical: inject terminal ID
		.replace(/\{\{wasmUri\}\}/g, wasmUri.toString())
		.replace(/\{\{ghosttyWebJsUri\}\}/g, ghosttyWebJsUri.toString())
		.replace(/\{\{mainJsUri\}\}/g, mainJsUri.toString())
		.replace(/\{\{stylesUri\}\}/g, stylesUri.toString());

	return html;
}

export function createWebviewPanel(
	extensionUri: vscode.Uri,
	terminalId: TerminalId,
): vscode.WebviewPanel {
	const panel = vscode.window.createWebviewPanel(
		"boottyTerminal",
		`BooTTY`,
		vscode.ViewColumn.One,
		{
			enableScripts: true,
			retainContextWhenHidden: true, // Keep terminal alive when hidden
			localResourceRoots: [
				vscode.Uri.joinPath(extensionUri, "out"),
				vscode.Uri.joinPath(
					extensionUri,
					"node_modules",
					"@0xbigboss",
					"ghostty-web",
					"dist",
				),
			],
		},
	);

	// Set HTML content
	panel.webview.html = createWebviewHtml(
		panel,
		extensionUri.fsPath,
		terminalId,
	);

	return panel;
}
