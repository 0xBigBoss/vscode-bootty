import type { TerminalId } from "./terminal";

/** Display settings for terminal */
export interface DisplaySettings {
	fontFamily?: string;
	fontSize?: number;
}

/** Renderer mode setting */
export type RendererMode = "auto" | "webgl" | "canvas";

/** Actual renderer type in use */
export type RendererType = "webgl" | "canvas";

/** Renderer status for diagnostics */
export type RendererStatus = "active" | "degraded";

export type ProfileSource = "panel" | "editor";

export interface ProfileEvent {
	name: string;
	ts: number;
	dur?: number;
	data?: Record<string, string | number | boolean | null>;
	source: ProfileSource;
	terminalId?: TerminalId;
}

/** Runtime config for terminal behavior */
export interface RuntimeConfig {
	bellStyle: "visual" | "none";
	renderer: RendererMode;
	debugLog: string;
	ptyMaxLinesPerFrame: number;
	ptyMaxFrameMs: number;
	ptyMaxBytesPerFrame: number;
	ptyAdaptiveDrain: boolean;
	ptyAdaptiveFrameMs: number;
	ptyAdaptiveQueueThreshold: number;
	ptyAdaptiveMaxLinesPerFrame: number;
	ptyAdaptiveMaxLinesPerFrameWebgl: number;
	ptyAdaptiveAutoTune: boolean;
	ptyAdaptiveMinBytesPerFrame: number;
	ptyAdaptiveQueueBytesThreshold: number;
	ptyAdaptiveQueueHysteresisRatio: number;
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
	| { type: "pty-data"; terminalId: TerminalId; data: Uint8Array }
	| { type: "pty-exit"; terminalId: TerminalId; exitCode: number }
	| { type: "resize"; terminalId: TerminalId; cols: number; rows: number }
	| {
			type: "test-find-text";
			terminalId: TerminalId;
			token: string;
			text: string;
			limit?: number;
	  }
	| {
			type: "test-file-links";
			terminalId: TerminalId;
			token: string;
			text: string;
			limit?: number;
	  }
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
	| { type: "update-config"; config: RuntimeConfig; token?: string }
	| { type: "show-search" }
	| { type: "profile-start"; sessionId: string }
	| { type: "profile-stop"; sessionId: string }
	| { type: "bench-drain-request"; terminalId: TerminalId; token: string }
	| {
			type: "bench-direct-write";
			terminalId: TerminalId;
			token: string;
			payload: string;
			repeat: number;
			finalPayload?: string;
			writesPerFrame?: number;
	  };

/** Terminal group for split terminals */
export interface TerminalGroup {
	id: string; // UUID v4
	terminals: TerminalId[]; // Ordered list - first is leftmost pane
}

/** Extension -> Panel Webview (panel-specific messages) */
export type PanelExtensionMessage =
	| ExtensionMessage
	| {
			type: "add-tab";
			terminalId: TerminalId;
			title: string;
			makeActive: boolean;
			// NEW: optional customization fields for hydration
			icon?: string;
			color?: string;
			groupId?: string;
			// NEW: insert after this terminal (for splits)
			insertAfter?: TerminalId;
	  }
	| { type: "remove-tab"; terminalId: TerminalId }
	| { type: "rename-tab"; terminalId: TerminalId; title: string }
	| { type: "activate-tab"; terminalId: TerminalId }
	| { type: "focus-terminal" }
	// NEW: State hydration on VS Code restart
	| { type: "hydrate-state"; listWidth: number }
	// NEW: Split terminal messages
	| {
			type: "split-terminal";
			terminalId: TerminalId;
			newTerminalId: TerminalId;
			groupId: string;
			insertAfter: TerminalId;
	  }
	| { type: "unsplit-terminal"; terminalId: TerminalId }
	| { type: "join-terminal"; terminalId: TerminalId; groupId: string }
	| { type: "group-created"; group: TerminalGroup }
	| { type: "group-destroyed"; groupId: string }
	// NEW: Customization messages
	| {
			type: "update-terminal-color";
			terminalId: TerminalId;
			color: string;
	  }
	| { type: "update-terminal-icon"; terminalId: TerminalId; icon: string }
	// NEW: Reorder terminals (extension -> webview)
	| { type: "reorder-terminals"; terminalIds: TerminalId[] };

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
			type: "test-find-text-result";
			terminalId: TerminalId;
			token: string;
			found: boolean;
	  }
	| {
			type: "test-file-links-result";
			terminalId: TerminalId;
			token: string;
			matches: number;
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
	| { type: "terminal-bell"; terminalId: TerminalId }
	| {
			type: "renderer-status";
			terminalId: TerminalId;
			renderer: RendererType;
			status: RendererStatus;
			fallback: boolean;
			reason?: string;
	  }
	| { type: "config-applied"; token: string }
	| { type: "bench-drain-complete"; terminalId: TerminalId; token: string }
	| {
			type: "bench-direct-write-complete";
			terminalId: TerminalId;
			token: string;
	  }
	| { type: "profile-data"; sessionId: string; events: ProfileEvent[] }
	| { type: "profile-error"; sessionId: string; error: string }
	| {
			type: "webview-error";
			scope: "editor" | "panel";
			message: string;
			terminalId?: TerminalId;
			stack?: string;
	  };

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
	| { type: "rename-requested"; terminalId: TerminalId } // Request rename dialog
	| { type: "tab-renamed"; terminalId: TerminalId; title: string } // User edited title
	| { type: "toggle-panel-requested" } // Ctrl+` pressed in terminal
	| { type: "next-tab-requested" } // Cmd+Shift+] pressed
	| { type: "prev-tab-requested" } // Cmd+Shift+[ pressed
	// NEW: Selection change from list click
	| { type: "terminal-selected"; terminalId: TerminalId }
	// NEW: Split terminal requests
	| { type: "split-requested"; terminalId: TerminalId }
	| { type: "unsplit-requested"; terminalId: TerminalId }
	| { type: "join-requested"; terminalId: TerminalId; targetGroupId: string }
	// NEW: Customization picker requests (opens VS Code quick pick)
	| { type: "color-picker-requested"; terminalId: TerminalId }
	| { type: "icon-picker-requested"; terminalId: TerminalId }
	// NEW: Reorder and list width changes
	| { type: "terminals-reordered"; terminalIds: TerminalId[] }
	| { type: "group-reordered"; groupId: string; terminalIds: TerminalId[] }
	| { type: "list-width-changed"; width: number }
	// NEW: Multi-select group request
	| { type: "group-selected-requested"; terminalIds: TerminalId[] };
