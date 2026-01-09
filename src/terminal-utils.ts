import { randomUUID } from "node:crypto";
import type { TerminalConfig, TerminalId } from "./types/terminal";

/** Generate a new unique terminal ID (Node-only, never import in webview) */
export function createTerminalId(): TerminalId {
	return randomUUID() as TerminalId;
}

/** Default terminal configuration */
export const DEFAULT_CONFIG: TerminalConfig = {
	shell: undefined, // Use platform default (detected at spawn)
	cwd: undefined, // Use workspace root or home
	env: undefined, // Inherit process.env at spawn time
	cols: 80,
	rows: 24,
};

/** Merge user config with defaults, inheriting process.env */
export function resolveConfig(
	partial?: Partial<TerminalConfig>,
): TerminalConfig {
	return {
		...DEFAULT_CONFIG,
		...partial,
		// Merge env: start with process.env, add BooTTY identification, overlay user overrides
		env: {
			...process.env,
			TERM_PROGRAM: "bootty",
			TERM_PROGRAM_VERSION: "0.4.0", // ghostty-web version
			COLORTERM: "truecolor",
			...(partial?.env ?? {}),
		} as Record<string, string>,
	};
}

/** Buffer size limits */
export const MAX_DATA_QUEUE_SIZE = 1000; // Max buffered chunks
export const READY_TIMEOUT_MS = 10000; // 10s timeout for terminal-ready
export const EXIT_CLOSE_DELAY_MS = 1500; // Delay before closing panel after PTY exit
