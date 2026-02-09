import { randomUUID } from "node:crypto";
import type { TerminalConfig, TerminalId } from "./types/terminal";

/** Generate a new unique terminal ID (Node-only, never import in webview) */
export function createTerminalId(): TerminalId {
	return randomUUID() as TerminalId;
}

/** Default terminal configuration */
export const DEFAULT_CONFIG: TerminalConfig = {
	shell: undefined, // Use platform default (detected at spawn)
	shellArgs: [], // Default to no arguments
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
const READY_TIMEOUT_OVERRIDE = Number.parseInt(
	process.env.BOOTTY_READY_TIMEOUT_MS ?? "",
	10,
);
export const READY_TIMEOUT_MS =
	Number.isFinite(READY_TIMEOUT_OVERRIDE) && READY_TIMEOUT_OVERRIDE > 0
		? READY_TIMEOUT_OVERRIDE
		: 10000; // 10s timeout for terminal-ready
export const EXIT_CLOSE_DELAY_MS = 1500; // Delay before closing panel after PTY exit

type BenchmarkMode = "pty" | "direct" | "command";

type BenchmarkScenario =
	| "ptySmall"
	| "ptyStress"
	| "directSmall"
	| "directStress"
	| "ptySuite";

interface BenchmarkScenarioConfig {
	mode: BenchmarkMode;
	lineCount: number;
	label: string;
	directLinesPerWrite?: number;
	directWritesPerFrame?: number;
	commandRelative?: string;
	outputPrefix?: string;
}

export const BENCHMARK_SCENARIOS: Record<
	BenchmarkScenario,
	BenchmarkScenarioConfig
> = {
	ptySmall: { mode: "pty", lineCount: 320, label: "bench-small" },
	ptyStress: { mode: "pty", lineCount: 2400, label: "bench-stress" },
	directSmall: {
		mode: "direct",
		lineCount: 320,
		label: "bench-direct-small",
		directLinesPerWrite: 80,
		directWritesPerFrame: 50,
	},
	directStress: {
		mode: "direct",
		lineCount: 2400,
		label: "bench-direct-stress",
		directLinesPerWrite: 100,
		directWritesPerFrame: 50,
	},
	ptySuite: {
		mode: "command",
		lineCount: 0,
		label: "bench-suite",
		commandRelative: "benchmarks/run.sh",
		outputPrefix: "Results saved to:",
	},
};

export const BENCHMARK_READY_TIMEOUT_MS = 15000;
export const BENCHMARK_SENTINEL_TIMEOUT_MS = 60000;
export const BENCHMARK_COOLDOWN_MS = 300;
export const BENCHMARK_CONFIG_APPLY_DELAY_MS = 100;
