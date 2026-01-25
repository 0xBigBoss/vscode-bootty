import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { BooTTYPanelViewProvider } from "./panel-view-provider";
import { ProfileWriter } from "./profile-writer";
import { PtyService } from "./pty-service";
import {
	createVSCodeConfigGetter,
	resolveDisplaySettings,
} from "./settings-resolver";
import {
	BENCHMARK_CONFIG_APPLY_DELAY_MS,
	BENCHMARK_COOLDOWN_MS,
	BENCHMARK_READY_TIMEOUT_MS,
	BENCHMARK_SCENARIOS,
	BENCHMARK_SENTINEL_TIMEOUT_MS,
	createTerminalId,
	EXIT_CLOSE_DELAY_MS,
	MAX_DATA_QUEUE_SIZE,
	READY_TIMEOUT_MS,
	resolveConfig,
} from "./terminal-utils";
import type {
	ExtensionMessage,
	PanelWebviewMessage,
	ProfileEvent,
	RendererMode,
	RuntimeConfig,
	TerminalGroup,
	TerminalTheme,
	TestKeyEvent,
	TestSampleTrailingCellsResult,
	TestSearchAction,
	TestSearchState,
	WebviewMessage,
} from "./types/messages";
import type {
	EditorTerminalInstance,
	PanelTerminalInstance,
	TerminalConfig,
	TerminalId,
	TerminalInstance,
	TerminalLocation,
} from "./types/terminal";
import { createWebviewPanel } from "./webview-provider";

/** Get display settings using the shared resolver (tested in settings-resolver.test.ts) */
function getDisplaySettings() {
	const configGetter = createVSCodeConfigGetter((section) =>
		vscode.workspace.getConfiguration(section),
	);
	return resolveDisplaySettings(configGetter);
}

/** Get terminal theme colors from workbench.colorCustomizations with theme-scoped override support */
function resolveTerminalTheme(): TerminalTheme {
	const workbenchConfig = vscode.workspace.getConfiguration("workbench");
	const colorCustomizations =
		workbenchConfig.get<Record<string, unknown>>("colorCustomizations") ?? {};

	// Get current theme name for theme-scoped overrides (e.g., "[Monokai]": {...})
	// Read from workbench.colorTheme setting since activeColorTheme.label is not in public API
	const currentThemeName = workbenchConfig.get<string>("colorTheme");

	// Start with global color customizations (top-level keys without brackets)
	const mergedColors: Record<string, string> = {};
	for (const [key, value] of Object.entries(colorCustomizations)) {
		if (typeof value === "string" && !key.startsWith("[")) {
			mergedColors[key] = value;
		}
	}

	// Apply theme-scoped overrides if current theme matches
	if (currentThemeName) {
		const themeScopedKey = `[${currentThemeName}]`;
		const themeScopedColors = colorCustomizations[themeScopedKey];
		if (themeScopedColors && typeof themeScopedColors === "object") {
			for (const [key, value] of Object.entries(
				themeScopedColors as Record<string, unknown>,
			)) {
				if (typeof value === "string") {
					mergedColors[key] = value;
				} else if (value === null) {
					// null means "unset this color" - remove global override for this theme
					delete mergedColors[key];
				}
			}
		}
	}

	return {
		foreground: mergedColors["terminal.foreground"],
		background: mergedColors["terminal.background"],
		cursor: mergedColors["terminal.cursor.foreground"],
		cursorAccent: mergedColors["terminal.cursor.background"],
		selectionBackground: mergedColors["terminal.selectionBackground"],
		selectionForeground: mergedColors["terminal.selectionForeground"],
		black: mergedColors["terminal.ansiBlack"],
		red: mergedColors["terminal.ansiRed"],
		green: mergedColors["terminal.ansiGreen"],
		yellow: mergedColors["terminal.ansiYellow"],
		blue: mergedColors["terminal.ansiBlue"],
		magenta: mergedColors["terminal.ansiMagenta"],
		cyan: mergedColors["terminal.ansiCyan"],
		white: mergedColors["terminal.ansiWhite"],
		brightBlack: mergedColors["terminal.ansiBrightBlack"],
		brightRed: mergedColors["terminal.ansiBrightRed"],
		brightGreen: mergedColors["terminal.ansiBrightGreen"],
		brightYellow: mergedColors["terminal.ansiBrightYellow"],
		brightBlue: mergedColors["terminal.ansiBrightBlue"],
		brightMagenta: mergedColors["terminal.ansiBrightMagenta"],
		brightCyan: mergedColors["terminal.ansiBrightCyan"],
		brightWhite: mergedColors["terminal.ansiBrightWhite"],
	};
}

