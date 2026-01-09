import { describe, expect, it } from "vitest";
import { type ConfigGetter, resolveDisplaySettings } from "./settings-resolver";

/**
 * Mock config getter for testing
 */
function createMockConfig(
	values: Record<string, Record<string, unknown>>,
): ConfigGetter {
	return {
		get<T>(section: string, key: string): T | undefined {
			return values[section]?.[key] as T | undefined;
		},
	};
}

describe("resolveDisplaySettings", () => {
	describe("fontFamily priority", () => {
		it("uses bootty.fontFamily when set", () => {
			const config = createMockConfig({
				bootty: { fontFamily: "JetBrains Mono" },
				editor: { fontFamily: "Consolas" },
			});

			const settings = resolveDisplaySettings(config);
			expect(settings.fontFamily).toBe("JetBrains Mono");
		});

		it("falls back to editor.fontFamily when bootty not set", () => {
			const config = createMockConfig({
				bootty: {},
				editor: { fontFamily: "Consolas" },
			});

			const settings = resolveDisplaySettings(config);
			expect(settings.fontFamily).toBe("Consolas");
		});

		it("falls back to monospace when neither set", () => {
			const config = createMockConfig({
				bootty: {},
				editor: {},
			});

			const settings = resolveDisplaySettings(config);
			expect(settings.fontFamily).toBe("monospace");
		});

		it("uses bootty even when editor is set", () => {
			const config = createMockConfig({
				bootty: { fontFamily: "Fira Code" },
				editor: { fontFamily: "Courier New" },
			});

			const settings = resolveDisplaySettings(config);
			expect(settings.fontFamily).toBe("Fira Code");
		});
	});

	describe("fontSize priority", () => {
		it("uses bootty.fontSize when set", () => {
			const config = createMockConfig({
				bootty: { fontSize: 16 },
				editor: { fontSize: 14 },
			});

			const settings = resolveDisplaySettings(config);
			expect(settings.fontSize).toBe(16);
		});

		it("falls back to editor.fontSize when bootty not set", () => {
			const config = createMockConfig({
				bootty: {},
				editor: { fontSize: 14 },
			});

			const settings = resolveDisplaySettings(config);
			expect(settings.fontSize).toBe(14);
		});

		it("falls back to 15 when neither set", () => {
			const config = createMockConfig({
				bootty: {},
				editor: {},
			});

			const settings = resolveDisplaySettings(config);
			expect(settings.fontSize).toBe(15);
		});

		it("treats 0 as unset (falsy)", () => {
			const config = createMockConfig({
				bootty: { fontSize: 0 },
				editor: { fontSize: 12 },
			});

			const settings = resolveDisplaySettings(config);
			expect(settings.fontSize).toBe(12);
		});
	});

	describe("combined settings", () => {
		it("resolves font family and size independently", () => {
			const config = createMockConfig({
				bootty: { fontSize: 18 }, // Only size from bootty
				editor: { fontFamily: "Monaco", fontSize: 12 }, // Family from editor
			});

			const settings = resolveDisplaySettings(config);
			expect(settings.fontFamily).toBe("Monaco");
			expect(settings.fontSize).toBe(18);
		});
	});
});
