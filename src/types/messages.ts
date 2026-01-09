import type { TerminalId } from "./terminal";

/** Display settings for terminal */
export interface DisplaySettings {
	fontFamily?: string;
	fontSize?: number;
}

/** Runtime config for terminal behavior */
export interface RuntimeConfig {
	bellStyle: "visual" | "none";
}

/** Terminal theme colors */
export interface TerminalTheme {
	foreground?: string;
	background?: string;
	cursor?: string;
	cursorAccent?: string;
	selectionBackground?: string;
	selectionForeground?: string;
	black?: string;
	red?: string;
	green?: string;
	yellow?: string;
	blue?: string;
	magenta?: string;
	cyan?: string;
	white?: string;
	brightBlack?: string;
	brightRed?: string;
	brightGreen?: string;
	brightYellow?: string;
	brightBlue?: string;
	brightMagenta?: string;
	brightCyan?: string;
	brightWhite?: string;
}

/** Extension -> Webview (editor terminals) */
export type ExtensionMessage =
	| { type: "pty-data"; terminalId: TerminalId; data: string }
	| { type: "pty-exit"; terminalId: TerminalId; exitCode: number }
	| { type: "resize"; terminalId: TerminalId; cols: number; rows: number }
	| {
			type: "update-settings";
			terminalId: TerminalId;
			settings: DisplaySettings;
	  }
	| { type: "update-theme"; terminalId: TerminalId; theme: TerminalTheme }
	| { type: "update-cwd"; terminalId: TerminalId; cwd: string }
	| {
			type: "batch-file-exists-result";
			batchId: number;
			results: Array<{ path: string; exists: boolean }>;
	  }
	| { type: "update-config"; config: RuntimeConfig };

/** Extension -> Panel Webview (panel-specific messages) */
export type PanelExtensionMessage =
	| ExtensionMessage
	| {
			type: "add-tab";
			terminalId: TerminalId;
			title: string;
			makeActive: boolean;
	  }
	| { type: "remove-tab"; terminalId: TerminalId }
	| { type: "rename-tab"; terminalId: TerminalId; title: string }
	| { type: "activate-tab"; terminalId: TerminalId }
	| { type: "focus-terminal" };

/** Webview -> Extension (editor terminals) */
export type WebviewMessage =
	| { type: "terminal-input"; terminalId: TerminalId; data: string }
	| {
			type: "terminal-resize";
			terminalId: TerminalId;
			cols: number;
			rows: number;
	  }
	| {
			type: "terminal-ready";
			terminalId: TerminalId;
			cols: number;
			rows: number;
	  }
	| { type: "open-url"; terminalId: TerminalId; url: string }
	| {
			type: "open-file";
			terminalId: TerminalId;
			path: string;
			line?: number;
			column?: number;
	  }
	| {
			type: "batch-check-file-exists";
			terminalId: TerminalId;
			batchId: number;
			paths: string[];
	  }
	| { type: "terminal-bell"; terminalId: TerminalId };

/** Panel Webview -> Extension (panel-specific messages) */
export type PanelWebviewMessage =
	| WebviewMessage
	| { type: "panel-ready" } // Panel webview loaded (no terminal yet)
	| {
			type: "tab-activated";
			terminalId: TerminalId;
			cols: number;
			rows: number;
	  } // Tab switch with resize
	| { type: "tab-close-requested"; terminalId: TerminalId }
	| { type: "new-tab-requested" }
	| { type: "new-tab-requested-with-title"; title: string; makeActive: boolean } // Restore with saved metadata
	| { type: "tab-renamed"; terminalId: TerminalId; title: string } // User edited title
	| { type: "toggle-panel-requested" }; // Ctrl+` pressed in terminal
