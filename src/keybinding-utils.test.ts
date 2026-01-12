import { describe, expect, it } from "vitest";
import {
	getKeyHandlerResult,
	isDeleteLineShortcut,
	isMacPlatform,
	isSearchShortcut,
	type KeyEvent,
} from "./keybinding-utils";

describe("keybinding-utils", () => {
	describe("isMacPlatform", () => {
		it("returns true for MacIntel", () => {
			expect(isMacPlatform({ platform: "MacIntel" })).toBe(true);
		});

		it("returns true for MacPPC", () => {
			expect(isMacPlatform({ platform: "MacPPC" })).toBe(true);
		});

		it("returns true for Mac68K", () => {
			expect(isMacPlatform({ platform: "Mac68K" })).toBe(true);
		});

		it("returns false for Windows", () => {
			expect(isMacPlatform({ platform: "Win32" })).toBe(false);
		});

		it("returns false for Linux", () => {
			expect(isMacPlatform({ platform: "Linux x86_64" })).toBe(false);
		});
	});

	describe("isSearchShortcut", () => {
		it("detects Cmd+F on Mac", () => {
			const event: KeyEvent = {
				key: "f",
				metaKey: true,
				ctrlKey: false,
				shiftKey: false,
				altKey: false,
			};
			expect(isSearchShortcut(event, true)).toBe(true);
		});

		it("ignores Ctrl+F on Mac", () => {
			const event: KeyEvent = {
				key: "f",
				metaKey: false,
				ctrlKey: true,
				shiftKey: false,
				altKey: false,
			};
			expect(isSearchShortcut(event, true)).toBe(false);
		});

		it("detects Ctrl+F on Windows/Linux", () => {
			const event: KeyEvent = {
				key: "f",
				metaKey: false,
				ctrlKey: true,
				shiftKey: false,
				altKey: false,
			};
			expect(isSearchShortcut(event, false)).toBe(true);
		});

		it("ignores Cmd+F on Windows/Linux", () => {
			const event: KeyEvent = {
				key: "f",
				metaKey: true,
				ctrlKey: false,
				shiftKey: false,
				altKey: false,
			};
			expect(isSearchShortcut(event, false)).toBe(false);
		});

		it("ignores other Cmd/Ctrl combinations", () => {
			const cmdP: KeyEvent = {
				key: "p",
				metaKey: true,
				ctrlKey: false,
				shiftKey: false,
				altKey: false,
			};
			expect(isSearchShortcut(cmdP, true)).toBe(false);

			const ctrlP: KeyEvent = {
				key: "p",
				metaKey: false,
				ctrlKey: true,
				shiftKey: false,
				altKey: false,
			};
			expect(isSearchShortcut(ctrlP, false)).toBe(false);
		});
	});

	describe("isDeleteLineShortcut", () => {
		it("detects Cmd+Backspace on Mac", () => {
			const event: KeyEvent = {
				key: "Backspace",
				metaKey: true,
				ctrlKey: false,
				shiftKey: false,
				altKey: false,
			};
			expect(isDeleteLineShortcut(event, true)).toBe(true);
		});

		it("ignores Ctrl+Backspace on Mac", () => {
			const event: KeyEvent = {
				key: "Backspace",
				metaKey: false,
				ctrlKey: true,
				shiftKey: false,
				altKey: false,
			};
			expect(isDeleteLineShortcut(event, true)).toBe(false);
		});

		it("ignores Cmd+Shift+Backspace on Mac", () => {
			const event: KeyEvent = {
				key: "Backspace",
				metaKey: true,
				ctrlKey: false,
				shiftKey: true,
				altKey: false,
			};
			expect(isDeleteLineShortcut(event, true)).toBe(false);
		});

		it("ignores Cmd+Option+Backspace on Mac", () => {
			const event: KeyEvent = {
				key: "Backspace",
				metaKey: true,
				ctrlKey: false,
				shiftKey: false,
				altKey: true,
			};
			expect(isDeleteLineShortcut(event, true)).toBe(false);
		});

		it("returns false on Windows/Linux (use Ctrl+U directly)", () => {
			const cmdBackspace: KeyEvent = {
				key: "Backspace",
				metaKey: true,
				ctrlKey: false,
				shiftKey: false,
				altKey: false,
			};
			expect(isDeleteLineShortcut(cmdBackspace, false)).toBe(false);

			const ctrlBackspace: KeyEvent = {
				key: "Backspace",
				metaKey: false,
				ctrlKey: true,
				shiftKey: false,
				altKey: false,
			};
			expect(isDeleteLineShortcut(ctrlBackspace, false)).toBe(false);
		});

		it("ignores plain Backspace", () => {
			const event: KeyEvent = {
				key: "Backspace",
				metaKey: false,
				ctrlKey: false,
				shiftKey: false,
				altKey: false,
			};
			expect(isDeleteLineShortcut(event, true)).toBe(false);
			expect(isDeleteLineShortcut(event, false)).toBe(false);
		});
	});

	describe("getKeyHandlerResult - Mac", () => {
		const isMac = true;

		it("bubbles Cmd combos to VS Code", () => {
			const cmdP: KeyEvent = {
				key: "p",
				metaKey: true,
				ctrlKey: false,
				shiftKey: false,
				altKey: false,
			};
			expect(getKeyHandlerResult(cmdP, isMac, false)).toBe(false);

			const cmdShiftP: KeyEvent = {
				key: "P",
				metaKey: true,
				ctrlKey: false,
				shiftKey: true,
				altKey: false,
			};
			expect(getKeyHandlerResult(cmdShiftP, isMac, false)).toBe(false);
		});

		it("sends Ctrl+letter to terminal as control sequences", () => {
			const ctrlC: KeyEvent = {
				key: "c",
				metaKey: false,
				ctrlKey: true,
				shiftKey: false,
				altKey: false,
			};
			expect(getKeyHandlerResult(ctrlC, isMac, false)).toBe(undefined);

			const ctrlD: KeyEvent = {
				key: "d",
				metaKey: false,
				ctrlKey: true,
				shiftKey: false,
				altKey: false,
			};
			expect(getKeyHandlerResult(ctrlD, isMac, false)).toBe(undefined);

			const ctrlZ: KeyEvent = {
				key: "z",
				metaKey: false,
				ctrlKey: true,
				shiftKey: false,
				altKey: false,
			};
			expect(getKeyHandlerResult(ctrlZ, isMac, false)).toBe(undefined);
		});

		it("ignores Ctrl+letter when Alt is held", () => {
			const ctrlAltC: KeyEvent = {
				key: "c",
				metaKey: false,
				ctrlKey: true,
				shiftKey: false,
				altKey: true,
			};
			expect(getKeyHandlerResult(ctrlAltC, isMac, false)).toBe(undefined);
		});

		it("bubbles Ctrl+Shift combos to VS Code", () => {
			const ctrlShiftBacktick: KeyEvent = {
				key: "`",
				metaKey: false,
				ctrlKey: true,
				shiftKey: true,
				altKey: false,
			};
			expect(getKeyHandlerResult(ctrlShiftBacktick, isMac, false)).toBe(false);

			const ctrlShiftP: KeyEvent = {
				key: "P",
				metaKey: false,
				ctrlKey: true,
				shiftKey: true,
				altKey: false,
			};
			expect(getKeyHandlerResult(ctrlShiftP, isMac, false)).toBe(false);
		});

		it("handles regular keys with default processing", () => {
			const regularA: KeyEvent = {
				key: "a",
				metaKey: false,
				ctrlKey: false,
				shiftKey: false,
				altKey: false,
			};
			expect(getKeyHandlerResult(regularA, isMac, false)).toBe(undefined);

			const enter: KeyEvent = {
				key: "Enter",
				metaKey: false,
				ctrlKey: false,
				shiftKey: false,
				altKey: false,
			};
			expect(getKeyHandlerResult(enter, isMac, false)).toBe(undefined);
		});
	});

	describe("getKeyHandlerResult - Windows/Linux", () => {
		const isMac = false;

		it("bubbles Ctrl+Shift combos to VS Code", () => {
			const ctrlShiftP: KeyEvent = {
				key: "P",
				metaKey: false,
				ctrlKey: true,
				shiftKey: true,
				altKey: false,
			};
			expect(getKeyHandlerResult(ctrlShiftP, isMac, false)).toBe(false);

			const ctrlShiftF: KeyEvent = {
				key: "F",
				metaKey: false,
				ctrlKey: true,
				shiftKey: true,
				altKey: false,
			};
			expect(getKeyHandlerResult(ctrlShiftF, isMac, false)).toBe(false);
		});

		it("bubbles Ctrl+C with selection for copy", () => {
			const ctrlCWithSelection: KeyEvent = {
				key: "c",
				metaKey: false,
				ctrlKey: true,
				shiftKey: false,
				altKey: false,
			};
			expect(getKeyHandlerResult(ctrlCWithSelection, isMac, true)).toBe(false);
		});

		it("sends Ctrl+C without selection to terminal", () => {
			const ctrlCNoSelection: KeyEvent = {
				key: "c",
				metaKey: false,
				ctrlKey: true,
				shiftKey: false,
				altKey: false,
			};
			expect(getKeyHandlerResult(ctrlCNoSelection, isMac, false)).toBe(
				undefined,
			);
		});

		it("sends Ctrl+letter to terminal as control sequences", () => {
			const ctrlD: KeyEvent = {
				key: "d",
				metaKey: false,
				ctrlKey: true,
				shiftKey: false,
				altKey: false,
			};
			expect(getKeyHandlerResult(ctrlD, isMac, false)).toBe(undefined);

			const ctrlL: KeyEvent = {
				key: "l",
				metaKey: false,
				ctrlKey: true,
				shiftKey: false,
				altKey: false,
			};
			expect(getKeyHandlerResult(ctrlL, isMac, false)).toBe(undefined);
		});

		it("bubbles other Ctrl combos to VS Code", () => {
			const ctrlTab: KeyEvent = {
				key: "Tab",
				metaKey: false,
				ctrlKey: true,
				shiftKey: false,
				altKey: false,
			};
			expect(getKeyHandlerResult(ctrlTab, isMac, false)).toBe(false);

			const ctrl1: KeyEvent = {
				key: "1",
				metaKey: false,
				ctrlKey: true,
				shiftKey: false,
				altKey: false,
			};
			expect(getKeyHandlerResult(ctrl1, isMac, false)).toBe(false);
		});

		it("handles regular keys with default processing", () => {
			const regularA: KeyEvent = {
				key: "a",
				metaKey: false,
				ctrlKey: false,
				shiftKey: false,
				altKey: false,
			};
			expect(getKeyHandlerResult(regularA, isMac, false)).toBe(undefined);
		});
	});
});
