/** Branded terminal ID for type safety (types-only, no runtime imports) */
export type TerminalId = string & { readonly __brand: "TerminalId" };

/** Terminal location - panel (bottom) or editor (tab) */
export type TerminalLocation = "panel" | "editor";

export interface TerminalConfig {
	shell?: string;
	shellArgs?: string[];
	cwd?: string;
	env?: Record<string, string>;
	cols?: number; // Initial cols from FitAddon measurement
	rows?: number; // Initial rows from FitAddon measurement
	location?: TerminalLocation; // Where to open the terminal
}

interface PtyOutputBuffer {
	chunks: Uint8Array[];
	bytes: number;
	flushTimer?: ReturnType<typeof setTimeout>;
	firstByteTime?: number; // Timestamp when first byte of batch arrived
}

/** Base fields shared by all terminal instances */
interface TerminalInstanceBase {
	id: TerminalId;
	config: Partial<TerminalConfig>; // Partial: defaults applied at PTY spawn
	ready: boolean; // Set true after terminal-ready received
	readyTimeout?: ReturnType<typeof setTimeout>; // Timeout for ready signal
	dataQueue: Uint8Array[]; // Buffer PTY data until ready (capped)
	outputBuffer?: PtyOutputBuffer; // Buffered PTY output for batching
	ptySeq?: number; // Monotonic sequence for PTY data messages
	currentCwd?: string; // Current working directory (tracked via OSC 7)
	title: string; // User-editable tab title
	index?: number; // Auto-assigned index for "Terminal N" naming (reused on close)
	// Customization (Phase 3)
	colorKey?: string; // Color key (e.g., "red") - resolves via theme
	color?: string; // Resolved hex color (cached, updated on theme change)
	icon?: string; // Codicon name
}

/** Editor terminals have their own WebviewPanel */
export interface EditorTerminalInstance extends TerminalInstanceBase {
	location: "editor";
	panel: import("vscode").WebviewPanel;
}

/** Panel terminals share the panel WebviewView (no individual panel reference) */
export interface PanelTerminalInstance extends TerminalInstanceBase {
	location: "panel";
}

/**
 * Discriminated union for terminal instances.
 * Use `instance.location` to narrow the type and access location-specific fields.
 * - EditorTerminalInstance has `panel: WebviewPanel`
 * - PanelTerminalInstance has no `panel` field
 */
export type TerminalInstance = EditorTerminalInstance | PanelTerminalInstance;
