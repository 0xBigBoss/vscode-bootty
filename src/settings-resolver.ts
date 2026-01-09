import type { DisplaySettings } from "./types/messages";

/**
 * Configuration getter interface for testing
 * Allows mocking of vscode.workspace.getConfiguration()
 */
export interface ConfigGetter {
	get<T>(section: string, key: string): T | undefined;
}

/**
 * Resolve display settings with priority chain: bootty.* > editor.* > defaults
 * Extracted for testability
 */
export function resolveDisplaySettings(config: ConfigGetter): DisplaySettings {
	const fontFamily =
		config.get<string>("bootty", "fontFamily") ||
		config.get<string>("editor", "fontFamily") ||
		"monospace";

	const fontSize =
		config.get<number>("bootty", "fontSize") ||
		config.get<number>("editor", "fontSize") ||
		15;

	return { fontFamily, fontSize };
}

/**
 * Create a ConfigGetter from VS Code workspace configuration
 * This adapter allows the same resolution logic to be used in both
 * production (with real VS Code API) and tests (with mocks)
 */
export function createVSCodeConfigGetter(
	getConfiguration: (section: string) => { get<T>(key: string): T | undefined },
): ConfigGetter {
	return {
		get<T>(section: string, key: string): T | undefined {
			return getConfiguration(section).get<T>(key);
		},
	};
}
