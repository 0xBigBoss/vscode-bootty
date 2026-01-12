/**
 * Keybinding utilities for terminal passthrough logic
 * Extracted for testability
 */

export interface KeyEvent {
	key: string;
	metaKey: boolean;
	ctrlKey: boolean;
	shiftKey: boolean;
	altKey: boolean;
}

export type KeyHandlerResult =
	| true // Terminal handled (preventDefault)
	| false // Bubble to VS Code
	| undefined; // Default terminal processing

/**
 * Detect if running on macOS
 */
export function isMacPlatform(navigator: { platform: string }): boolean {
	return navigator.platform.toUpperCase().indexOf("MAC") >= 0;
}

/**
 * Check if Cmd+F or Ctrl+F for search
 */
export function isSearchShortcut(event: KeyEvent, isMac: boolean): boolean {
	if (isMac) {
		return event.metaKey && event.key === "f";
	}
	return event.ctrlKey && event.key === "f";
}

/**
 * Check if Cmd+Shift+] or Ctrl+Shift+] for next tab
 */
export function isNextTabShortcut(event: KeyEvent, isMac: boolean): boolean {
	if (isMac) {
		return event.metaKey && event.shiftKey && event.key === "]";
	}
	return event.ctrlKey && event.shiftKey && event.key === "]";
}

/**
 * Check if Cmd+Shift+[ or Ctrl+Shift+[ for previous tab
 */
export function isPrevTabShortcut(event: KeyEvent, isMac: boolean): boolean {
	if (isMac) {
		return event.metaKey && event.shiftKey && event.key === "[";
	}
	return event.ctrlKey && event.shiftKey && event.key === "[";
}

/**
 * Check if Cmd+Backspace for delete line (Mac only)
 * Windows/Linux users can use Ctrl+U directly in the terminal
 */
export function isDeleteLineShortcut(event: KeyEvent, isMac: boolean): boolean {
	if (isMac) {
		// Only match Cmd+Backspace without other modifiers (shift, alt, ctrl)
		return (
			event.metaKey &&
			!event.shiftKey &&
			!event.altKey &&
			!event.ctrlKey &&
			event.key === "Backspace"
		);
	}
	return false;
}

/**
 * Check if Cmd+Left for jump to beginning of line (Mac only)
 * Windows/Linux users can use Ctrl+A or Home directly in the terminal
 */
export function isLineStartShortcut(event: KeyEvent, isMac: boolean): boolean {
	if (isMac) {
		return (
			event.metaKey &&
			!event.shiftKey &&
			!event.altKey &&
			!event.ctrlKey &&
			event.key === "ArrowLeft"
		);
	}
	return false;
}

/**
 * Check if Cmd+Right for jump to end of line (Mac only)
 * Windows/Linux users can use Ctrl+E or End directly in the terminal
 */
export function isLineEndShortcut(event: KeyEvent, isMac: boolean): boolean {
	if (isMac) {
		return (
			event.metaKey &&
			!event.shiftKey &&
			!event.altKey &&
			!event.ctrlKey &&
			event.key === "ArrowRight"
		);
	}
	return false;
}

/**
 * Determine how to handle a key event in the terminal
 *
 * On Mac:
 * - Cmd combos → bubble to VS Code
 * - Ctrl+letter → terminal control sequences (Ctrl+C, etc.)
 *
 * On Windows/Linux:
 * - Ctrl+Shift combos → bubble to VS Code
 * - Ctrl+C with selection → bubble (for copy)
 * - Ctrl+letter → terminal control sequences
 * - Other Ctrl combos → bubble to VS Code
 */
export function getKeyHandlerResult(
	event: KeyEvent,
	isMac: boolean,
	hasSelection: boolean,
): KeyHandlerResult {
	if (isMac) {
		// Cmd combos bubble to VS Code (Cmd+P, Cmd+Shift+P, etc.)
		if (event.metaKey) {
			return false;
		}
		// Ctrl+Shift combos bubble to VS Code (Ctrl+Shift+`, etc.)
		if (event.ctrlKey && event.shiftKey) {
			return false;
		}
		// Ctrl+letter on Mac: let terminal process as control sequences (Ctrl+C→^C, etc.)
		if (
			event.ctrlKey &&
			!event.altKey &&
			event.key.length === 1 &&
			/[a-zA-Z]/.test(event.key)
		) {
			return undefined;
		}
	} else {
		// Windows/Linux: Ctrl serves dual purpose
		if (event.ctrlKey) {
			// Ctrl+Shift combos: bubble to VS Code (Ctrl+Shift+P, etc.)
			if (event.shiftKey) {
				return false;
			}
			// Ctrl+C with selection: bubble to let browser handle copy
			if (event.key === "c" && hasSelection) {
				return false;
			}
			// Terminal control sequences: Ctrl+C (no selection), Ctrl+D, Ctrl+Z, Ctrl+L, etc.
			if (
				!event.altKey &&
				event.key.length === 1 &&
				/[a-zA-Z]/.test(event.key)
			) {
				return undefined;
			}
			// Other Ctrl combos (Ctrl+Tab, Ctrl+numbers, etc.): bubble to VS Code
			return false;
		}
	}

	// Default terminal processing for everything else
	return undefined;
}