/** Get the first workspace folder path, or undefined if none open */
function getWorkspaceCwd(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Persisted terminal state for a single terminal */
interface PersistedTerminalState {
	id: TerminalId;
	index?: number; // Terminal number for "Terminal N" naming
	userTitle?: string;
	icon?: string;
	colorKey?: string; // Stored key (e.g., "red") - resolved to hex on load
	color?: string; // Legacy: direct hex value (for backward compat)
	groupId?: string;
	orderIndex: number;
}

interface ProfileSession {
	sessionId: string;
	startedAt: number;
	outputPaths: string[];
	writers: ProfileWriter[];
}

interface ProfilingStatus {
	active: boolean;
	sessionId?: string;
	outputPaths?: string[];
}

type BenchmarkLocation = TerminalLocation;
type BenchmarkRenderer = "auto" | "webgl" | "canvas";
type BenchmarkScenario = keyof typeof BENCHMARK_SCENARIOS;

interface BenchmarkOptions {
	scenario?: BenchmarkScenario;
	lineCount?: number;
	location?: BenchmarkLocation;
	renderer?: BenchmarkRenderer;
	command?: string;
	directLinesPerWrite?: number;
	directWritesPerFrame?: number;
	ptyMaxLinesPerFrame?: number;
	ptyMaxFrameMs?: number;
	ptyMaxBytesPerFrame?: number;
	ptyAdaptiveDrain?: boolean;
	ptyAdaptiveFrameMs?: number;
	ptyAdaptiveQueueThreshold?: number;
	ptyAdaptiveMaxLinesPerFrame?: number;
	ptyAdaptiveMaxLinesPerFrameWebgl?: number;
	ptyAdaptiveAutoTune?: boolean;
	ptyAdaptiveMinBytesPerFrame?: number;
	ptyAdaptiveQueueBytesThreshold?: number;
	ptyAdaptiveQueueHysteresisRatio?: number;
	profile?: boolean;
	timeoutMs?: number;
}

interface BenchmarkResult {
	terminalId: TerminalId;
	scenario: BenchmarkScenario;
	renderer: BenchmarkRenderer;
	location: BenchmarkLocation;
	lineCount: number;
	startedAt: number;
	finishedAt: number;
	durationMs: number;
	outputPath?: string;
	profile?: {
		sessionId?: string;
		outputPaths?: string[];
	};
}

interface BenchmarkWatcher {
	prefix: string;
	prefixBytes: Uint8Array;
	sentinel: string;
	sentinelBytes: Uint8Array;
	targetLines: number;
	seenLines: number;
	resolve: () => void;
	reject: (error: Error) => void;
	timeoutId: NodeJS.Timeout;
	tail: string;
	tailBytes: Uint8Array;
}

interface BenchmarkCommandWatcher {
	prefix: string;
	prefixBytes: Uint8Array;
	resolve: (outputPath: string) => void;
	reject: (error: Error) => void;
	timeoutId: NodeJS.Timeout;
	tail: string;
	tailBytes: Uint8Array;
}

interface BenchmarkDrainWatcher {
	token: string;
	resolve: () => void;
	reject: (error: Error) => void;
	timeoutId: NodeJS.Timeout;
}

interface BenchmarkDirectWriteWatcher {
	token: string;
	resolve: () => void;
	reject: (error: Error) => void;
	timeoutId: NodeJS.Timeout;
}

interface ConfigApplyWatcher {
	token: string;
	resolve: () => void;
	reject: (error: Error) => void;
	timeoutId: NodeJS.Timeout;
}

interface HandshakeOptions {
	terminalId?: TerminalId;
	timeoutMs?: number;
	panelTimeoutMs?: number;
}

interface HandshakeResult {
	panelReady: boolean;
	terminalId: TerminalId;
	location: TerminalLocation;
	terminalReady: boolean;
}

interface TestFindTextOptions {
	terminalId?: TerminalId;
	text?: string;
	limit?: number;
	timeoutMs?: number;
}

interface TestFindTextWatcher {
	resolve: (found: boolean) => void;
	reject: (error: Error) => void;
	timeoutId: NodeJS.Timeout;
}

interface TestFileLinksOptions {
	terminalId?: TerminalId;
	text?: string;
	limit?: number;
	timeoutMs?: number;
}

interface TestFileLinksWatcher {
	resolve: (matches: number) => void;
	reject: (error: Error) => void;
	timeoutId: NodeJS.Timeout;
}

interface TestSearchOptions {
	terminalId?: TerminalId;
	action?: TestSearchAction;
	query?: string;
	timeoutMs?: number;
}

interface TestSearchWatcher {
	resolve: (state: TestSearchState) => void;
	reject: (error: Error) => void;
	timeoutId: NodeJS.Timeout;
}

interface TestSampleTrailingCellsOptions {
	terminalId?: TerminalId;
	count?: number;
	timeoutMs?: number;
}

interface TestSampleTrailingCellsWatcher {
	resolve: (result: TestSampleTrailingCellsResult) => void;
	reject: (error: Error) => void;
	timeoutId: NodeJS.Timeout;
}

interface TestDirectWriteOptions {
	terminalId?: TerminalId;
	payload?: string;
	timeoutMs?: number;
}

interface TestDirectWriteWatcher {
	resolve: () => void;
	reject: (error: Error) => void;
	timeoutId: NodeJS.Timeout;
}

interface TestSendInputOptions {
	terminalId?: TerminalId;
	data?: string;
}

interface TestDispatchKeysOptions {
	terminalId?: TerminalId;
	keys?: TestKeyEvent[];
}

interface TestActivateTerminalOptions {
	terminalId?: TerminalId;
}

/** Persisted workspace state */
interface PersistedWorkspaceState {
	terminals: PersistedTerminalState[];
	groups: TerminalGroup[];
	activeTerminalId?: TerminalId;
	listWidth: number;
}

/** Storage keys for workspaceState */
const STATE_KEY = "bootty.terminalState";
const PROFILE_OUTPUT_SUBDIR = "bootty-profiles";
const PROFILE_FILE_PREFIX = "bootty-profile";
const PROFILE_FILE_EXTENSION = ".jsonl";
const PROFILE_STOP_GRACE_MS = 300;

export class TerminalManager implements vscode.Disposable {
	private terminals = new Map<TerminalId, TerminalInstance>();
	private groups = new Map<string, TerminalGroup>(); // Split groups
	private terminalToGroup = new Map<TerminalId, string>(); // Reverse lookup
	private terminalOrder: TerminalId[] = []; // Ordered list of terminal IDs
	private activeTerminalId: TerminalId | null = null; // Currently selected terminal
	private listWidth = 180; // Persisted list width
	private rendererInfo = new Map<
		TerminalId,
		{
			type: "webgl" | "canvas";
			status: "active" | "degraded";
			fallback: boolean;
			reason?: string;
		}
	>(); // Renderer status per terminal
	private persistedTerminals: PersistedTerminalState[] = []; // Terminals to restore on hydration
	private ptyService: PtyService;
	private context: vscode.ExtensionContext;
	private panelProvider: BooTTYPanelViewProvider;
	private usedIndices = new Set<number>(); // Track used indices for reuse
	private outputChannel: vscode.OutputChannel;
	private profileSession?: ProfileSession;
	private benchmarkWatchers = new Map<TerminalId, BenchmarkWatcher>();
	private benchmarkCommandWatchers = new Map<
		TerminalId,
		BenchmarkCommandWatcher
	>();
	private benchmarkDrainWatchers = new Map<TerminalId, BenchmarkDrainWatcher>();
	private benchmarkDirectWriteWatchers = new Map<
		TerminalId,
		BenchmarkDirectWriteWatcher
	>();
	private runtimeConfigOverride?: Partial<RuntimeConfig>;
	private configApplyWatchers = new Map<string, ConfigApplyWatcher>();
	private testFindTextWatchers = new Map<string, TestFindTextWatcher>();
	private testFileLinksWatchers = new Map<string, TestFileLinksWatcher>();
	private testSearchWatchers = new Map<string, TestSearchWatcher>();
	private testSampleTrailingCellsWatchers = new Map<
		string,
		TestSampleTrailingCellsWatcher
	>();
	private testDirectWriteWatchers = new Map<string, TestDirectWriteWatcher>();
	private readonly ptyDecoder = new TextDecoder("utf-8");
	private ptyOutputBatchConfig: {
		maxBytes: number;
		maxDelayMs: number;
	};
	// PTY capture for debugging - toggle via bootty.togglePtyCapture command
	private ptyCaptureEnabled = false;
	private ptyCaptureStream?: fs.WriteStream;
	private ptyCapturePath?: string;
	private ptyCaptureStartTime?: number;

	constructor(
		context: vscode.ExtensionContext,
		panelProvider: BooTTYPanelViewProvider,
	) {
		this.context = context;
		this.panelProvider = panelProvider;
		this.ptyService = new PtyService();
		this.outputChannel = vscode.window.createOutputChannel("BooTTY");
		this.ptyOutputBatchConfig = this.resolvePtyOutputBatchConfig();

		// Restore persisted state
		this.loadPersistedState();

		// Listen for configuration changes (font settings hot reload)
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (
					e.affectsConfiguration("bootty") ||
					e.affectsConfiguration("editor.fontFamily") ||
					e.affectsConfiguration("editor.fontSize")
				) {
					this.ptyOutputBatchConfig = this.resolvePtyOutputBatchConfig();
					this.broadcastSettingsUpdate();
				}
				// Theme colors from workbench.colorCustomizations
				if (e.affectsConfiguration("workbench.colorCustomizations")) {
					this.broadcastThemeUpdate();
				}
			}),
		);

		// Listen for color theme changes (user switches dark/light theme)
		context.subscriptions.push(
			vscode.window.onDidChangeActiveColorTheme(() => {
				this.broadcastThemeUpdate();
			}),
		);
	}

	/** Get the next available terminal index (reuses freed indices) */
	private getNextIndex(): number {
		let index = 1;
		while (this.usedIndices.has(index)) {
			index++;
		}
		this.usedIndices.add(index);
		return index;
	}

	/** Release a terminal index for reuse */
	private releaseIndex(index: number | undefined): void {
		if (index !== undefined) {
			this.usedIndices.delete(index);
		}
	}

	/** Type-safe message posting using discriminated union */
	private postToTerminal(id: TerminalId, message: ExtensionMessage): void {
		const instance = this.terminals.get(id);
		if (!instance || !instance.ready) return;

		if (instance.location === "editor") {
			// TypeScript knows instance.panel exists here
			instance.panel.webview.postMessage(message);
		} else {
			// instance.location === 'panel' - use panel provider
			this.panelProvider.postMessage(message);
		}
	}

	/** Show search in the active editor terminal (if any) */
	showSearchInActiveEditor(): boolean {
		for (const instance of this.terminals.values()) {
			if (instance.location === "editor" && instance.panel.active) {
				instance.panel.webview.postMessage({ type: "show-search" });
				return true;
			}
		}
		return false;
	}

	private buildBenchmarkCommand(
		scenario: BenchmarkScenario,
		lineCount: number,
		sentinel: string,
	): string {
		const label = BENCHMARK_SCENARIOS[scenario].label;
		return [
			"i=1;",
			`while [ $i -le ${lineCount} ]; do`,
			`printf '${label}-%05d\\n' "$i";`,
			"i=$((i+1));",
			"done;",
			`printf '%s\\n' '${sentinel}';`,
		].join(" ");
	}

	private buildBenchmarkPayload(label: string, lineCount: number): string {
		const lines: string[] = [];
		for (let i = 1; i <= lineCount; i += 1) {
			lines.push(`${label}-${String(i).padStart(5, "0")}`);
		}
		return `${lines.join("\n")}\n`;
	}

	private parseHandshakeOptions(input: unknown): HandshakeOptions {
		if (!input || typeof input !== "object") {
			return {};
		}
		const raw = input as Record<string, unknown>;
		const terminalId =
			typeof raw.terminalId === "string"
				? (raw.terminalId as TerminalId)
				: undefined;
		const timeoutMs =
			typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs)
				? raw.timeoutMs
				: undefined;
		const panelTimeoutMs =
			typeof raw.panelTimeoutMs === "number" &&
			Number.isFinite(raw.panelTimeoutMs)
				? raw.panelTimeoutMs
				: undefined;
		return { terminalId, timeoutMs, panelTimeoutMs };
	}

	private resolveHandshakeTimeout(
		value: number | undefined,
		fallback: number,
	): number {
		if (typeof value === "number" && Number.isFinite(value)) {
			return Math.max(0, value);
		}
		return fallback;
	}

	private resolveExistingTerminalId(
		targetId: TerminalId | undefined,
	): TerminalId {
		if (targetId) {
			if (this.terminals.has(targetId)) {
				return targetId;
			}
			throw new Error(`Terminal ${targetId} does not exist.`);
		}
		if (this.activeTerminalId) {
			return this.activeTerminalId;
		}
		const panelIds = this.getTerminalIds();
		if (panelIds.length > 0) {
			return panelIds[0];
		}
		const first = this.terminals.keys().next().value as TerminalId | undefined;
		if (first) {
			return first;
		}
		throw new Error("No terminals available to wait for readiness.");
	}

	private parseTestFindTextOptions(input: unknown): TestFindTextOptions {
		if (!input || typeof input !== "object") {
			return {};
		}
		const raw = input as Record<string, unknown>;
		const terminalId =
			typeof raw.terminalId === "string"
				? (raw.terminalId as TerminalId)
				: undefined;
		const text = typeof raw.text === "string" ? raw.text : undefined;
		const limit =
			typeof raw.limit === "number" && Number.isFinite(raw.limit)
				? raw.limit
				: undefined;
		const timeoutMs =
			typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs)
				? raw.timeoutMs
				: undefined;
		return { terminalId, text, limit, timeoutMs };
	}

	private parseTestSearchOptions(input: unknown): TestSearchOptions {
		if (!input || typeof input !== "object") {
			return {};
		}
		const raw = input as Record<string, unknown>;
		const terminalId =
			typeof raw.terminalId === "string"
				? (raw.terminalId as TerminalId)
				: undefined;
		const action = this.isTestSearchAction(raw.action) ? raw.action : undefined;
		const query = typeof raw.query === "string" ? raw.query : undefined;
		const timeoutMs =
			typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs)
				? raw.timeoutMs
				: undefined;
		return { terminalId, action, query, timeoutMs };
	}

	private parseTestSampleTrailingCellsOptions(
		input: unknown,
	): TestSampleTrailingCellsOptions {
		if (!input || typeof input !== "object") {
			return {};
		}
		const raw = input as Record<string, unknown>;
		const terminalId =
			typeof raw.terminalId === "string"
				? (raw.terminalId as TerminalId)
				: undefined;
		const count =
			typeof raw.count === "number" && Number.isFinite(raw.count)
				? Math.max(1, Math.floor(raw.count))
				: undefined;
		const timeoutMs =
			typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs)
				? raw.timeoutMs
				: undefined;
		return { terminalId, count, timeoutMs };
	}

	private parseTestDirectWriteOptions(input: unknown): TestDirectWriteOptions {
		if (!input || typeof input !== "object") {
			return {};
		}
		const raw = input as Record<string, unknown>;
		const terminalId =
			typeof raw.terminalId === "string"
				? (raw.terminalId as TerminalId)
				: undefined;
		const payload = typeof raw.payload === "string" ? raw.payload : undefined;
		const timeoutMs =
			typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs)
				? raw.timeoutMs
				: undefined;
		return { terminalId, payload, timeoutMs };
	}

	private parseTestFileLinksOptions(input: unknown): TestFileLinksOptions {
		if (!input || typeof input !== "object") {
			return {};
		}
		const raw = input as Record<string, unknown>;
		const terminalId =
			typeof raw.terminalId === "string"
				? (raw.terminalId as TerminalId)
				: undefined;
		const text = typeof raw.text === "string" ? raw.text : undefined;
		const limit =
			typeof raw.limit === "number" && Number.isFinite(raw.limit)
				? raw.limit
				: undefined;
		const timeoutMs =
			typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs)
				? raw.timeoutMs
				: undefined;
		return { terminalId, text, limit, timeoutMs };
	}

	private isTestSearchAction(value: unknown): value is TestSearchAction {
		return (
			value === "show" ||
			value === "hide" ||
			value === "setQuery" ||
			value === "status"
		);
	}

	private parseTestSendInputOptions(input: unknown): TestSendInputOptions {
		if (!input || typeof input !== "object") {
			return {};
		}
		const raw = input as Record<string, unknown>;
		const terminalId =
			typeof raw.terminalId === "string"
				? (raw.terminalId as TerminalId)
				: undefined;
		const data = typeof raw.data === "string" ? raw.data : undefined;
		return { terminalId, data };
	}

	private parseTestDispatchKeysOptions(
		input: unknown,
	): TestDispatchKeysOptions {
		if (!input || typeof input !== "object") {
			return {};
		}
		const raw = input as Record<string, unknown>;
		const terminalId =
			typeof raw.terminalId === "string"
				? (raw.terminalId as TerminalId)
				: undefined;
		const keys = Array.isArray(raw.keys)
			? (raw.keys as TestKeyEvent[])
			: undefined;
		return { terminalId, keys };
	}

	private parseTestActivateTerminalOptions(
		input: unknown,
	): TestActivateTerminalOptions {
		if (!input || typeof input !== "object") {
			return {};
		}
		const raw = input as Record<string, unknown>;
		const terminalId =
			typeof raw.terminalId === "string"
				? (raw.terminalId as TerminalId)
				: undefined;
		return { terminalId };
	}

	private requestTestFindText(
		terminalId: TerminalId,
		text: string,
		limit: number | undefined,
		timeoutMs: number,
	): Promise<boolean> {
		const instance = this.terminals.get(terminalId);
		if (!instance) {
			return Promise.reject(
				new Error(`Terminal ${terminalId} no longer exists.`),
			);
		}
		if (!instance.ready) {
			return Promise.reject(
				new Error(`Terminal ${terminalId} is not ready for test queries.`),
			);
		}
		const token = crypto.randomUUID();
		if (this.testFindTextWatchers.has(token)) {
			return Promise.reject(new Error("Test find-text token collision."));
		}
		return new Promise((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				this.testFindTextWatchers.delete(token);
				reject(new Error("Timed out waiting for test-find-text result."));
			}, timeoutMs);
			this.testFindTextWatchers.set(token, {
				resolve: (found) => {
					clearTimeout(timeoutId);
					resolve(found);
				},
				reject: (error) => {
					clearTimeout(timeoutId);
					reject(error);
				},
				timeoutId,
			});
			this.postToTerminal(terminalId, {
				type: "test-find-text",
				terminalId,
				token,
				text,
				limit,
			});
		});
	}

	private requestTestFileLinks(
		terminalId: TerminalId,
		text: string,
		limit: number | undefined,
		timeoutMs: number,
	): Promise<number> {
		const instance = this.terminals.get(terminalId);
		if (!instance) {
			return Promise.reject(
				new Error(`Terminal ${terminalId} no longer exists.`),
			);
		}
		if (!instance.ready) {
			return Promise.reject(
				new Error(`Terminal ${terminalId} is not ready for test queries.`),
			);
		}
		const token = crypto.randomUUID();
		if (this.testFileLinksWatchers.has(token)) {
			return Promise.reject(new Error("Test file-links token collision."));
		}
		return new Promise((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				this.testFileLinksWatchers.delete(token);
				reject(new Error("Timed out waiting for test-file-links result."));
			}, timeoutMs);
			this.testFileLinksWatchers.set(token, {
				resolve: (matches) => {
					clearTimeout(timeoutId);
					resolve(matches);
				},
				reject: (error) => {
					clearTimeout(timeoutId);
					reject(error);
				},
				timeoutId,
			});
			this.postToTerminal(terminalId, {
				type: "test-file-links",
				terminalId,
				token,
				text,
				limit,
			});
		});
	}

	private requestTestSearchState(
		terminalId: TerminalId,
		action: TestSearchAction,
		query: string | undefined,
		timeoutMs: number,
	): Promise<TestSearchState> {
		const instance = this.terminals.get(terminalId);
		if (!instance) {
			return Promise.reject(
				new Error(`Terminal ${terminalId} no longer exists.`),
			);
		}
		if (!instance.ready) {
			return Promise.reject(
				new Error(`Terminal ${terminalId} is not ready for test queries.`),
			);
		}
		const token = crypto.randomUUID();
		if (this.testSearchWatchers.has(token)) {
			return Promise.reject(new Error("Test search token collision."));
		}
		return new Promise((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				this.testSearchWatchers.delete(token);
				reject(new Error("Timed out waiting for test-search result."));
			}, timeoutMs);
			this.testSearchWatchers.set(token, {
				resolve: (state) => {
					clearTimeout(timeoutId);
					resolve(state);
				},
				reject: (error) => {
					clearTimeout(timeoutId);
					reject(error);
				},
				timeoutId,
			});
			this.postToTerminal(terminalId, {
				type: "test-search",
				terminalId,
				token,
				action,
				query,
			});
		});
	}

	private requestTestSampleTrailingCells(
		terminalId: TerminalId,
		count: number,
		timeoutMs: number,
	): Promise<TestSampleTrailingCellsResult> {
		const instance = this.terminals.get(terminalId);
		if (!instance) {
			return Promise.reject(
				new Error(`Terminal ${terminalId} no longer exists.`),
			);
		}
		if (!instance.ready) {
			return Promise.reject(
				new Error(`Terminal ${terminalId} is not ready for test queries.`),
			);
		}
		const token = crypto.randomUUID();
		if (this.testSampleTrailingCellsWatchers.has(token)) {
			return Promise.reject(
				new Error("Test sample-trailing-cells token collision."),
			);
		}
		return new Promise((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				this.testSampleTrailingCellsWatchers.delete(token);
				reject(
					new Error("Timed out waiting for test-sample-trailing-cells result."),
				);
			}, timeoutMs);
			this.testSampleTrailingCellsWatchers.set(token, {
				resolve: (result) => {
					clearTimeout(timeoutId);
					resolve(result);
				},
				reject: (error) => {
					clearTimeout(timeoutId);
					reject(error);
				},
				timeoutId,
			});
			this.postToTerminal(terminalId, {
				type: "test-sample-trailing-cells",
				terminalId,
				token,
				count,
			});
		});
	}

	private requestTestDirectWrite(
		terminalId: TerminalId,
		payload: string,
		timeoutMs: number,
	): Promise<void> {
		const instance = this.terminals.get(terminalId);
		if (!instance) {
			return Promise.reject(
				new Error(`Terminal ${terminalId} no longer exists.`),
			);
		}
		if (!instance.ready) {
			return Promise.reject(
				new Error(`Terminal ${terminalId} is not ready for test writes.`),
			);
		}
		const token = crypto.randomUUID();
		if (this.testDirectWriteWatchers.has(token)) {
			return Promise.reject(new Error("Test direct-write token collision."));
		}
		return new Promise((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				this.testDirectWriteWatchers.delete(token);
				reject(new Error("Timed out waiting for test-direct-write result."));
			}, timeoutMs);
			this.testDirectWriteWatchers.set(token, {
				resolve: () => {
					clearTimeout(timeoutId);
					resolve();
				},
				reject: (error) => {
					clearTimeout(timeoutId);
					reject(error);
				},
				timeoutId,
			});
			this.postToTerminal(terminalId, {
				type: "test-direct-write",
				terminalId,
				token,
				payload,
			});
		});
	}

	async waitForHandshake(options: unknown = {}): Promise<HandshakeResult> {
		const parsed = this.parseHandshakeOptions(options);
		const terminalTimeoutMs = this.resolveHandshakeTimeout(
			parsed.timeoutMs,
			READY_TIMEOUT_MS,
		);
		const panelTimeoutMs = this.resolveHandshakeTimeout(
			parsed.panelTimeoutMs,
			BENCHMARK_READY_TIMEOUT_MS,
		);
		const terminalId = this.resolveExistingTerminalId(parsed.terminalId);
		const instance = this.terminals.get(terminalId);
		if (!instance) {
			throw new Error(`Terminal ${terminalId} no longer exists.`);
		}
		let panelReady = this.panelProvider.isReady;
		if (instance.location === "panel") {
			await this.waitForPanelReady(panelTimeoutMs);
			panelReady = true;
		}
		await this.waitForTerminalReady(terminalId, terminalTimeoutMs);
		return {
			panelReady,
			terminalId,
			location: instance.location,
			terminalReady: true,
		};
	}

	async findText(options: unknown = {}): Promise<boolean> {
		const parsed = this.parseTestFindTextOptions(options);
		const text = parsed.text?.trim();
		if (!text) {
			throw new Error("Test find-text requires a non-empty text string.");
		}
		const terminalId = this.resolveExistingTerminalId(parsed.terminalId);
		const timeoutMs = this.resolveHandshakeTimeout(parsed.timeoutMs, 5000);
		const limit =
			typeof parsed.limit === "number" && Number.isFinite(parsed.limit)
				? Math.max(1, Math.floor(parsed.limit))
				: undefined;
		return await this.requestTestFindText(terminalId, text, limit, timeoutMs);
	}

	async findFileLinks(options: unknown = {}): Promise<number> {
		const parsed = this.parseTestFileLinksOptions(options);
		const text = parsed.text?.trim();
		if (!text) {
			throw new Error("Test file-links requires a non-empty text string.");
		}
		const terminalId = this.resolveExistingTerminalId(parsed.terminalId);
		const timeoutMs = this.resolveHandshakeTimeout(parsed.timeoutMs, 5000);
		const limit =
			typeof parsed.limit === "number" && Number.isFinite(parsed.limit)
				? Math.max(1, Math.floor(parsed.limit))
				: undefined;
		const instance = this.terminals.get(terminalId);
		if (!instance) {
			throw new Error(`Terminal ${terminalId} no longer exists.`);
		}
		if (instance.location === "panel") {
			const found = await this.findText({
				terminalId,
				text,
				limit,
				timeoutMs,
			});
			return found ? 1 : 0;
		}
		return await this.requestTestFileLinks(terminalId, text, limit, timeoutMs);
	}

	async testSearch(options: unknown = {}): Promise<TestSearchState> {
		const parsed = this.parseTestSearchOptions(options);
		const terminalId = this.resolveExistingTerminalId(parsed.terminalId);
		const timeoutMs = this.resolveHandshakeTimeout(parsed.timeoutMs, 5000);
		const action: TestSearchAction =
			parsed.action ?? (parsed.query ? "setQuery" : "status");
		return await this.requestTestSearchState(
			terminalId,
			action,
			parsed.query,
			timeoutMs,
		);
	}

	async sampleTrailingCells(
		options: unknown = {},
	): Promise<TestSampleTrailingCellsResult> {
		const parsed = this.parseTestSampleTrailingCellsOptions(options);
		const terminalId = this.resolveExistingTerminalId(parsed.terminalId);
		const timeoutMs = this.resolveHandshakeTimeout(parsed.timeoutMs, 3000);
		const count = parsed.count ?? 8;
		return await this.requestTestSampleTrailingCells(
			terminalId,
			count,
			timeoutMs,
		);
	}

	async directWriteTest(options: unknown = {}): Promise<void> {
		const parsed = this.parseTestDirectWriteOptions(options);
		if (!parsed.payload) {
			throw new Error("Test direct-write requires a payload string.");
		}
		const terminalId = this.resolveExistingTerminalId(parsed.terminalId);
		const timeoutMs = this.resolveHandshakeTimeout(parsed.timeoutMs, 3000);
		await this.requestTestDirectWrite(terminalId, parsed.payload, timeoutMs);
	}

	sendTestInput(options: unknown = {}): void {
		const parsed = this.parseTestSendInputOptions(options);
		if (!parsed.data) {
			throw new Error("Test input requires a data string.");
		}
		const terminalId = this.resolveExistingTerminalId(parsed.terminalId);
		this.handleTerminalInput(terminalId, parsed.data);
	}

	dispatchTestKeys(options: unknown = {}): void {
		const parsed = this.parseTestDispatchKeysOptions(options);
		if (!parsed.keys || parsed.keys.length === 0) {
			throw new Error("Test key dispatch requires a non-empty keys array.");
		}
		const terminalId = this.resolveExistingTerminalId(parsed.terminalId);
		const instance = this.terminals.get(terminalId);
		if (!instance) {
			throw new Error(`Terminal ${terminalId} no longer exists.`);
		}
		if (instance.location !== "panel") {
			throw new Error("Test key dispatch only supports panel terminals.");
		}
		this.postToTerminal(terminalId, {
			type: "test-dispatch-keys",
			terminalId,
			keys: parsed.keys,
		});
	}

	activatePanelTerminal(options: unknown = {}): void {
		const parsed = this.parseTestActivateTerminalOptions(options);
		const terminalId = this.resolveExistingTerminalId(parsed.terminalId);
		const instance = this.terminals.get(terminalId);
		if (!instance) {
			throw new Error(`Terminal ${terminalId} no longer exists.`);
		}
		if (instance.location !== "panel") {
			throw new Error("Activate terminal only supports panel terminals.");
		}
		this.panelProvider.activateTerminal(terminalId);
	}

	destroyTestTerminal(options: unknown = {}): void {
		const parsed = this.parseTestActivateTerminalOptions(options);
		const terminalId = this.resolveExistingTerminalId(parsed.terminalId);
		this.destroyTerminalById(terminalId);
	}

	private parseBenchmarkOptions(input: unknown): BenchmarkOptions {
		if (!input || typeof input !== "object") {
			return {};
		}
		const raw = input as Record<string, unknown>;
		const scenario =
			typeof raw.scenario === "string" &&
			Object.hasOwn(BENCHMARK_SCENARIOS, raw.scenario)
				? (raw.scenario as BenchmarkScenario)
				: undefined;
		const lineCount =
			typeof raw.lineCount === "number" && Number.isFinite(raw.lineCount)
				? raw.lineCount
				: undefined;
		const location =
			raw.location === "panel" || raw.location === "editor"
				? raw.location
				: undefined;
		const renderer =
			raw.renderer === "auto" ||
			raw.renderer === "webgl" ||
			raw.renderer === "canvas"
				? raw.renderer
				: undefined;
		const command = typeof raw.command === "string" ? raw.command : undefined;
		const ptyMaxLinesPerFrame =
			typeof raw.ptyMaxLinesPerFrame === "number" &&
			Number.isFinite(raw.ptyMaxLinesPerFrame)
				? raw.ptyMaxLinesPerFrame
				: undefined;
		const directLinesPerWrite =
			typeof raw.directLinesPerWrite === "number" &&
			Number.isFinite(raw.directLinesPerWrite)
				? raw.directLinesPerWrite
				: undefined;
		const directWritesPerFrame =
			typeof raw.directWritesPerFrame === "number" &&
			Number.isFinite(raw.directWritesPerFrame)
				? raw.directWritesPerFrame
				: undefined;
		const ptyMaxFrameMs =
			typeof raw.ptyMaxFrameMs === "number" &&
			Number.isFinite(raw.ptyMaxFrameMs)
				? raw.ptyMaxFrameMs
				: undefined;
		const ptyMaxBytesPerFrame =
			typeof raw.ptyMaxBytesPerFrame === "number" &&
			Number.isFinite(raw.ptyMaxBytesPerFrame)
				? raw.ptyMaxBytesPerFrame
				: undefined;
		const ptyAdaptiveDrain =
			typeof raw.ptyAdaptiveDrain === "boolean"
				? raw.ptyAdaptiveDrain
				: undefined;
		const ptyAdaptiveFrameMs =
			typeof raw.ptyAdaptiveFrameMs === "number" &&
			Number.isFinite(raw.ptyAdaptiveFrameMs)
				? raw.ptyAdaptiveFrameMs
				: undefined;
		const ptyAdaptiveQueueThreshold =
			typeof raw.ptyAdaptiveQueueThreshold === "number" &&
			Number.isFinite(raw.ptyAdaptiveQueueThreshold)
				? raw.ptyAdaptiveQueueThreshold
				: undefined;
		const ptyAdaptiveMaxLinesPerFrame =
			typeof raw.ptyAdaptiveMaxLinesPerFrame === "number" &&
			Number.isFinite(raw.ptyAdaptiveMaxLinesPerFrame)
				? raw.ptyAdaptiveMaxLinesPerFrame
				: undefined;
		const ptyAdaptiveMaxLinesPerFrameWebgl =
			typeof raw.ptyAdaptiveMaxLinesPerFrameWebgl === "number" &&
			Number.isFinite(raw.ptyAdaptiveMaxLinesPerFrameWebgl)
				? raw.ptyAdaptiveMaxLinesPerFrameWebgl
				: undefined;
		const ptyAdaptiveAutoTune =
			typeof raw.ptyAdaptiveAutoTune === "boolean"
				? raw.ptyAdaptiveAutoTune
				: undefined;
		const ptyAdaptiveMinBytesPerFrame =
			typeof raw.ptyAdaptiveMinBytesPerFrame === "number" &&
			Number.isFinite(raw.ptyAdaptiveMinBytesPerFrame)
				? raw.ptyAdaptiveMinBytesPerFrame
				: undefined;
		const ptyAdaptiveQueueBytesThreshold =
			typeof raw.ptyAdaptiveQueueBytesThreshold === "number" &&
			Number.isFinite(raw.ptyAdaptiveQueueBytesThreshold)
				? raw.ptyAdaptiveQueueBytesThreshold
				: undefined;
		const ptyAdaptiveQueueHysteresisRatio =
			typeof raw.ptyAdaptiveQueueHysteresisRatio === "number" &&
			Number.isFinite(raw.ptyAdaptiveQueueHysteresisRatio)
				? raw.ptyAdaptiveQueueHysteresisRatio
				: undefined;
		const profile = typeof raw.profile === "boolean" ? raw.profile : undefined;
		const timeoutMs =
			typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs)
				? raw.timeoutMs
				: undefined;
		return {
			scenario,
			lineCount,
			location,
			renderer,
			command,
			directLinesPerWrite,
			directWritesPerFrame,
			ptyMaxLinesPerFrame,
			ptyMaxFrameMs,
			ptyMaxBytesPerFrame,
			ptyAdaptiveDrain,
			ptyAdaptiveFrameMs,
			ptyAdaptiveQueueThreshold,
			ptyAdaptiveMaxLinesPerFrame,
			ptyAdaptiveMaxLinesPerFrameWebgl,
			ptyAdaptiveAutoTune,
			ptyAdaptiveMinBytesPerFrame,
			ptyAdaptiveQueueBytesThreshold,
			ptyAdaptiveQueueHysteresisRatio,
			profile,
			timeoutMs,
		};
	}

	public async runBenchmark(options: unknown = {}): Promise<BenchmarkResult> {
		const parsed = this.parseBenchmarkOptions(options);
		const scenario = parsed.scenario ?? "ptyStress";
		const scenarioDefaults = BENCHMARK_SCENARIOS[scenario];
		if (!scenarioDefaults) {
			throw new Error(`Unknown benchmark scenario: ${scenario}`);
		}
		const rawLineCount = parsed.lineCount ?? scenarioDefaults.lineCount;
		const lineCount =
			scenarioDefaults.mode === "command"
				? Math.max(0, Math.floor(rawLineCount))
				: Math.max(1, Math.floor(rawLineCount));
		const location: BenchmarkLocation = parsed.location ?? "panel";
		const renderer: BenchmarkRenderer = parsed.renderer ?? "auto";
		const profileEnabled = parsed.profile ?? true;
		const timeoutMs = parsed.timeoutMs ?? BENCHMARK_SENTINEL_TIMEOUT_MS;

		const previousOverride = this.runtimeConfigOverride;
		const override: Partial<RuntimeConfig> = {};
		if (renderer) {
			override.renderer = renderer;
		}
		if (parsed.ptyMaxLinesPerFrame !== undefined) {
			override.ptyMaxLinesPerFrame = parsed.ptyMaxLinesPerFrame;
		}
		if (parsed.ptyMaxFrameMs !== undefined) {
			override.ptyMaxFrameMs = parsed.ptyMaxFrameMs;
		}
		if (parsed.ptyMaxBytesPerFrame !== undefined) {
			override.ptyMaxBytesPerFrame = parsed.ptyMaxBytesPerFrame;
		}
		if (parsed.ptyAdaptiveDrain !== undefined) {
			override.ptyAdaptiveDrain = parsed.ptyAdaptiveDrain;
		}
		if (parsed.ptyAdaptiveFrameMs !== undefined) {
			override.ptyAdaptiveFrameMs = parsed.ptyAdaptiveFrameMs;
		}
		if (parsed.ptyAdaptiveQueueThreshold !== undefined) {
			override.ptyAdaptiveQueueThreshold = parsed.ptyAdaptiveQueueThreshold;
		}
		if (parsed.ptyAdaptiveMaxLinesPerFrame !== undefined) {
			override.ptyAdaptiveMaxLinesPerFrame = parsed.ptyAdaptiveMaxLinesPerFrame;
		}
		if (parsed.ptyAdaptiveMaxLinesPerFrameWebgl !== undefined) {
			override.ptyAdaptiveMaxLinesPerFrameWebgl =
				parsed.ptyAdaptiveMaxLinesPerFrameWebgl;
		}
		if (parsed.ptyAdaptiveAutoTune !== undefined) {
			override.ptyAdaptiveAutoTune = parsed.ptyAdaptiveAutoTune;
		}
		if (parsed.ptyAdaptiveMinBytesPerFrame !== undefined) {
			override.ptyAdaptiveMinBytesPerFrame = parsed.ptyAdaptiveMinBytesPerFrame;
		}
		if (parsed.ptyAdaptiveQueueBytesThreshold !== undefined) {
			override.ptyAdaptiveQueueBytesThreshold =
				parsed.ptyAdaptiveQueueBytesThreshold;
		}
		if (parsed.ptyAdaptiveQueueHysteresisRatio !== undefined) {
			override.ptyAdaptiveQueueHysteresisRatio =
				parsed.ptyAdaptiveQueueHysteresisRatio;
		}
		if (Object.keys(override).length > 0) {
			this.runtimeConfigOverride = override;
		}

		const config = vscode.workspace.getConfiguration("bootty");
		const configTarget = vscode.workspace.workspaceFolders?.length
			? vscode.ConfigurationTarget.Workspace
			: vscode.ConfigurationTarget.Global;
		const previousRenderer = config.inspect<BenchmarkRenderer>("renderer");
		const previousMaxLines = config.inspect<number>("pty.maxLinesPerFrame");
		const previousMaxFrameMs = config.inspect<number>("pty.maxFrameMs");
		const previousMaxBytes = config.inspect<number>("pty.maxBytesPerFrame");
		const previousAdaptiveDrain = config.inspect<boolean>("pty.adaptiveDrain");
		const previousAdaptiveFrameMs = config.inspect<number>(
			"pty.adaptiveFrameMs",
		);
		const previousAdaptiveQueueThreshold = config.inspect<number>(
			"pty.adaptiveQueueThreshold",
		);
		const previousAdaptiveMaxLines = config.inspect<number>(
			"pty.adaptiveMaxLinesPerFrame",
		);
		const previousAdaptiveMaxLinesWebgl = config.inspect<number>(
			"pty.adaptiveMaxLinesPerFrameWebgl",
		);
		const previousAdaptiveAutoTune = config.inspect<boolean>(
			"pty.adaptiveAutoTune",
		);
		const previousAdaptiveMinBytesPerFrame = config.inspect<number>(
			"pty.adaptiveMinBytesPerFrame",
		);
		const previousAdaptiveQueueBytesThreshold = config.inspect<number>(
			"pty.adaptiveQueueBytesThreshold",
		);
		const previousAdaptiveQueueHysteresisRatio = config.inspect<number>(
			"pty.adaptiveQueueHysteresisRatio",
		);
		const updates: Array<Thenable<void>> = [];
		const restore: Array<Thenable<void>> = [];
		const prevRendererValue =
			configTarget === vscode.ConfigurationTarget.Workspace
				? previousRenderer?.workspaceValue
				: previousRenderer?.globalValue;
		if (renderer && renderer !== prevRendererValue) {
			updates.push(config.update("renderer", renderer, configTarget));
			restore.push(
				config.update(
					"renderer",
					prevRendererValue === undefined ? undefined : prevRendererValue,
					configTarget,
				),
			);
		}
		if (parsed.ptyMaxLinesPerFrame !== undefined) {
			updates.push(
				config.update(
					"pty.maxLinesPerFrame",
					parsed.ptyMaxLinesPerFrame,
					configTarget,
				),
			);
			const prevValue =
				configTarget === vscode.ConfigurationTarget.Workspace
					? previousMaxLines?.workspaceValue
					: previousMaxLines?.globalValue;
			restore.push(
				config.update(
					"pty.maxLinesPerFrame",
					prevValue === undefined ? undefined : prevValue,
					configTarget,
				),
			);
		}
		if (parsed.ptyMaxFrameMs !== undefined) {
			updates.push(
				config.update("pty.maxFrameMs", parsed.ptyMaxFrameMs, configTarget),
			);
			restore.push(
				config.update(
					"pty.maxFrameMs",
					(configTarget === vscode.ConfigurationTarget.Workspace
						? previousMaxFrameMs?.workspaceValue
						: previousMaxFrameMs?.globalValue) ?? undefined,
					configTarget,
				),
			);
		}
		if (parsed.ptyMaxBytesPerFrame !== undefined) {
			updates.push(
				config.update(
					"pty.maxBytesPerFrame",
					parsed.ptyMaxBytesPerFrame,
					configTarget,
				),
			);
			restore.push(
				config.update(
					"pty.maxBytesPerFrame",
					(configTarget === vscode.ConfigurationTarget.Workspace
						? previousMaxBytes?.workspaceValue
						: previousMaxBytes?.globalValue) ?? undefined,
					configTarget,
				),
			);
		}
		if (parsed.ptyAdaptiveDrain !== undefined) {
			updates.push(
				config.update(
					"pty.adaptiveDrain",
					parsed.ptyAdaptiveDrain,
					configTarget,
				),
			);
			restore.push(
				config.update(
					"pty.adaptiveDrain",
					(configTarget === vscode.ConfigurationTarget.Workspace
						? previousAdaptiveDrain?.workspaceValue
						: previousAdaptiveDrain?.globalValue) ?? undefined,
					configTarget,
				),
			);
		}
		if (parsed.ptyAdaptiveFrameMs !== undefined) {
			updates.push(
				config.update(
					"pty.adaptiveFrameMs",
					parsed.ptyAdaptiveFrameMs,
					configTarget,
				),
			);
			restore.push(
				config.update(
					"pty.adaptiveFrameMs",
					(configTarget === vscode.ConfigurationTarget.Workspace
						? previousAdaptiveFrameMs?.workspaceValue
						: previousAdaptiveFrameMs?.globalValue) ?? undefined,
					configTarget,
				),
			);
		}
		if (parsed.ptyAdaptiveQueueThreshold !== undefined) {
			updates.push(
				config.update(
					"pty.adaptiveQueueThreshold",
					parsed.ptyAdaptiveQueueThreshold,
					configTarget,
				),
			);
			restore.push(
				config.update(
					"pty.adaptiveQueueThreshold",
					(configTarget === vscode.ConfigurationTarget.Workspace
						? previousAdaptiveQueueThreshold?.workspaceValue
						: previousAdaptiveQueueThreshold?.globalValue) ?? undefined,
					configTarget,
				),
			);
		}
		if (parsed.ptyAdaptiveMaxLinesPerFrame !== undefined) {
			updates.push(
				config.update(
					"pty.adaptiveMaxLinesPerFrame",
					parsed.ptyAdaptiveMaxLinesPerFrame,
					configTarget,
				),
			);
			restore.push(
				config.update(
					"pty.adaptiveMaxLinesPerFrame",
					(configTarget === vscode.ConfigurationTarget.Workspace
						? previousAdaptiveMaxLines?.workspaceValue
						: previousAdaptiveMaxLines?.globalValue) ?? undefined,
					configTarget,
				),
			);
		}
		if (parsed.ptyAdaptiveMaxLinesPerFrameWebgl !== undefined) {
			updates.push(
				config.update(
					"pty.adaptiveMaxLinesPerFrameWebgl",
					parsed.ptyAdaptiveMaxLinesPerFrameWebgl,
					configTarget,
				),
			);
			restore.push(
				config.update(
					"pty.adaptiveMaxLinesPerFrameWebgl",
					(configTarget === vscode.ConfigurationTarget.Workspace
						? previousAdaptiveMaxLinesWebgl?.workspaceValue
						: previousAdaptiveMaxLinesWebgl?.globalValue) ?? undefined,
					configTarget,
				),
			);
		}
		if (parsed.ptyAdaptiveAutoTune !== undefined) {
			updates.push(
				config.update(
					"pty.adaptiveAutoTune",
					parsed.ptyAdaptiveAutoTune,
					configTarget,
				),
			);
			restore.push(
				config.update(
					"pty.adaptiveAutoTune",
					(configTarget === vscode.ConfigurationTarget.Workspace
						? previousAdaptiveAutoTune?.workspaceValue
						: previousAdaptiveAutoTune?.globalValue) ?? undefined,
					configTarget,
				),
			);
		}
		if (parsed.ptyAdaptiveMinBytesPerFrame !== undefined) {
			updates.push(
				config.update(
					"pty.adaptiveMinBytesPerFrame",
					parsed.ptyAdaptiveMinBytesPerFrame,
					configTarget,
				),
			);
			restore.push(
				config.update(
					"pty.adaptiveMinBytesPerFrame",
					(configTarget === vscode.ConfigurationTarget.Workspace
						? previousAdaptiveMinBytesPerFrame?.workspaceValue
						: previousAdaptiveMinBytesPerFrame?.globalValue) ?? undefined,
					configTarget,
				),
			);
		}
		if (parsed.ptyAdaptiveQueueBytesThreshold !== undefined) {
			updates.push(
				config.update(
					"pty.adaptiveQueueBytesThreshold",
					parsed.ptyAdaptiveQueueBytesThreshold,
					configTarget,
				),
			);
			restore.push(
				config.update(
					"pty.adaptiveQueueBytesThreshold",
					(configTarget === vscode.ConfigurationTarget.Workspace
						? previousAdaptiveQueueBytesThreshold?.workspaceValue
						: previousAdaptiveQueueBytesThreshold?.globalValue) ?? undefined,
					configTarget,
				),
			);
		}
		if (parsed.ptyAdaptiveQueueHysteresisRatio !== undefined) {
			updates.push(
				config.update(
					"pty.adaptiveQueueHysteresisRatio",
					parsed.ptyAdaptiveQueueHysteresisRatio,
					configTarget,
				),
			);
			restore.push(
				config.update(
					"pty.adaptiveQueueHysteresisRatio",
					(configTarget === vscode.ConfigurationTarget.Workspace
						? previousAdaptiveQueueHysteresisRatio?.workspaceValue
						: previousAdaptiveQueueHysteresisRatio?.globalValue) ?? undefined,
					configTarget,
				),
			);
		}
		if (updates.length > 0 || this.runtimeConfigOverride) {
			await Promise.all(updates);
			this.broadcastSettingsUpdate();
			await new Promise((resolve) =>
				setTimeout(resolve, BENCHMARK_CONFIG_APPLY_DELAY_MS),
			);
		}

		if (location === "panel") {
			await this.panelProvider.show();
			await this.waitForPanelReady(BENCHMARK_READY_TIMEOUT_MS);
			// Ensure runtime config is applied after the panel is ready.
			if (updates.length > 0 || this.runtimeConfigOverride) {
				await this.waitForPanelConfigApplied(timeoutMs);
			}
		}

		const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const terminalId = this.createTerminal({
			location,
			cwd: workspaceCwd,
		});
		if (!terminalId) {
			throw new Error("Failed to create benchmark terminal.");
		}

		await this.waitForTerminalReady(terminalId, BENCHMARK_READY_TIMEOUT_MS);

		let profileStatus: ProfilingStatus | null = null;
		let startedProfiling = false;
		if (profileEnabled) {
			profileStatus = await this.startProfiling();
			startedProfiling = Boolean(
				profileStatus?.active && profileStatus.sessionId,
			);
		}

		const startedAt = Date.now();
		if (scenarioDefaults.mode === "pty") {
			const prefix = `${scenarioDefaults.label}-`;
			const sentinel = `__bootty_bench_done_${crypto.randomUUID()}__`;
			const command = this.buildBenchmarkCommand(scenario, lineCount, sentinel);
			const sentinelPromise = this.waitForBenchmarkLines(
				terminalId,
				prefix,
				lineCount,
				sentinel,
				timeoutMs,
			);
			this.ptyService.write(terminalId, `${command}\n`);
			await sentinelPromise;
			await this.waitForBenchmarkDrain(terminalId, timeoutMs);
		} else if (scenarioDefaults.mode === "direct") {
			const linesPerWrite =
				parsed.directLinesPerWrite ??
				scenarioDefaults.directLinesPerWrite ??
				lineCount;
			const repeat = Math.floor(lineCount / linesPerWrite);
			const remainder = lineCount % linesPerWrite;
			if (repeat <= 0 && remainder <= 0) {
				throw new Error("Direct benchmark must write at least one line.");
			}
			const payload = this.buildBenchmarkPayload(
				scenarioDefaults.label,
				linesPerWrite,
			);
			const finalPayload =
				remainder > 0
					? this.buildBenchmarkPayload(scenarioDefaults.label, remainder)
					: undefined;
			const writesPerFrame =
				parsed.directWritesPerFrame ??
				scenarioDefaults.directWritesPerFrame ??
				0;
			await this.waitForBenchmarkDirectWrite(
				terminalId,
				payload,
				repeat,
				finalPayload,
				writesPerFrame,
				timeoutMs,
			);
		} else if (scenarioDefaults.mode === "command") {
			const command =
				parsed.command ??
				(scenarioDefaults.commandRelative
					? path.resolve(
							this.context.extensionPath,
							scenarioDefaults.commandRelative,
						)
					: undefined);
			if (!command) {
				throw new Error("Benchmark command is not configured.");
			}
			const prefix = scenarioDefaults.outputPrefix ?? "Results saved to:";
			const commandPromise = this.waitForBenchmarkCommandOutput(
				terminalId,
				prefix,
				timeoutMs,
			);
			const escaped = command.replaceAll('"', '\\"');
			const quotedCommand = command.includes(" ") ? `"${escaped}"` : escaped;
			this.ptyService.write(terminalId, `${quotedCommand}\n`);
			const outputPath = await commandPromise;
			const finishedAt = Date.now();
			await new Promise((resolve) =>
				setTimeout(resolve, BENCHMARK_COOLDOWN_MS),
			);

			let stopStatus: ProfilingStatus | null = null;
			if (profileEnabled && startedProfiling) {
				stopStatus = await this.stopProfiling();
			}

			if (restore.length > 0) {
				await Promise.all(restore);
			}
			this.runtimeConfigOverride = previousOverride;
			if (restore.length > 0 || previousOverride) {
				this.broadcastSettingsUpdate();
				await new Promise((resolve) =>
					setTimeout(resolve, BENCHMARK_CONFIG_APPLY_DELAY_MS),
				);
			}

			this.destroyTerminalById(terminalId);

			return {
				terminalId,
				scenario,
				renderer,
				location,
				lineCount,
				startedAt,
				finishedAt,
				durationMs: finishedAt - startedAt,
				outputPath,
				profile:
					profileEnabled && (profileStatus || stopStatus)
						? {
								sessionId: stopStatus?.sessionId ?? profileStatus?.sessionId,
								outputPaths:
									stopStatus?.outputPaths ?? profileStatus?.outputPaths,
							}
						: undefined,
			};
		} else {
			throw new Error(`Unsupported benchmark mode: ${scenarioDefaults.mode}`);
		}
		const finishedAt = Date.now();

		await new Promise((resolve) => setTimeout(resolve, BENCHMARK_COOLDOWN_MS));

		let stopStatus: ProfilingStatus | null = null;
		if (profileEnabled && startedProfiling) {
			stopStatus = await this.stopProfiling();
		}

		if (restore.length > 0) {
			await Promise.all(restore);
		}
		this.runtimeConfigOverride = previousOverride;
		if (restore.length > 0 || previousOverride) {
			this.broadcastSettingsUpdate();
			await new Promise((resolve) =>
				setTimeout(resolve, BENCHMARK_CONFIG_APPLY_DELAY_MS),
			);
		}

		this.destroyTerminalById(terminalId);

		return {
			terminalId,
			scenario,
			renderer,
			location,
			lineCount,
			startedAt,
			finishedAt,
			durationMs: finishedAt - startedAt,
			profile:
				profileEnabled && (profileStatus || stopStatus)
					? {
							sessionId: stopStatus?.sessionId ?? profileStatus?.sessionId,
							outputPaths:
								stopStatus?.outputPaths ?? profileStatus?.outputPaths,
						}
					: undefined,
		};
	}

	/** Broadcast updated settings to all ready terminals */
	private broadcastSettingsUpdate(): void {
		const settings = getDisplaySettings();
		const config = this.getRuntimeConfig();

		// Always update the panel webview's runtime config, even if no terminals exist.
		// This ensures the next terminal created uses the latest renderer setting.
		this.panelProvider.postMessage({
			type: "update-config",
			config,
		});

		for (const [id, instance] of this.terminals) {
			if (instance.ready) {
				this.postToTerminal(id, {
					type: "update-settings",
					terminalId: id,
					settings,
				});
				// Also update runtime config (includes renderer mode)
				this.postToTerminal(id, {
					type: "update-config",
					config,
				});
			}
		}
	}

	/** Broadcast updated theme to all ready terminals */
	private broadcastThemeUpdate(): void {
		const theme = resolveTerminalTheme();
		for (const [id, instance] of this.terminals) {
			if (instance.ready) {
				this.postToTerminal(id, {
					type: "update-theme",
					terminalId: id,
					theme,
				});
			}
			// Re-resolve terminal list colors when theme changes
			if (instance.colorKey) {
				const newColor = TerminalManager.resolveColorKey(instance.colorKey);
				if (newColor && newColor !== instance.color) {
					instance.color = newColor;
					this.panelProvider.postMessage({
						type: "update-terminal-color",
						terminalId: id,
						color: newColor,
					});
				}
			}
		}
	}

	/** Get runtime config from VS Code settings */
	private getRuntimeConfig(): RuntimeConfig {
		const config = vscode.workspace.getConfiguration("bootty");
		const bellStyle = config.get<"visual" | "none">("bell") ?? "visual";
		const renderer =
			config.get<"auto" | "webgl" | "canvas">("renderer") ?? "auto";
		const debugLog = config.get<string>("debugLog") ?? "";
		const ptyMaxLinesPerFrame = Math.max(
			0,
			Math.floor(config.get<number>("pty.maxLinesPerFrame") ?? 0),
		);
		const ptyMaxFrameMs = Math.max(
			0,
			config.get<number>("pty.maxFrameMs") ?? 0,
		);
		const ptyMaxBytesPerFrame = Math.max(
			0,
			config.get<number>("pty.maxBytesPerFrame") ?? 0,
		);
		const ptyAdaptiveDrain = config.get<boolean>("pty.adaptiveDrain") ?? true;
		const ptyAdaptiveFrameMs = Math.max(
			0,
			config.get<number>("pty.adaptiveFrameMs") ?? 2,
		);
		const ptyAdaptiveQueueThreshold = Math.max(
			0,
			config.get<number>("pty.adaptiveQueueThreshold") ?? 10,
		);
		const ptyAdaptiveMaxLinesPerFrame = Math.max(
			0,
			Math.floor(config.get<number>("pty.adaptiveMaxLinesPerFrame") ?? 500),
		);
		const ptyAdaptiveMaxLinesPerFrameWebgl = Math.max(
			0,
			Math.floor(
				config.get<number>("pty.adaptiveMaxLinesPerFrameWebgl") ?? 3000,
			),
		);
		const ptyAdaptiveAutoTune =
			config.get<boolean>("pty.adaptiveAutoTune") ?? true;
		const ptyAdaptiveMinBytesPerFrame = Math.max(
			0,
			Math.floor(config.get<number>("pty.adaptiveMinBytesPerFrame") ?? 0),
		);
		const ptyAdaptiveQueueBytesThreshold = Math.max(
			0,
			config.get<number>("pty.adaptiveQueueBytesThreshold") ?? 0,
		);
		const ptyAdaptiveQueueHysteresisRatio = Math.max(
			0,
			config.get<number>("pty.adaptiveQueueHysteresisRatio") ?? 0,
		);
		const base = {
			bellStyle,
			renderer,
			debugLog,
			ptyMaxLinesPerFrame,
			ptyMaxFrameMs,
			ptyMaxBytesPerFrame,
			ptyAdaptiveDrain,
			ptyAdaptiveFrameMs,
			ptyAdaptiveQueueThreshold,
			ptyAdaptiveMaxLinesPerFrame,
			ptyAdaptiveMaxLinesPerFrameWebgl,
			ptyAdaptiveAutoTune,
			ptyAdaptiveMinBytesPerFrame,
			ptyAdaptiveQueueBytesThreshold,
			ptyAdaptiveQueueHysteresisRatio,
		};
		if (this.runtimeConfigOverride) {
			return { ...base, ...this.runtimeConfigOverride };
		}
		return base;
	}

	private resolvePtyOutputBatchConfig(): {
		maxBytes: number;
		maxDelayMs: number;
	} {
		const config = vscode.workspace.getConfiguration("bootty");
		const maxBytes = Math.max(
			0,
			Math.floor(config.get<number>("pty.outputBatchMaxBytes") ?? 0),
		);
		const maxDelayMs = Math.max(
			0,
			config.get<number>("pty.outputBatchMaxDelayMs") ?? 0,
		);
		return { maxBytes, maxDelayMs };
	}

	private async waitForPanelReady(timeoutMs: number): Promise<void> {
		if (this.panelProvider.isReady) return;
		const deadline = Date.now() + timeoutMs;
		while (!this.panelProvider.isReady) {
			if (Date.now() > deadline) {
				throw new Error("Panel webview did not become ready in time.");
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	private async waitForTerminalReady(
		id: TerminalId,
		timeoutMs: number,
	): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (true) {
			const instance = this.terminals.get(id);
			if (instance?.ready) return;
			if (!instance) {
				throw new Error(`Terminal ${id} no longer exists.`);
			}
			if (Date.now() > deadline) {
				throw new Error(`Terminal ${id} did not become ready in time.`);
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	private waitForBenchmarkLines(
		id: TerminalId,
		prefix: string,
		targetLines: number,
		sentinel: string,
		timeoutMs: number,
	): Promise<void> {
		if (this.benchmarkWatchers.has(id)) {
			return Promise.reject(
				new Error(`Benchmark already running for terminal ${id}.`),
			);
		}
		return new Promise((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				this.benchmarkWatchers.delete(id);
				reject(
					new Error(
						`Benchmark timed out waiting for ${targetLines} lines (${prefix}).`,
					),
				);
			}, timeoutMs);
			this.benchmarkWatchers.set(id, {
				prefix,
				prefixBytes: this.encodePtyData(prefix),
				sentinel,
				sentinelBytes: this.encodePtyData(sentinel),
				targetLines,
				seenLines: 0,
				resolve: () => {
					clearTimeout(timeoutId);
					resolve();
				},
				reject: (error) => {
					clearTimeout(timeoutId);
					reject(error);
				},
				timeoutId,
				tail: "",
				tailBytes: new Uint8Array(0),
			});
		});
	}

	private waitForBenchmarkCommandOutput(
		id: TerminalId,
		prefix: string,
		timeoutMs: number,
	): Promise<string> {
		if (this.benchmarkCommandWatchers.has(id)) {
			return Promise.reject(
				new Error(`Benchmark command already running for terminal ${id}.`),
			);
		}
		return new Promise((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				this.benchmarkCommandWatchers.delete(id);
				reject(
					new Error(`Benchmark command timed out waiting for "${prefix}".`),
				);
			}, timeoutMs);
			this.benchmarkCommandWatchers.set(id, {
				prefix,
				prefixBytes: this.encodePtyData(prefix),
				resolve: (outputPath) => {
					clearTimeout(timeoutId);
					resolve(outputPath);
				},
				reject: (error) => {
					clearTimeout(timeoutId);
					reject(error);
				},
				timeoutId,
				tail: "",
				tailBytes: new Uint8Array(0),
			});
		});
	}

	private handleBenchmarkOutput(
		id: TerminalId,
		data: string | Uint8Array,
	): void {
		const watcher = this.benchmarkWatchers.get(id);
		const commandWatcher = this.benchmarkCommandWatchers.get(id);
		if (!watcher && !commandWatcher) return;

		if (typeof data === "string") {
			if (!watcher && commandWatcher) {
				const combined = `${commandWatcher.tail}${data}`;
				const prefix = commandWatcher.prefix;
				let searchIndex = 0;
				while (true) {
					const matchIndex = combined.indexOf(prefix, searchIndex);
					if (matchIndex === -1) break;
					const lineStart =
						matchIndex === 0 ||
						combined[matchIndex - 1] === "\n" ||
						combined[matchIndex - 1] === "\r";
					if (lineStart) {
						this.benchmarkCommandWatchers.delete(id);
						const rest = combined.slice(matchIndex + prefix.length);
						const line = rest.split("\n", 1)[0] ?? "";
						const outputPath = line.replace(/\r$/, "").trim();
						commandWatcher.resolve(outputPath);
						return;
					}
					searchIndex = matchIndex + prefix.length;
				}
				const tailSize = prefix.length + 1;
				commandWatcher.tail =
					combined.length > tailSize ? combined.slice(-tailSize) : combined;
				return;
			}
			const combined = `${watcher?.tail ?? commandWatcher?.tail ?? ""}${data}`;
			let start = 0;
			while (true) {
				const newlineIndex = combined.indexOf("\n", start);
				if (newlineIndex === -1) break;
				const rawLine = combined.slice(start, newlineIndex);
				start = newlineIndex + 1;
				const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
				if (commandWatcher && line.startsWith(commandWatcher.prefix)) {
					this.benchmarkCommandWatchers.delete(id);
					const outputPath = line.slice(commandWatcher.prefix.length).trim();
					commandWatcher.resolve(outputPath);
					return;
				}
				if (!watcher) {
					continue;
				}
				if (line === watcher.sentinel) {
					this.benchmarkWatchers.delete(id);
					watcher.resolve();
					return;
				}
				if (line.startsWith(watcher.prefix)) {
					watcher.seenLines += 1;
					if (watcher.seenLines >= watcher.targetLines) {
						this.benchmarkWatchers.delete(id);
						watcher.resolve();
						return;
					}
				}
			}
			const tail = combined.slice(start);
			if (watcher) {
				watcher.tail = tail;
			}
			if (commandWatcher) {
				commandWatcher.tail = tail;
			}
			return;
		}

		if (!watcher && commandWatcher) {
			const combined =
				commandWatcher.tailBytes.length > 0
					? this.concatPtyChunks(
							[commandWatcher.tailBytes, data],
							commandWatcher.tailBytes.length + data.length,
						)
					: data;
			const combinedBuffer = this.asBuffer(combined);
			const prefixBytes = commandWatcher.prefixBytes;
			const prefixBuffer = this.asBuffer(prefixBytes);
			let searchIndex = 0;
			while (true) {
				const matchIndex = combinedBuffer.indexOf(prefixBuffer, searchIndex);
				if (matchIndex === -1) break;
				const lineStart =
					matchIndex === 0 ||
					combined[matchIndex - 1] === 0x0a ||
					combined[matchIndex - 1] === 0x0d;
				if (lineStart) {
					this.benchmarkCommandWatchers.delete(id);
					const restStart = matchIndex + prefixBytes.length;
					const newlineIndex = combinedBuffer.indexOf(0x0a, restStart);
					const rawEnd = newlineIndex === -1 ? combined.length : newlineIndex;
					let lineBytes = combinedBuffer.subarray(restStart, rawEnd);
					if (
						lineBytes.length > 0 &&
						lineBytes[lineBytes.length - 1] === 0x0d
					) {
						lineBytes = lineBytes.subarray(0, lineBytes.length - 1);
					}
					const outputPath = this.decodePtyData(lineBytes).trim();
					commandWatcher.resolve(outputPath);
					return;
				}
				searchIndex = matchIndex + prefixBytes.length;
			}
			const tailSize = prefixBytes.length + 1;
			const tailStart =
				combined.length > tailSize ? combined.length - tailSize : 0;
			commandWatcher.tailBytes = this.copyBytes(combined, tailStart);
			return;
		}

		const seedTail =
			watcher?.tailBytes ?? commandWatcher?.tailBytes ?? new Uint8Array(0);
		const combined =
			seedTail.length > 0
				? this.concatPtyChunks([seedTail, data], seedTail.length + data.length)
				: data;
		const combinedBuffer = this.asBuffer(combined);
		let start = 0;
		while (true) {
			const newlineIndex = combinedBuffer.indexOf(0x0a, start);
			if (newlineIndex === -1) break;
			let lineBytes = combinedBuffer.subarray(start, newlineIndex);
			start = newlineIndex + 1;
			if (lineBytes.length > 0 && lineBytes[lineBytes.length - 1] === 0x0d) {
				lineBytes = lineBytes.subarray(0, lineBytes.length - 1);
			}
			if (
				commandWatcher &&
				this.bytesStartsWith(lineBytes, commandWatcher.prefixBytes)
			) {
				this.benchmarkCommandWatchers.delete(id);
				const outputBytes = lineBytes.subarray(
					commandWatcher.prefixBytes.length,
				);
				const outputPath = this.decodePtyData(outputBytes).trim();
				commandWatcher.resolve(outputPath);
				return;
			}
			if (!watcher) {
				continue;
			}
			if (this.bytesEqual(lineBytes, watcher.sentinelBytes)) {
				this.benchmarkWatchers.delete(id);
				watcher.resolve();
				return;
			}
			if (this.bytesStartsWith(lineBytes, watcher.prefixBytes)) {
				watcher.seenLines += 1;
				if (watcher.seenLines >= watcher.targetLines) {
					this.benchmarkWatchers.delete(id);
					watcher.resolve();
					return;
				}
			}
		}
		const tailBytes = this.copyBytes(combined, start);
		if (watcher) {
			watcher.tailBytes = tailBytes;
		}
		if (commandWatcher) {
			commandWatcher.tailBytes = tailBytes;
		}
	}

	private waitForBenchmarkDrain(
		id: TerminalId,
		timeoutMs: number,
	): Promise<void> {
		if (this.benchmarkDrainWatchers.has(id)) {
			return Promise.reject(
				new Error(`Benchmark drain already pending for terminal ${id}.`),
			);
		}
		const token = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				this.benchmarkDrainWatchers.delete(id);
				reject(new Error(`Benchmark drain timed out for terminal ${id}.`));
			}, timeoutMs);
			this.benchmarkDrainWatchers.set(id, {
				token,
				resolve: () => {
					clearTimeout(timeoutId);
					resolve();
				},
				reject: (error) => {
					clearTimeout(timeoutId);
					reject(error);
				},
				timeoutId,
			});
			this.postToTerminal(id, {
				type: "bench-drain-request",
				terminalId: id,
				token,
			});
		});
	}

	private waitForBenchmarkDirectWrite(
		id: TerminalId,
		payload: string,
		repeat: number,
		finalPayload: string | undefined,
		writesPerFrame: number,
		timeoutMs: number,
	): Promise<void> {
		if (this.benchmarkDirectWriteWatchers.has(id)) {
			return Promise.reject(
				new Error(`Benchmark direct write already running for terminal ${id}.`),
			);
		}
		const token = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				this.benchmarkDirectWriteWatchers.delete(id);
				reject(
					new Error(`Benchmark direct write timed out for terminal ${id}.`),
				);
			}, timeoutMs);
			this.benchmarkDirectWriteWatchers.set(id, {
				token,
				resolve: () => {
					clearTimeout(timeoutId);
					resolve();
				},
				reject: (error) => {
					clearTimeout(timeoutId);
					reject(error);
				},
				timeoutId,
			});
			this.postToTerminal(id, {
				type: "bench-direct-write",
				terminalId: id,
				token,
				payload,
				repeat,
				finalPayload,
				writesPerFrame,
			});
		});
	}

	private handleBenchmarkDrainComplete(id: TerminalId, token: string): void {
		const watcher = this.benchmarkDrainWatchers.get(id);
		if (!watcher || watcher.token !== token) return;
		this.benchmarkDrainWatchers.delete(id);
		watcher.resolve();
	}

	private handleBenchmarkDirectWriteComplete(
		id: TerminalId,
		token: string,
	): void {
		const watcher = this.benchmarkDirectWriteWatchers.get(id);
		if (!watcher || watcher.token !== token) return;
		this.benchmarkDirectWriteWatchers.delete(id);
		watcher.resolve();
	}

	private waitForPanelConfigApplied(timeoutMs: number): Promise<void> {
		const token = crypto.randomUUID();
		if (this.configApplyWatchers.has(token)) {
			return Promise.reject(new Error("Config apply token collision"));
		}
		return new Promise((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				this.configApplyWatchers.delete(token);
				reject(new Error("Timed out waiting for config apply."));
			}, timeoutMs);
			this.configApplyWatchers.set(token, {
				token,
				resolve: () => {
					clearTimeout(timeoutId);
					resolve();
				},
				reject: (error) => {
					clearTimeout(timeoutId);
					reject(error);
				},
				timeoutId,
			});
			this.panelProvider.postMessage({
				type: "update-config",
				config: this.getRuntimeConfig(),
				token,
			});
		});
	}

	private handleConfigApplied(token: string): void {
		const watcher = this.configApplyWatchers.get(token);
		if (!watcher) return;
		this.configApplyWatchers.delete(token);
		watcher.resolve();
	}

	createTerminal(config?: Partial<TerminalConfig>): TerminalId | null {
		const location: TerminalLocation = config?.location ?? "panel";
		return location === "editor"
			? this.createEditorTerminal(config)
			: this.createPanelTerminal(config);
	}

	/** Create terminal in editor tab */
	private createEditorTerminal(
		config?: Partial<TerminalConfig>,
	): TerminalId | null {
		const id = createTerminalId();
		const index = this.getNextIndex();
		const panel = createWebviewPanel(this.context.extensionUri, id);
		const instance: EditorTerminalInstance = {
			id,
			location: "editor",
			config: config ?? {},
			panel,
			ready: false,
			dataQueue: [],
			title: `Terminal ${index}`,
			index,
		};
		this.terminals.set(id, instance);

		// Setup message handler for webview -> extension
		panel.webview.onDidReceiveMessage(
			(message: WebviewMessage) => this.handleWebviewMessage(message),
			undefined,
			this.context.subscriptions,
		);

		// Spawn PTY
		const spawnResult = this.spawnPty(id, config);
		if (!spawnResult.ok) {
			panel.dispose();
			this.terminals.delete(id);
			this.releaseIndex(index);
			return null;
		}

		// Set ready timeout
		instance.readyTimeout = setTimeout(() => {
			if (!instance.ready) {
				vscode.window.showErrorMessage(
					"Terminal failed to initialize (timeout)",
				);
				this.destroyTerminal(id);
			}
		}, READY_TIMEOUT_MS);

		// Cleanup on panel close
		panel.onDidDispose(() => this.destroyTerminal(id));
		return id;
	}

	/** Create terminal in panel tab */
	private createPanelTerminal(
		config?: Partial<TerminalConfig>,
	): TerminalId | null {
		const id = createTerminalId();
		const index = this.getNextIndex();
		const title = `Terminal ${index}`;
		const instance: PanelTerminalInstance = {
			id,
			location: "panel",
			config: config ?? {},
			ready: false,
			dataQueue: [],
			title,
			index,
		};
		this.terminals.set(id, instance);

		// Spawn PTY
		const spawnResult = this.spawnPty(id, config);
		if (!spawnResult.ok) {
			this.terminals.delete(id);
			this.releaseIndex(index);
			return null;
		}

		// Set ready timeout
		instance.readyTimeout = setTimeout(() => {
			if (!instance.ready) {
				vscode.window.showErrorMessage(
					"Terminal failed to initialize (timeout)",
				);
				this.destroyTerminal(id);
			}
		}, READY_TIMEOUT_MS);

		// Add tab to panel (panel handles message routing)
		this.panelProvider.addTerminal(id, title, true);

		// Add to terminal order for persistence
		this.terminalOrder.push(id);
		this.activeTerminalId = id;
		this.savePersistedState();

		return id;
	}

	/** Spawn PTY process for terminal */
	private spawnPty(
		id: TerminalId,
		config?: Partial<TerminalConfig>,
	): { ok: true } | { ok: false; error: string } {
		const resolvedConfig = resolveConfig(config);
		const result = this.ptyService.spawn(id, resolvedConfig, {
			onData: (data) => this.handlePtyData(id, data),
			onExit: (code) => this.handlePtyExit(id, code),
			onError: (error) => this.handlePtyError(id, error),
		});

		if (!result.ok) {
			vscode.window.showErrorMessage(
				`Failed to start terminal: ${result.error}`,
			);
			return { ok: false, error: result.error };
		}
		return { ok: true };
	}

	/** Handle messages from panel webview */
	handlePanelMessage(message: PanelWebviewMessage): void {
		switch (message.type) {
			case "panel-ready":
				// Panel webview loaded, send hydration state
				this.handlePanelReady();
				break;
			case "terminal-ready":
				this.handleTerminalReady(
					message.terminalId,
					message.cols,
					message.rows,
				);
				break;
			case "tab-activated":
				// Tab switch with resize
				this.handleTerminalResize(
					message.terminalId,
					message.cols,
					message.rows,
				);
				// Update active terminal
				this.activeTerminalId = message.terminalId;
				break;
			case "tab-close-requested":
				this.destroyTerminal(message.terminalId);
				break;
			case "new-tab-requested":
				this.createTerminal({ location: "panel", cwd: getWorkspaceCwd() });
				// Focus the newly created terminal
				this.panelProvider.postMessage({ type: "focus-terminal" });
				break;
			// NOTE: new-tab-requested-with-title is deprecated.
			// Terminal restoration is now handled via extension state and hydrate-state message.
			case "tab-renamed":
				this.handleTabRenamed(message.terminalId, message.title);
				break;
			case "rename-requested":
				this.handleRenameRequested(message.terminalId);
				break;
			case "toggle-panel-requested":
			case "next-tab-requested":
			case "prev-tab-requested":
				// Handled by panel-view-provider, not terminal-manager
				break;
			// NEW: Terminal list messages (Phase 1-4)
			case "terminal-selected":
				// Selection change - persist active terminal
				this.activeTerminalId = message.terminalId;
				this.savePersistedState();
				break;
			case "split-requested":
				this.handleSplitTerminal(message.terminalId);
				break;
			case "unsplit-requested":
				this.handleUnsplitTerminal(message.terminalId);
				break;
			case "join-requested":
				this.handleJoinTerminal(message.terminalId, message.targetGroupId);
				break;
			case "color-picker-requested":
				this.handleColorPickerRequested(message.terminalId);
				break;
			case "icon-picker-requested":
				this.handleIconPickerRequested(message.terminalId);
				break;
			case "terminals-reordered":
				this.handleTerminalsReordered(message.terminalIds);
				break;
			case "group-reordered":
				this.handleGroupReordered(message.groupId, message.terminalIds);
				break;
			case "list-width-changed":
				this.handleListWidthChanged(message.width);
				break;
			case "group-selected-requested":
				this.handleGroupSelectedTerminals(message.terminalIds);
				break;
			default:
				// Handle common WebviewMessage types
				this.handleWebviewMessage(message as WebviewMessage);
		}
	}

	/** Handle messages from editor webview */
	private handleWebviewMessage(message: WebviewMessage): void {
		switch (message.type) {
			case "terminal-ready":
				this.handleTerminalReady(
					message.terminalId,
					message.cols,
					message.rows,
				);
				break;
			case "terminal-input":
				this.handleTerminalInput(message.terminalId, message.data);
				break;
			case "terminal-resize":
				this.handleTerminalResize(
					message.terminalId,
					message.cols,
					message.rows,
				);
				break;
			case "open-url":
				this.handleOpenUrl(message.url);
				break;
			case "open-file":
				this.handleOpenFile(message.path, message.line, message.column);
				break;
			case "batch-check-file-exists":
				this.handleBatchCheckFileExists(
					message.terminalId,
					message.batchId,
					message.paths,
				);
				break;
			case "terminal-bell":
				this.handleTerminalBell(message.terminalId);
				break;
			case "renderer-status":
				this.handleRendererStatus(
					message.terminalId,
					message.renderer,
					message.status,
					message.fallback,
					message.reason,
				);
				break;
			case "config-applied":
				this.handleConfigApplied(message.token);
				break;
			case "bench-drain-complete":
				this.handleBenchmarkDrainComplete(message.terminalId, message.token);
				break;
			case "bench-direct-write-complete":
				this.handleBenchmarkDirectWriteComplete(
					message.terminalId,
					message.token,
				);
				break;
			case "test-find-text-result": {
				const watcher = this.testFindTextWatchers.get(message.token);
				if (watcher) {
					this.testFindTextWatchers.delete(message.token);
					watcher.resolve(message.found);
				}
				break;
			}
			case "test-file-links-result": {
				const watcher = this.testFileLinksWatchers.get(message.token);
				if (watcher) {
					this.testFileLinksWatchers.delete(message.token);
					watcher.resolve(message.matches);
				}
				break;
			}
			case "test-search-result": {
				const watcher = this.testSearchWatchers.get(message.token);
				if (watcher) {
					this.testSearchWatchers.delete(message.token);
					watcher.resolve(message.state);
				}
				break;
			}
			case "test-sample-trailing-cells-result": {
				const watcher = this.testSampleTrailingCellsWatchers.get(message.token);
				if (watcher) {
					this.testSampleTrailingCellsWatchers.delete(message.token);
					watcher.resolve(message.result);
				}
				break;
			}
			case "test-direct-write-result": {
				const watcher = this.testDirectWriteWatchers.get(message.token);
				if (watcher) {
					this.testDirectWriteWatchers.delete(message.token);
					watcher.resolve();
				}
				break;
			}
			case "profile-data":
				this.handleProfileData(message.sessionId, message.events);
				break;
			case "profile-error":
				this.handleProfileError(message.sessionId, message.error);
				break;
			case "webview-error": {
				const label = message.terminalId ? `[${message.terminalId}] ` : "";
				const detail = message.stack
					? `${message.message}\n${message.stack}`
					: message.message;
				this.outputChannel.appendLine(
					`${label}Webview (${message.scope}) error: ${detail}`,
				);
				vscode.window.showErrorMessage(
					`BooTTY webview error (${message.scope}). Check the BooTTY output channel for details.`,
				);
				break;
			}
		}
	}

	/** Handle tab rename from panel */
	private handleTabRenamed(id: TerminalId, title: string): void {
		const instance = this.terminals.get(id);
		if (instance) {
			instance.title = title;
			this.savePersistedState();
		}
	}

	/** Handle rename request - show VS Code input box */
	private async handleRenameRequested(id: TerminalId): Promise<void> {
		const instance = this.terminals.get(id);
		if (!instance) return;

		const newTitle = await vscode.window.showInputBox({
			prompt: "Enter new terminal name",
			value: instance.title,
			validateInput: (value) => {
				if (!value.trim()) {
					return "Terminal name cannot be empty";
				}
				return null;
			},
		});

		if (newTitle && newTitle !== instance.title) {
			instance.title = newTitle;
			this.panelProvider.renameTerminal(id, newTitle);
			this.savePersistedState();
		}
	}

	/** Check if there are any terminals in the panel */
	hasPanelTerminals(): boolean {
		for (const instance of this.terminals.values()) {
			if (instance.location === "panel") {
				return true;
			}
		}
		return false;
	}

	/** Parse OSC 7 escape sequence for CWD tracking */
	private parseOSC7(data: string): string | undefined {
		// OSC 7 format: ESC ] 7 ; file://hostname/path ESC \ (or BEL)
		const match = data.match(
			/\x1b\]7;file:\/\/[^/]*([^\x07\x1b]+)(?:\x07|\x1b\\)/,
		);
		if (match) {
			return decodeURIComponent(match[1]);
		}
		return undefined;
	}

	/** Parse OSC 9 escape sequence for notifications (iTerm2 style) */
	private parseOSC9(data: string): string | undefined {
		// OSC 9 format: ESC ] 9 ; message BEL (or ST)
		// ESC = \x1b, BEL = \x07, ST = ESC \
		const match = data.match(/\x1b\]9;([^\x07\x1b]*)(?:\x07|\x1b\\)/);
		if (match) {
			return match[1];
		}
		return undefined;
	}

	/** Show VS Code notification for OSC 9 message */
	private handleOSC9Notification(message: string): void {
		const enabled = vscode.workspace
			.getConfiguration("bootty")
			.get<boolean>("notifications", true);
		if (!enabled) return;

		vscode.window.showInformationMessage(message);
	}

	private decodePtyData(data: Uint8Array): string {
		return this.ptyDecoder.decode(data);
	}

	private hasOscSequence(data: Uint8Array): boolean {
		if (data.length < 2) return false;
		for (let i = 0; i < data.length - 1; i += 1) {
			if (data[i] === 0x1b && data[i + 1] === 0x5d) {
				return true;
			}
		}
		return false;
	}

	private bytesStartsWith(data: Uint8Array, prefix: Uint8Array): boolean {
		if (prefix.length > data.length) return false;
		for (let i = 0; i < prefix.length; i += 1) {
			if (data[i] !== prefix[i]) return false;
		}
		return true;
	}

	private bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i += 1) {
			if (a[i] !== b[i]) return false;
		}
		return true;
	}

	private asBuffer(data: Uint8Array): Buffer {
		return Buffer.isBuffer(data)
			? data
			: Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	}

	private copyBytes(data: Uint8Array, start: number, end?: number): Uint8Array {
		const view = data.subarray(start, end);
		const copy = new Uint8Array(view.length);
		copy.set(view);
		return copy;
	}

	private encodePtyData(data: string): Uint8Array {
		return Buffer.from(data, "utf8");
	}

	private concatPtyChunks(
		chunks: Uint8Array[],
		totalBytes: number,
	): Uint8Array {
		if (chunks.length === 0 || totalBytes === 0) {
			return new Uint8Array(0);
		}
		if (chunks.length === 1) return chunks[0];
		const output = new Uint8Array(totalBytes);
		let offset = 0;
		for (const chunk of chunks) {
			output.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return output;
	}

	private enqueuePtyOutput(instance: TerminalInstance, data: Uint8Array): void {
		const { maxBytes, maxDelayMs } = this.ptyOutputBatchConfig;
		if (maxBytes <= 0 && maxDelayMs <= 0) {
			this.postToTerminal(instance.id, {
				type: "pty-data",
				terminalId: instance.id,
				data,
			});
			return;
		}
		if (!instance.outputBuffer) {
			instance.outputBuffer = { chunks: [], bytes: 0 };
		}
		const buffer = instance.outputBuffer;
		buffer.chunks.push(data);
		buffer.bytes += data.byteLength;

		if (maxBytes > 0 && buffer.bytes >= maxBytes) {
			this.flushPtyOutputBuffer(instance);
			return;
		}
		if (maxDelayMs > 0) {
			if (buffer.flushTimer) {
				clearTimeout(buffer.flushTimer);
			}
			buffer.flushTimer = setTimeout(() => {
				if (instance.outputBuffer) {
					instance.outputBuffer.flushTimer = undefined;
				}
				this.flushPtyOutputBuffer(instance);
			}, maxDelayMs);
		} else if (!buffer.flushTimer) {
			buffer.flushTimer = setTimeout(() => {
				if (instance.outputBuffer) {
					instance.outputBuffer.flushTimer = undefined;
				}
				this.flushPtyOutputBuffer(instance);
			}, 0);
		}
	}

	private flushPtyOutputBuffer(instance: TerminalInstance): void {
		const buffer = instance.outputBuffer;
		if (!buffer || buffer.bytes === 0) return;
		if (buffer.flushTimer) {
			clearTimeout(buffer.flushTimer);
			buffer.flushTimer = undefined;
		}
		const payload = this.concatPtyChunks(buffer.chunks, buffer.bytes);
		buffer.chunks = [];
		buffer.bytes = 0;
		if (!instance.ready) {
			if (instance.dataQueue.length < MAX_DATA_QUEUE_SIZE) {
				instance.dataQueue.push(payload);
			}
			return;
		}
		this.postToTerminal(instance.id, {
			type: "pty-data",
			terminalId: instance.id,
			data: payload,
		});
	}

	private flushQueuedPtyData(instance: TerminalInstance): void {
		if (instance.dataQueue.length === 0) return;
		const { maxBytes } = this.ptyOutputBatchConfig;
		let pendingChunks: Uint8Array[] = [];
		let pendingBytes = 0;
		const flushPending = () => {
			if (pendingBytes === 0) return;
			const payload = this.concatPtyChunks(pendingChunks, pendingBytes);
			this.postToTerminal(instance.id, {
				type: "pty-data",
				terminalId: instance.id,
				data: payload,
			});
			pendingChunks = [];
			pendingBytes = 0;
		};
		for (const chunk of instance.dataQueue) {
			if (maxBytes > 0 && pendingBytes > 0) {
				if (pendingBytes + chunk.byteLength > maxBytes) {
					flushPending();
				}
			}
			pendingChunks.push(chunk);
			pendingBytes += chunk.byteLength;
		}
		flushPending();
		instance.dataQueue = [];
	}

	private handlePtyData(id: TerminalId, data: string | Uint8Array): void {
		const instance = this.terminals.get(id);
		if (!instance) return;

		// PTY capture for debugging zsh escape sequences
		this.capturePtyData(id, data);

		const payload = typeof data === "string" ? this.encodePtyData(data) : data;
		const needsBenchmark =
			this.benchmarkWatchers.has(id) || this.benchmarkCommandWatchers.has(id);
		const needsOsc =
			typeof data === "string"
				? data.indexOf("\x1b]") !== -1
				: this.hasOscSequence(data);
		const decoded =
			needsOsc || typeof data === "string"
				? typeof data === "string"
					? data
					: this.decodePtyData(data)
				: undefined;

		if (decoded && decoded.indexOf("\x1b]") !== -1) {
			// Check for OSC 7 CWD update
			const cwd = this.parseOSC7(decoded);
			if (cwd) {
				instance.currentCwd = cwd;
				// Notify webview of CWD change for relative path resolution
				if (instance.ready) {
					this.postToTerminal(id, {
						type: "update-cwd",
						terminalId: id,
						cwd,
					});
				}
			}

			// Check for OSC 9 notification
			const notification = this.parseOSC9(decoded);
			if (notification) {
				this.handleOSC9Notification(notification);
			}
		}

		if (!instance.ready) {
			// Buffer until ready, with cap to prevent memory bloat
			if (instance.dataQueue.length < MAX_DATA_QUEUE_SIZE) {
				instance.dataQueue.push(payload);
			}
			// Silently drop if over cap (better than OOM)
		} else {
			this.enqueuePtyOutput(instance, payload);
		}

		if (needsBenchmark) {
			this.handleBenchmarkOutput(id, data);
		}
	}

	/**
	 * Toggle PTY capture on/off. When enabled, captures raw PTY bytes to a JSONL file.
	 * Use bootty.togglePtyCapture command to toggle.
	 */
	async togglePtyCapture(): Promise<void> {
		if (this.ptyCaptureEnabled) {
			// Stop capture
			this.stopPtyCapture();
			vscode.window.showInformationMessage(
				`BooTTY: PTY capture stopped. Saved to: ${this.ptyCapturePath}`,
			);
		} else {
			// Start capture - save to same location as profiles
			const captureId = crypto.randomUUID();
			const captureDir = path.join(
				this.context.logUri.fsPath,
				PROFILE_OUTPUT_SUBDIR,
			);
			const capturePath = path.join(
				captureDir,
				`pty-capture-${captureId}.jsonl`,
			);

			try {
				// Ensure directory exists
				await fs.promises.mkdir(captureDir, { recursive: true });

				this.ptyCaptureStream = fs.createWriteStream(capturePath, {
					flags: "w",
					encoding: "utf8",
				});
				this.ptyCapturePath = capturePath;
				this.ptyCaptureStartTime = Date.now();
				this.ptyCaptureEnabled = true;

				this.ptyCaptureStream.write(
					JSON.stringify({
						type: "start",
						ts: 0,
						path: capturePath,
						startTime: new Date().toISOString(),
					}) + "\n",
				);

				this.outputChannel.appendLine(
					`[PTY Capture] Started capturing to ${capturePath}`,
				);
				vscode.window.showInformationMessage(
					`BooTTY: PTY capture started. File: ${capturePath}`,
				);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				this.outputChannel.appendLine(
					`[PTY Capture] Failed to open capture file: ${message}`,
				);
				vscode.window.showErrorMessage(
					`BooTTY: Failed to start PTY capture: ${message}`,
				);
			}
		}
	}

	/**
	 * Stop PTY capture and close the file.
	 */
	private stopPtyCapture(): void {
		if (this.ptyCaptureStream) {
			this.ptyCaptureStream.write(
				JSON.stringify({
					type: "end",
					ts: (Date.now() - (this.ptyCaptureStartTime ?? Date.now())) / 1000,
					endTime: new Date().toISOString(),
				}) + "\n",
			);
			this.ptyCaptureStream.end();
			this.ptyCaptureStream = undefined;
		}
		this.ptyCaptureEnabled = false;
		this.outputChannel.appendLine(
			`[PTY Capture] Stopped capturing to ${this.ptyCapturePath}`,
		);
	}

	/**
	 * Capture PTY data to a file for debugging escape sequences.
	 * Toggle via bootty.togglePtyCapture command.
	 *
	 * Output format (JSONL):
	 * {"ts":123.456,"id":"term-1","hex":"1b5b48","escaped":"\\x1b[H","len":3}
	 */
	private capturePtyData(id: TerminalId, data: string | Uint8Array): void {
		if (!this.ptyCaptureEnabled || !this.ptyCaptureStream) return;

		const ts = (Date.now() - (this.ptyCaptureStartTime ?? Date.now())) / 1000;

		// Convert to bytes
		const bytes =
			typeof data === "string"
				? new TextEncoder().encode(data)
				: new Uint8Array(data);

		// Create hex representation
		const hex = Array.from(bytes)
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");

		// Create escaped string representation
		const escaped = Array.from(bytes)
			.map((b) => {
				if (b >= 0x20 && b < 0x7f && b !== 0x5c) {
					return String.fromCharCode(b);
				}
				switch (b) {
					case 0x07:
						return "\\a";
					case 0x08:
						return "\\b";
					case 0x09:
						return "\\t";
					case 0x0a:
						return "\\n";
					case 0x0d:
						return "\\r";
					case 0x1b:
						return "\\x1b";
					case 0x5c:
						return "\\\\";
					default:
						return `\\x${b.toString(16).padStart(2, "0")}`;
				}
			})
			.join("");

		const record = {
			ts: Math.round(ts * 1000) / 1000,
			id,
			hex,
			escaped,
			len: bytes.length,
		};

		this.ptyCaptureStream.write(JSON.stringify(record) + "\n");
	}

	private handleTerminalReady(
		id: TerminalId,
		cols: number,
		rows: number,
	): void {
		const instance = this.terminals.get(id);
		if (!instance) return;

		// Clear the ready timeout
		if (instance.readyTimeout) {
			clearTimeout(instance.readyTimeout);
			instance.readyTimeout = undefined;
		}

		// Resize PTY to webview-measured dimensions
		this.ptyService.resize(id, cols, rows);

		// Mark ready BEFORE posting messages so postToTerminal works
		instance.ready = true;

		// Send initial display settings
		const settings = getDisplaySettings();
		this.postToTerminal(id, {
			type: "update-settings",
			terminalId: id,
			settings,
		});

		// Send initial theme
		const theme = resolveTerminalTheme();
		this.postToTerminal(id, {
			type: "update-theme",
			terminalId: id,
			theme,
		});

		// Send runtime config (bell style, etc.)
		const config = this.getRuntimeConfig();
		this.postToTerminal(id, {
			type: "update-config",
			config,
		});
		if (this.profileSession && instance.location === "editor") {
			this.postToTerminal(id, {
				type: "profile-start",
				sessionId: this.profileSession.sessionId,
			});
		}

		// Flush buffered data (batch-aware)
		this.flushQueuedPtyData(instance);
	}

	/** Handle renderer status message from webview */
	private handleRendererStatus(
		id: TerminalId,
		type: "webgl" | "canvas",
		status: "active" | "degraded",
		fallback: boolean,
		reason?: string,
	): void {
		this.rendererInfo.set(id, { type, status, fallback, reason });

		// Log to output channel
		if (status === "degraded") {
			this.outputChannel.appendLine(
				`[${id}] Renderer DEGRADED (${type}): ${reason ?? "unknown reason"}`,
			);
		} else if (fallback) {
			this.outputChannel.appendLine(
				`[${id}] Renderer fallback to ${type}: ${reason ?? "unknown reason"}`,
			);
		} else {
			this.outputChannel.appendLine(`[${id}] Renderer: ${type}`);
		}
	}

	/** Get renderer info for all terminals (for BooTTY: Renderer Info command) */
	getRendererInfo(): Map<
		TerminalId,
		{
			type: "webgl" | "canvas";
			status: "active" | "degraded";
			fallback: boolean;
			reason?: string;
		}
	> {
		return new Map(this.rendererInfo);
	}

	/** Broadcast a message to all editor terminal webviews */
	broadcastToAll(message: ExtensionMessage): void {
		for (const [id, instance] of this.terminals) {
			if (instance.location === "editor" && instance.ready) {
				this.postToTerminal(id, message);
			}
		}
	}

	async toggleProfiling(): Promise<ProfilingStatus | null> {
		if (this.profileSession) {
			return await this.stopProfiling();
		}
		return await this.startProfiling();
	}

	private buildProfileFileName(sessionId: string): string {
		return `${PROFILE_FILE_PREFIX}-${sessionId}${PROFILE_FILE_EXTENSION}`;
	}

	private resolveConfiguredProfilePath(
		configuredPath: string | undefined,
		sessionId: string,
	): string | null {
		if (!configuredPath) return null;
		const trimmed = configuredPath.trim();
		if (!trimmed) return null;

		let expanded = trimmed;
		if (expanded.startsWith("~")) {
			expanded = path.join(os.homedir(), expanded.slice(1));
		}

		const baseDir = getWorkspaceCwd() ?? this.context.logUri.fsPath;
		const resolved = path.isAbsolute(expanded)
			? expanded
			: path.resolve(baseDir, expanded);
		const ext = path.extname(resolved);
		if (!ext) {
			return path.join(resolved, this.buildProfileFileName(sessionId));
		}
		return resolved;
	}

	private resolveProfileOutputPaths(sessionId: string): string[] {
		const outputPaths = new Set<string>();
		const defaultBase = this.context.logUri.fsPath;
		outputPaths.add(
			path.join(
				defaultBase,
				PROFILE_OUTPUT_SUBDIR,
				this.buildProfileFileName(sessionId),
			),
		);

		const config = vscode.workspace.getConfiguration("bootty");
		const configuredPath = config.get<string>("profile.outputPath");
		const resolvedConfigured = this.resolveConfiguredProfilePath(
			configuredPath,
			sessionId,
		);
		if (resolvedConfigured) {
			outputPaths.add(resolvedConfigured);
		}

		return [...outputPaths];
	}

	private async startProfiling(): Promise<ProfilingStatus | null> {
		if (this.profileSession) {
			return {
				active: true,
				sessionId: this.profileSession.sessionId,
				outputPaths: this.profileSession.outputPaths,
			};
		}

		const sessionId = crypto.randomUUID();
		const startedAt = Date.now();
		const outputPaths = this.resolveProfileOutputPaths(sessionId);
		if (outputPaths.length === 0) {
			return null;
		}

		const writers = outputPaths.map(
			(outputPath) => new ProfileWriter(outputPath),
		);
		const meta = {
			sessionId,
			startedAt,
			vscodeVersion: vscode.version,
			nodeVersion: process.version,
			platform: os.platform(),
			release: os.release(),
			arch: os.arch(),
		};

		try {
			await Promise.all(writers.map((writer) => writer.start(meta)));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await Promise.allSettled(
				writers.map((writer) =>
					writer.stop({ sessionId, startedAt, error: message }),
				),
			);
			this.outputChannel.appendLine(
				`[bootty] Profiling start failed: ${message}`,
			);
			return null;
		}

		this.profileSession = { sessionId, startedAt, outputPaths, writers };
		const config = vscode.workspace.getConfiguration("bootty");
		const data: Record<string, string | number | boolean | null> = {};
		const captureConfig = <T extends string | number | boolean>(
			key: string,
			value: T | undefined,
		): void => {
			const inspect = config.inspect<T>(key);
			data[`${key}.value`] = value ?? null;
			data[`${key}.default`] = inspect?.defaultValue ?? null;
			data[`${key}.global`] = inspect?.globalValue ?? null;
			data[`${key}.workspace`] = inspect?.workspaceValue ?? null;
		};
		captureConfig("renderer", config.get<RendererMode>("renderer"));
		captureConfig(
			"pty.maxLinesPerFrame",
			config.get<number>("pty.maxLinesPerFrame"),
		);
		captureConfig("pty.maxFrameMs", config.get<number>("pty.maxFrameMs"));
		captureConfig(
			"pty.maxBytesPerFrame",
			config.get<number>("pty.maxBytesPerFrame"),
		);
		captureConfig(
			"pty.adaptiveDrain",
			config.get<boolean>("pty.adaptiveDrain"),
		);
		captureConfig(
			"pty.adaptiveFrameMs",
			config.get<number>("pty.adaptiveFrameMs"),
		);
		captureConfig(
			"pty.adaptiveQueueThreshold",
			config.get<number>("pty.adaptiveQueueThreshold"),
		);
		captureConfig(
			"pty.adaptiveMaxLinesPerFrame",
			config.get<number>("pty.adaptiveMaxLinesPerFrame"),
		);
		captureConfig(
			"pty.adaptiveMaxLinesPerFrameWebgl",
			config.get<number>("pty.adaptiveMaxLinesPerFrameWebgl"),
		);
		captureConfig(
			"pty.adaptiveAutoTune",
			config.get<boolean>("pty.adaptiveAutoTune"),
		);
		captureConfig(
			"pty.adaptiveQueueBytesThreshold",
			config.get<number>("pty.adaptiveQueueBytesThreshold"),
		);
		captureConfig(
			"pty.adaptiveQueueHysteresisRatio",
			config.get<number>("pty.adaptiveQueueHysteresisRatio"),
		);
		captureConfig(
			"pty.outputBatchMaxBytes",
			config.get<number>("pty.outputBatchMaxBytes"),
		);
		captureConfig(
			"pty.outputBatchMaxDelayMs",
			config.get<number>("pty.outputBatchMaxDelayMs"),
		);
		const configEvent: ProfileEvent = {
			name: "bootty:extension:runtime-config",
			ts: Date.now(),
			source: "panel",
			data,
		};
		for (const writer of writers) {
			writer.appendEvents(sessionId, [configEvent]);
		}
		this.panelProvider.postMessage({ type: "profile-start", sessionId });
		this.broadcastToAll({ type: "profile-start", sessionId });

		return { active: true, sessionId, outputPaths };
	}

	private async stopProfiling(): Promise<ProfilingStatus | null> {
		const session = this.profileSession;
		if (!session) {
			return { active: false };
		}

		const { sessionId, outputPaths, writers, startedAt } = session;
		this.panelProvider.postMessage({ type: "profile-stop", sessionId });
		this.broadcastToAll({ type: "profile-stop", sessionId });

		await new Promise((resolve) => setTimeout(resolve, PROFILE_STOP_GRACE_MS));

		const stoppedAt = Date.now();
		const meta = {
			sessionId,
			startedAt,
			stoppedAt,
			durationMs: stoppedAt - startedAt,
		};

		const results = await Promise.allSettled(
			writers.map((writer) => writer.stop(meta)),
		);
		const failures = results.filter((result) => result.status === "rejected");
		if (failures.length > 0) {
			const first = failures[0];
			const message =
				first.status === "rejected"
					? first.reason instanceof Error
						? first.reason.message
						: String(first.reason)
					: "unknown";
			this.outputChannel.appendLine(
				`[bootty] Profiling stop failed: ${message}`,
			);
		}

		this.profileSession = undefined;
		return { active: false, sessionId, outputPaths };
	}

	private handleTerminalInput(id: TerminalId, data: string): void {
		// Forward webview input to PTY
		this.ptyService.write(id, data);
	}

	private handleTerminalResize(
		id: TerminalId,
		cols: number,
		rows: number,
	): void {
		// Webview detected resize, propagate to PTY
		this.ptyService.resize(id, cols, rows);
	}

	// Allowed URL schemes for external opening (security: prevent command injection)
	private static readonly ALLOWED_URL_SCHEMES = new Set([
		"http",
		"https",
		"mailto",
		"ftp",
		"ssh",
		"git",
		"tel",
	]);

	private handleOpenUrl(url: string): void {
		// Parse and validate URL before opening
		let uri: vscode.Uri;
		try {
			uri = vscode.Uri.parse(url, true); // strict mode
		} catch {
			console.warn(`[bootty] Invalid URL: ${url}`);
			return;
		}

		// Security: only allow safe schemes (prevent command:, vscode:, file: etc.)
		if (!TerminalManager.ALLOWED_URL_SCHEMES.has(uri.scheme)) {
			console.warn(
				`[bootty] Blocked URL with disallowed scheme: ${uri.scheme}`,
			);
			return;
		}

		// Open URL externally using VS Code's API (works in webviews)
		vscode.env.openExternal(uri).then(
			(success) => {
				if (!success) {
					console.warn(`[bootty] Failed to open URL: ${url}`);
				}
			},
			(error) => {
				console.error(`[bootty] Error opening URL: ${error}`);
			},
		);
	}

	private handleProfileData(sessionId: string, events: ProfileEvent[]): void {
		if (!this.profileSession || this.profileSession.sessionId !== sessionId) {
			return;
		}
		for (const writer of this.profileSession.writers) {
			writer.appendEvents(sessionId, events);
		}
	}

	private handleProfileError(sessionId: string, error: string): void {
		if (!this.profileSession || this.profileSession.sessionId !== sessionId) {
			return;
		}
		const event: ProfileEvent = {
			name: "bootty:profile-error",
			ts: Date.now(),
			data: { error },
			source: "panel",
		};
		for (const writer of this.profileSession.writers) {
			writer.appendEvents(sessionId, [event]);
		}
	}

	private async handleOpenFile(
		path: string,
		line?: number,
		column?: number,
	): Promise<void> {
		try {
			const uri = vscode.Uri.file(path);
			const doc = await vscode.workspace.openTextDocument(uri);
			const editor = await vscode.window.showTextDocument(doc);

			if (line !== undefined) {
				const position = new vscode.Position(
					Math.max(0, line - 1), // Convert to 0-indexed
					column !== undefined ? Math.max(0, column - 1) : 0,
				);
				editor.selection = new vscode.Selection(position, position);
				editor.revealRange(
					new vscode.Range(position, position),
					vscode.TextEditorRevealType.InCenter,
				);
			}
		} catch (error) {
			console.warn(`[bootty] Failed to open file: ${path}`, error);
		}
	}

	private async handleBatchCheckFileExists(
		terminalId: TerminalId,
		batchId: number,
		paths: string[],
	): Promise<void> {
		const instance = this.terminals.get(terminalId);
		if (!instance) return;

		// Check all paths in parallel
		const results = await Promise.all(
			paths.map(async (path) => {
				try {
					await vscode.workspace.fs.stat(vscode.Uri.file(path));
					return { path, exists: true };
				} catch {
					return { path, exists: false };
				}
			}),
		);

		this.postToTerminal(terminalId, {
			type: "batch-file-exists-result",
			batchId,
			results,
		});
	}

	private handleTerminalBell(_id: TerminalId): void {
		// Bell indicator is now handled in the webview terminal list
		// No status bar notification needed - matches VS Code's native behavior
	}

	private handlePtyExit(id: TerminalId, exitCode: number): void {
		const instance = this.terminals.get(id);
		if (!instance) return;

		// Notify webview of exit (shows "[Process exited with code N]")
		this.postToTerminal(id, {
			type: "pty-exit",
			terminalId: id,
			exitCode,
		});

		// Close panel after brief delay to allow user to see exit message
		// (Aligns with success criteria: "Exit command closes terminal cleanly")
		setTimeout(() => {
			this.destroyTerminal(id);
		}, EXIT_CLOSE_DELAY_MS);
	}

	private handlePtyError(id: TerminalId, error: Error): void {
		const instance = this.terminals.get(id);
		if (!instance) return;

		// "read EIO" is expected when PTY closes (shell exited) - don't show as error
		const isExpectedClose =
			error.message.includes("EIO") || error.message.includes("EOF");
		if (!isExpectedClose) {
			vscode.window.showErrorMessage(`Terminal error: ${error.message}`);
		}
		this.destroyTerminal(id);
	}

	private destroyTerminal(id: TerminalId): void {
		// Idempotency guard: remove from map FIRST to prevent re-entry
		const instance = this.terminals.get(id);
		if (!instance) return; // Already destroyed
		this.terminals.delete(id);

		// Clean up renderer info for this terminal
		this.rendererInfo.delete(id);
		const benchmarkWatcher = this.benchmarkWatchers.get(id);
		if (benchmarkWatcher) {
			this.benchmarkWatchers.delete(id);
			benchmarkWatcher.reject(
				new Error(`Benchmark cancelled: terminal ${id} destroyed.`),
			);
		}
		const commandWatcher = this.benchmarkCommandWatchers.get(id);
		if (commandWatcher) {
			this.benchmarkCommandWatchers.delete(id);
			commandWatcher.reject(
				new Error(`Benchmark command cancelled: terminal ${id} destroyed.`),
			);
		}
		const drainWatcher = this.benchmarkDrainWatchers.get(id);
		if (drainWatcher) {
			this.benchmarkDrainWatchers.delete(id);
			drainWatcher.reject(
				new Error(`Benchmark drain cancelled: terminal ${id} destroyed.`),
			);
		}

		// Release index for reuse
		this.releaseIndex(instance.index);

		// Remove from terminal order
		const orderIndex = this.terminalOrder.indexOf(id);
		if (orderIndex >= 0) {
			this.terminalOrder.splice(orderIndex, 1);
		}

		// Remove from any group
		const groupId = this.terminalToGroup.get(id);
		if (groupId) {
			const group = this.groups.get(groupId);
			if (group) {
				const idx = group.terminals.indexOf(id);
				if (idx >= 0) {
					group.terminals.splice(idx, 1);
				}
				// Dissolve group if only 1 terminal left
				if (group.terminals.length <= 1) {
					for (const tid of group.terminals) {
						this.terminalToGroup.delete(tid);
					}
					this.groups.delete(groupId);
					this.panelProvider.postMessage({
						type: "group-destroyed",
						groupId,
					});
				} else {
					// Group still has 2+ members - send update to webview
					this.panelProvider.postMessage({
						type: "group-created",
						group: { id: groupId, terminals: group.terminals },
					});
				}
			}
			this.terminalToGroup.delete(id);
		}

		// Update active terminal if this was active
		if (this.activeTerminalId === id) {
			// Select adjacent terminal
			const remaining = this.getTerminalIds();
			this.activeTerminalId =
				remaining.length > 0 ? remaining[remaining.length - 1] : null;
		}

		// Clear ready timeout if pending
		if (instance.readyTimeout) {
			clearTimeout(instance.readyTimeout);
			instance.readyTimeout = undefined;
		}
		if (instance.outputBuffer?.flushTimer) {
			clearTimeout(instance.outputBuffer.flushTimer);
			instance.outputBuffer.flushTimer = undefined;
		}
		instance.outputBuffer = undefined;

		// Kill PTY process (safe to call if already dead)
		this.ptyService.kill(id);

		// Location-aware teardown
		if (instance.location === "editor") {
			// Editor: dispose the WebviewPanel (onDidDispose guard above prevents re-entry)
			instance.panel.dispose();
		} else {
			// Panel: just remove the tab, do NOT dispose the panel WebviewView
			this.panelProvider.removeTerminal(id);

			// Hide panel when last terminal is closed
			const remainingPanelTerminals = [...this.terminals.values()].filter(
				(t) => t.location === "panel",
			);
			if (remainingPanelTerminals.length === 0) {
				vscode.commands.executeCommand("workbench.action.closePanel");
			}

			// Persist state after terminal removal
			this.savePersistedState();
		}
	}

	/** Public method to destroy a terminal by ID (used by tree provider close handler) */
	destroyTerminalById(id: TerminalId): void {
		this.destroyTerminal(id);
	}

	/** Public method to split a terminal (used by split command) */
	splitTerminal(terminalId: TerminalId): void {
		this.handleSplitTerminal(terminalId);
	}

	/** Terminal color options with theme key mapping and fallback colors */
	private static readonly TERMINAL_COLORS: ReadonlyArray<{
		id: string; // Stored key (e.g., "red")
		label: string;
		description: string;
		themeKey: keyof TerminalTheme;
		fallback: string;
	}> = [
		{
			id: "red",
			label: "Red",
			description: "terminal.ansiRed",
			themeKey: "red",
			fallback: "#f14c4c",
		},
		{
			id: "orange",
			label: "Orange",
			description: "terminal.ansiBrightRed",
			themeKey: "brightRed",
			fallback: "#f5a623",
		},
		{
			id: "yellow",
			label: "Yellow",
			description: "terminal.ansiYellow",
			themeKey: "yellow",
			fallback: "#e2c541",
		},
		{
			id: "green",
			label: "Green",
			description: "terminal.ansiGreen",
			themeKey: "green",
			fallback: "#4fb86e",
		},
		{
			id: "blue",
			label: "Blue",
			description: "terminal.ansiBlue",
			themeKey: "blue",
			fallback: "#3b8eea",
		},
		{
			id: "purple",
			label: "Purple",
			description: "terminal.ansiBrightMagenta",
			themeKey: "brightMagenta",
			fallback: "#a95ec7",
		},
		{
			id: "magenta",
			label: "Magenta",
			description: "terminal.ansiMagenta",
			themeKey: "magenta",
			fallback: "#e3699e",
		},
		{
			id: "cyan",
			label: "Cyan",
			description: "terminal.ansiCyan",
			themeKey: "cyan",
			fallback: "#4ec9b0",
		},
	];

	/** Resolve a color key to its current hex value from theme */
	private static resolveColorKey(colorKey: string): string | undefined {
		const colorDef = TerminalManager.TERMINAL_COLORS.find(
			(c) => c.id === colorKey,
		);
		if (!colorDef) return undefined;
		const theme = resolveTerminalTheme();
		return theme[colorDef.themeKey] ?? colorDef.fallback;
	}

	/** Terminal icon options for quick pick */
	private static readonly TERMINAL_ICONS = [
		"terminal",
		"terminal-bash",
		"terminal-cmd",
		"terminal-powershell",
		"star",
		"flame",
		"bug",
		"beaker",
		"rocket",
		"heart",
		"zap",
		"cloud",
	] as const;

	/** Generate a colored circle SVG as a data URI */
	private static colorSvgDataUri(color: string): vscode.Uri {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="${color}"/></svg>`;
		const encoded = Buffer.from(svg).toString("base64");
		return vscode.Uri.parse(`data:image/svg+xml;base64,${encoded}`);
	}

	/** Handle color picker request - show VS Code quick pick */
	private async handleColorPickerRequested(
		terminalId: TerminalId,
	): Promise<void> {
		const instance = this.terminals.get(terminalId);
		if (!instance) return;

		// Get theme colors from workbench.colorCustomizations
		const theme = resolveTerminalTheme();

		// Build items with dynamically colored SVG icons
		const items: (vscode.QuickPickItem & {
			colorKey: string;
			color: string;
		})[] = TerminalManager.TERMINAL_COLORS.map((c) => {
			// Use theme color if set, otherwise fall back to default
			const color = theme[c.themeKey] ?? c.fallback;
			return {
				label: c.label,
				description: c.description,
				iconPath: TerminalManager.colorSvgDataUri(color),
				colorKey: c.id,
				color,
			};
		});

		// Add reset option (no icon)
		items.push({ label: "Reset to default", colorKey: "", color: "" });

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: "Select a color for the terminal",
		});

		if (selected) {
			// Store the color key for dynamic resolution on theme changes
			instance.colorKey = selected.colorKey || undefined;
			instance.color = selected.color || undefined;
			// Forward to webview to update list UI
			this.panelProvider.postMessage({
				type: "update-terminal-color",
				terminalId,
				color: selected.color,
			});
			this.savePersistedState();
		}
	}

	/** Handle icon picker request - show VS Code quick pick */
	private async handleIconPickerRequested(
		terminalId: TerminalId,
	): Promise<void> {
		const instance = this.terminals.get(terminalId);
		if (!instance) return;

		const items = TerminalManager.TERMINAL_ICONS.map((icon) => ({
			label: `$(${icon}) ${icon}`,
			icon,
		}));

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: "Select an icon for the terminal",
		});

		if (selected) {
			instance.icon = selected.icon;
			// Forward to webview to update list UI
			this.panelProvider.postMessage({
				type: "update-terminal-icon",
				terminalId,
				icon: selected.icon,
			});
			this.savePersistedState();
		}
	}

	/** Handle terminals reorder */
	private handleTerminalsReordered(terminalIds: TerminalId[]): void {
		// Update terminal order
		this.terminalOrder = terminalIds;
		this.savePersistedState();
	}

	/** Handle group reorder (within-group drag) */
	private handleGroupReordered(
		groupId: string,
		terminalIds: TerminalId[],
	): void {
		const group = this.groups.get(groupId);
		if (!group) return;

		// Update group's terminal order
		group.terminals = terminalIds;

		// Also update terminalOrder to reflect the new within-group order
		// Find where this group's terminals are in terminalOrder and replace them
		const groupTerminalSet = new Set(terminalIds);
		const firstGroupIndex = this.terminalOrder.findIndex((id) =>
			groupTerminalSet.has(id),
		);
		if (firstGroupIndex !== -1) {
			// Remove all group terminals from their current positions
			this.terminalOrder = this.terminalOrder.filter(
				(id) => !groupTerminalSet.has(id),
			);
			// Insert them back in the new order at the original position
			this.terminalOrder.splice(firstGroupIndex, 0, ...terminalIds);
		}

		// Send updated group back to webview so pane order updates
		this.panelProvider.postMessage({
			type: "group-created",
			group: { id: groupId, terminals: terminalIds },
		});
		this.savePersistedState();
	}

	/** Handle list width change */
	private handleListWidthChanged(width: number): void {
		this.listWidth = width;
		this.savePersistedState();
	}

	/** Rename a terminal (updates panel tab) */
	renameTerminal(id: TerminalId, title: string): void {
		const instance = this.terminals.get(id);
		if (!instance) return;

		instance.title = title;

		if (instance.location === "panel") {
			this.panelProvider.renameTerminal(id, title);
			this.savePersistedState();
		}
		// Editor terminals: title is shown in panel title, which we could also update
	}

	/** Handle split terminal request - creates a new terminal in a group with the source */
	private handleSplitTerminal(sourceTerminalId: TerminalId): void {
		const sourceInstance = this.terminals.get(sourceTerminalId);
		if (!sourceInstance || sourceInstance.location !== "panel") return;

		// Generate group ID if not already in a group
		let groupId = this.terminalToGroup.get(sourceTerminalId);
		let group: TerminalGroup;

		if (groupId) {
			// Already in a group - add to it
			group = this.groups.get(groupId)!;
		} else {
			// Create new group
			groupId = createTerminalId(); // Use same UUID generator for groups
			group = { id: groupId, terminals: [sourceTerminalId] };
			this.groups.set(groupId, group);
			this.terminalToGroup.set(sourceTerminalId, groupId);
		}

		// Create the new split terminal (with makeActive: false, inserted after source)
		const newId = this.createPanelTerminalForSplit(
			sourceInstance.currentCwd ?? getWorkspaceCwd(),
			sourceTerminalId,
		);
		if (!newId) return;

		// Add new terminal to the group (insert after source)
		const insertIndex = group.terminals.indexOf(sourceTerminalId) + 1;
		group.terminals.splice(insertIndex, 0, newId);
		this.terminalToGroup.set(newId, groupId);

		// Send group-created AFTER add-tab but with correct member list
		this.panelProvider.postMessage({
			type: "group-created",
			group: { id: groupId, terminals: group.terminals },
		});

		// Send split-terminal message
		this.panelProvider.postMessage({
			type: "split-terminal",
			terminalId: newId,
			newTerminalId: newId,
			groupId,
			insertAfter: sourceTerminalId,
		});

		// Persist state
		this.savePersistedState();
	}

	/** Handle grouping multiple selected terminals into a new group */
	private handleGroupSelectedTerminals(terminalIds: TerminalId[]): void {
		// Need at least 2 terminals to group
		if (terminalIds.length < 2) return;

		// Verify all terminals exist and are panel terminals
		const validIds: TerminalId[] = [];
		for (const id of terminalIds) {
			const instance = this.terminals.get(id);
			if (instance && instance.location === "panel") {
				validIds.push(id);
			}
		}
		if (validIds.length < 2) return;

		// Remove any selected terminals from their current groups first
		for (const id of validIds) {
			const existingGroupId = this.terminalToGroup.get(id);
			if (existingGroupId) {
				const existingGroup = this.groups.get(existingGroupId);
				if (existingGroup) {
					existingGroup.terminals = existingGroup.terminals.filter(
						(tid) => tid !== id,
					);
					if (existingGroup.terminals.length <= 1) {
						// Group is no longer valid, clean up
						for (const remainingId of existingGroup.terminals) {
							this.terminalToGroup.delete(remainingId);
						}
						this.groups.delete(existingGroupId);
						this.panelProvider.postMessage({
							type: "group-destroyed",
							groupId: existingGroupId,
						});
					} else {
						// Update the group
						this.panelProvider.postMessage({
							type: "group-created",
							group: existingGroup,
						});
					}
				}
				this.terminalToGroup.delete(id);
			}
		}

		// Create new group with all selected terminals (preserving their order in the list)
		const groupId = createTerminalId();
		const group: TerminalGroup = { id: groupId, terminals: validIds };
		this.groups.set(groupId, group);

		// Set group membership for all terminals
		for (const id of validIds) {
			this.terminalToGroup.set(id, groupId);
		}

		// Update terminalOrder: move all grouped terminals together at the first one's position
		const groupedSet = new Set(validIds);
		const firstIndex = this.terminalOrder.findIndex((id) => groupedSet.has(id));
		if (firstIndex !== -1) {
			// Remove all grouped terminals from their current positions
			this.terminalOrder = this.terminalOrder.filter(
				(id) => !groupedSet.has(id),
			);
			// Insert them back together at the first one's original position
			this.terminalOrder.splice(firstIndex, 0, ...validIds);
		}

		// Send group-created message
		this.panelProvider.postMessage({
			type: "group-created",
			group,
		});

		// Persist state
		this.savePersistedState();
	}

	/** Create a panel terminal for split (doesn't auto-activate, inserts after source) */
	private createPanelTerminalForSplit(
		cwd: string | undefined,
		insertAfter: TerminalId,
	): TerminalId | null {
		const id = createTerminalId();
		const index = this.getNextIndex();
		const title = `Terminal ${index}`;
		const instance: PanelTerminalInstance = {
			id,
			location: "panel",
			config: { cwd },
			ready: false,
			dataQueue: [],
			title,
			index,
		};
		this.terminals.set(id, instance);

		// Spawn PTY
		const spawnResult = this.spawnPty(id, { cwd });
		if (!spawnResult.ok) {
			this.terminals.delete(id);
			this.releaseIndex(index);
			return null;
		}

		// Set ready timeout
		instance.readyTimeout = setTimeout(() => {
			if (!instance.ready) {
				vscode.window.showErrorMessage(
					"Terminal failed to initialize (timeout)",
				);
				this.destroyTerminal(id);
			}
		}, READY_TIMEOUT_MS);

		// Add tab to panel WITHOUT makeActive (split doesn't change selection)
		// Pass insertAfter so the webview inserts it in the correct position
		this.panelProvider.addTerminal(id, title, false, { insertAfter });

		// Insert after source terminal in terminalOrder (not append)
		const sourceIndex = this.terminalOrder.indexOf(insertAfter);
		if (sourceIndex >= 0) {
			this.terminalOrder.splice(sourceIndex + 1, 0, id);
		} else {
			// Fallback: append if source not found
			this.terminalOrder.push(id);
		}

		return id;
	}

	/** Handle unsplit terminal request - removes terminal from its group */
	private handleUnsplitTerminal(terminalId: TerminalId): void {
		const groupId = this.terminalToGroup.get(terminalId);
		if (!groupId) return; // Not in a group

		const group = this.groups.get(groupId);
		if (!group) return;

		// Remove from group first
		const index = group.terminals.indexOf(terminalId);
		if (index >= 0) {
			group.terminals.splice(index, 1);
		}
		this.terminalToGroup.delete(terminalId);

		// Find last remaining terminal in group AFTER removal (for repositioning)
		const lastGroupTerminal =
			group.terminals.length > 0
				? group.terminals[group.terminals.length - 1]
				: undefined;

		// Reposition unsplit terminal in terminalOrder to be after the remaining group
		const currentOrderIndex = this.terminalOrder.indexOf(terminalId);
		if (currentOrderIndex >= 0) {
			this.terminalOrder.splice(currentOrderIndex, 1);
		}
		// Find the last remaining group member's position and insert after it
		if (lastGroupTerminal) {
			const lastMemberIndex = this.terminalOrder.indexOf(lastGroupTerminal);
			if (lastMemberIndex >= 0) {
				this.terminalOrder.splice(lastMemberIndex + 1, 0, terminalId);
			} else {
				this.terminalOrder.push(terminalId);
			}
		} else {
			// No remaining group members, append at end
			this.terminalOrder.push(terminalId);
		}

		// Check if group should be destroyed
		if (group.terminals.length <= 1) {
			// Destroy the group - remaining terminal becomes standalone
			for (const tid of group.terminals) {
				this.terminalToGroup.delete(tid);
			}
			this.groups.delete(groupId);
			this.panelProvider.postMessage({
				type: "group-destroyed",
				groupId,
			});
		} else {
			// Update group
			this.panelProvider.postMessage({
				type: "group-created",
				group: { id: groupId, terminals: group.terminals },
			});
		}

		// Notify webview of unsplit
		this.panelProvider.postMessage({
			type: "unsplit-terminal",
			terminalId,
		});

		// Send updated order to webview
		this.panelProvider.postMessage({
			type: "reorder-terminals",
			terminalIds: this.terminalOrder,
		});

		// Persist state
		this.savePersistedState();
	}

	/** Handle join terminal request - adds terminal to an existing group */
	private handleJoinTerminal(
		terminalId: TerminalId,
		targetGroupId: string,
	): void {
		const instance = this.terminals.get(terminalId);
		if (!instance || instance.location !== "panel") return;

		// First unsplit from current group if in one (without sending reorder yet)
		const currentGroupId = this.terminalToGroup.get(terminalId);
		if (currentGroupId) {
			this.handleUnsplitTerminalWithoutReorder(terminalId);
		}

		// Add to target group
		const targetGroup = this.groups.get(targetGroupId);
		if (!targetGroup) return;

		targetGroup.terminals.push(terminalId);
		this.terminalToGroup.set(terminalId, targetGroupId);

		// Reposition terminal in terminalOrder to be with target group
		const currentOrderIndex = this.terminalOrder.indexOf(terminalId);
		if (currentOrderIndex >= 0) {
			this.terminalOrder.splice(currentOrderIndex, 1);
		}
		// Insert after the last member of target group
		const lastTargetMember =
			targetGroup.terminals[targetGroup.terminals.length - 2]; // -2 because we just pushed
		const lastMemberIndex = this.terminalOrder.indexOf(lastTargetMember);
		if (lastMemberIndex >= 0) {
			this.terminalOrder.splice(lastMemberIndex + 1, 0, terminalId);
		} else {
			this.terminalOrder.push(terminalId);
		}

		// Notify webview
		this.panelProvider.postMessage({
			type: "group-created",
			group: { id: targetGroupId, terminals: targetGroup.terminals },
		});
		this.panelProvider.postMessage({
			type: "join-terminal",
			terminalId,
			groupId: targetGroupId,
		});
		this.panelProvider.postMessage({
			type: "reorder-terminals",
			terminalIds: this.terminalOrder,
		});

		// Persist state
		this.savePersistedState();
	}

	/** Handle unsplit without sending reorder (used by join which does its own reorder) */
	private handleUnsplitTerminalWithoutReorder(terminalId: TerminalId): void {
		const groupId = this.terminalToGroup.get(terminalId);
		if (!groupId) return;

		const group = this.groups.get(groupId);
		if (!group) return;

		// Remove from group
		const index = group.terminals.indexOf(terminalId);
		if (index >= 0) {
			group.terminals.splice(index, 1);
		}
		this.terminalToGroup.delete(terminalId);

		// Check if group should be destroyed
		if (group.terminals.length <= 1) {
			for (const tid of group.terminals) {
				this.terminalToGroup.delete(tid);
			}
			this.groups.delete(groupId);
			this.panelProvider.postMessage({
				type: "group-destroyed",
				groupId,
			});
		} else {
			this.panelProvider.postMessage({
				type: "group-created",
				group: { id: groupId, terminals: group.terminals },
			});
		}

		this.panelProvider.postMessage({
			type: "unsplit-terminal",
			terminalId,
		});
	}

	/** Load persisted state from workspaceState */
	private loadPersistedState(): void {
		const state =
			this.context.workspaceState.get<PersistedWorkspaceState>(STATE_KEY);
		if (!state) return;

		// Restore list width
		this.listWidth = state.listWidth ?? 180;

		// Store terminals for hydration (they'll be recreated when panel is ready)
		this.persistedTerminals = state.terminals ?? [];

		// Pre-populate usedIndices from persisted terminals to avoid duplicate numbering
		for (const terminal of this.persistedTerminals) {
			if (terminal.index !== undefined) {
				this.usedIndices.add(terminal.index);
			}
		}

		// Restore groups (but don't rebuild terminalToGroup yet - terminals don't exist)
		// Groups will be sent to webview during hydration
		for (const group of state.groups) {
			this.groups.set(group.id, {
				id: group.id,
				terminals: [...group.terminals],
			});
		}

		// Restore active terminal ID (will be used during hydration)
		this.activeTerminalId = state.activeTerminalId ?? null;
	}

	/** Save state to workspaceState */
	private savePersistedState(): void {
		const terminals: PersistedTerminalState[] = [];

		for (let i = 0; i < this.terminalOrder.length; i++) {
			const id = this.terminalOrder[i];
			const instance = this.terminals.get(id);
			if (instance && instance.location === "panel") {
				terminals.push({
					id,
					index: instance.index,
					userTitle: instance.title,
					icon: instance.icon,
					colorKey: instance.colorKey,
					color: instance.color, // Keep for backward compat
					groupId: this.terminalToGroup.get(id),
					orderIndex: i,
				});
			}
		}

		const groups: TerminalGroup[] = Array.from(this.groups.values());

		const state: PersistedWorkspaceState = {
			terminals,
			groups,
			activeTerminalId: this.activeTerminalId ?? undefined,
			listWidth: this.listWidth,
		};

		this.context.workspaceState.update(STATE_KEY, state);
	}

	/** Get ordered terminal IDs for panel terminals */
	getTerminalIds(): TerminalId[] {
		return this.terminalOrder.filter((id) => {
			const instance = this.terminals.get(id);
			return instance?.location === "panel";
		});
	}

	/** Get terminal IDs for editor terminals */
	getEditorTerminalIds(): TerminalId[] {
		const ids: TerminalId[] = [];
		for (const [id, instance] of this.terminals) {
			if (instance.location === "editor") {
				ids.push(id);
			}
		}
		return ids;
	}

	/** Get the active terminal ID */
	getActiveTerminalId(): TerminalId | undefined {
		return this.activeTerminalId ?? undefined;
	}

	/** Handle panel-ready by recreating terminals and sending hydration state */
	handlePanelReady(): void {
		// Send hydrate-state with UI configuration
		this.panelProvider.postMessage({
			type: "hydrate-state",
			listWidth: this.listWidth,
		});

		// Send current runtime config BEFORE creating terminals
		// This ensures new terminals use the latest renderer setting
		const config = this.getRuntimeConfig();
		this.panelProvider.postMessage({
			type: "update-config",
			config,
		});
		if (this.profileSession) {
			this.panelProvider.postMessage({
				type: "profile-start",
				sessionId: this.profileSession.sessionId,
			});
		}

		// Recreate terminals from persisted state (add-tab includes groupId)
		const savedActiveId = this.activeTerminalId;
		for (const persisted of this.persistedTerminals) {
			const newId = this.createPanelTerminalForHydration(persisted);
			if (newId && persisted.groupId) {
				// Rebuild terminalToGroup mapping
				this.terminalToGroup.set(newId, persisted.groupId);
			}
		}

		// Send group-created AFTER add-tab messages so webview has terminals
		for (const group of this.groups.values()) {
			this.panelProvider.postMessage({
				type: "group-created",
				group: { id: group.id, terminals: group.terminals },
			});
		}

		// Clear persisted terminals (they've been recreated)
		this.persistedTerminals = [];

		// Auto-create a terminal if none exist (fresh start or all previously killed)
		const panelTerminals = [...this.terminals.values()].filter(
			(t) => t.location === "panel",
		);
		if (panelTerminals.length === 0) {
			this.createPanelTerminal();
			return; // createPanelTerminal handles activation
		}

		// Activate the saved active terminal
		if (savedActiveId && this.terminals.has(savedActiveId)) {
			this.panelProvider.postMessage({
				type: "activate-tab",
				terminalId: savedActiveId,
			});
			this.panelProvider.postMessage({
				type: "focus-terminal",
			});
		}
	}

	/** Create a panel terminal for hydration (doesn't auto-activate) */
	private createPanelTerminalForHydration(
		persisted: PersistedTerminalState,
	): TerminalId | null {
		const id = persisted.id; // Use the persisted ID
		// Use persisted index if available; indices were pre-populated in loadPersistedState
		const index = persisted.index ?? this.getNextIndex();
		const title = persisted.userTitle ?? `Terminal ${index}`;
		// Resolve color: prefer colorKey (dynamic), fall back to legacy color (static)
		const colorKey = persisted.colorKey;
		const color = colorKey
			? TerminalManager.resolveColorKey(colorKey)
			: persisted.color;
		const instance: PanelTerminalInstance = {
			id,
			location: "panel",
			config: {},
			ready: false,
			dataQueue: [],
			title,
			index,
			icon: persisted.icon,
			colorKey,
			color,
		};
		this.terminals.set(id, instance);

		// Spawn PTY (use workspace cwd since we don't persist cwd)
		const spawnResult = this.spawnPty(id, { cwd: getWorkspaceCwd() });
		if (!spawnResult.ok) {
			this.terminals.delete(id);
			this.releaseIndex(index);
			return null;
		}

		// Set ready timeout
		instance.readyTimeout = setTimeout(() => {
			if (!instance.ready) {
				vscode.window.showErrorMessage(
					"Terminal failed to initialize (timeout)",
				);
				this.destroyTerminal(id);
			}
		}, READY_TIMEOUT_MS);

		// Add tab to panel with all customizations in one message
		this.panelProvider.addTerminal(id, title, false, {
			icon: persisted.icon,
			color,
			groupId: persisted.groupId,
		});

		// Add to terminal order
		this.terminalOrder.push(id);

		return id;
	}

	dispose(): void {
		// Save state before disposing
		this.savePersistedState();

		if (this.profileSession) {
			void this.stopProfiling().catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				this.outputChannel.appendLine(
					`[bootty] Profiling stop failed during dispose: ${message}`,
				);
			});
		}

		for (const [id, instance] of this.terminals) {
			if (instance.readyTimeout) {
				clearTimeout(instance.readyTimeout);
			}
			this.ptyService.kill(id);
			if (instance.location === "editor") {
				instance.panel.dispose();
			}
			// Panel terminals: don't dispose panel WebviewView, just let it clean up
		}
		this.terminals.clear();
		this.ptyService.dispose();

		// Close PTY capture stream if open
		if (this.ptyCaptureEnabled) {
			this.stopPtyCapture();
		}

		this.outputChannel.dispose();
	}
}
