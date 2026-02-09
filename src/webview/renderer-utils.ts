import type {
	RendererMode,
	RendererStatus,
	RendererType,
} from "../types/messages";

/** Result of renderer creation */
export interface RendererResult {
	renderer: unknown;
	type: RendererType;
	fallback: boolean;
	reason?: string;
}

export interface RendererBackendState {
	type: RendererType;
	status: RendererStatus;
	fallback: boolean;
	reason?: string;
}

interface RendererBackendControllerOptions {
	mode: RendererMode;
	createWebglRenderer: ((onContextLoss: () => void) => unknown) | null;
	onStatusChange?: (state: RendererBackendState) => void;
}

interface RendererHost {
	setRenderer?: (renderer?: unknown) => void;
}

/** Check if WebGL2 is available in the current context */
function isWebGL2Available(): boolean {
	try {
		const canvas = document.createElement("canvas");
		const gl = canvas.getContext("webgl2");
		return gl !== null;
	} catch {
		return false;
	}
}

export class RendererBackendController {
	private readonly mode: RendererMode;
	private readonly createWebglRenderer: RendererBackendControllerOptions["createWebglRenderer"];
	private readonly onStatusChange?: (state: RendererBackendState) => void;
	private state: RendererBackendState = {
		type: "canvas",
		status: "active",
		fallback: false,
	};
	private host?: RendererHost;
	private pendingCanvasFallback = false;

	constructor(options: RendererBackendControllerOptions) {
		this.mode = options.mode;
		this.createWebglRenderer = options.createWebglRenderer;
		this.onStatusChange = options.onStatusChange;
	}

	initialize(): RendererResult {
		const result = this.selectInitialRenderer();
		this.state = {
			type: result.type,
			status: "active",
			fallback: result.fallback,
			reason: result.reason,
		};
		this.emitStatus();
		return result;
	}

	bindHost(host: RendererHost): void {
		this.host = host;
		if (this.pendingCanvasFallback) {
			this.pendingCanvasFallback = false;
			this.swapToCanvas("WebGL context lost after repeated failures");
		}
	}

	getState(): RendererBackendState {
		return { ...this.state };
	}

	handleWebglContextLoss(): void {
		if (this.state.type !== "webgl") {
			return;
		}
		this.swapToCanvas("WebGL context lost after repeated failures");
	}

	private swapToCanvas(reason: string): void {
		const host = this.host;
		if (!host?.setRenderer) {
			this.pendingCanvasFallback = true;
			this.state = {
				type: "webgl",
				status: "degraded",
				fallback: this.state.fallback,
				reason,
			};
			this.emitStatus();
			return;
		}

		try {
			host.setRenderer(undefined);
			this.state = {
				type: "canvas",
				status: "active",
				fallback: true,
				reason,
			};
		} catch (err) {
			this.state = {
				type: "webgl",
				status: "degraded",
				fallback: this.state.fallback,
				reason: `WebGL context lost and fallback swap failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
		this.emitStatus();
	}

	private emitStatus(): void {
		this.onStatusChange?.(this.getState());
	}

	private selectInitialRenderer(): RendererResult {
		if (this.mode === "canvas") {
			return {
				renderer: undefined,
				type: "canvas",
				fallback: false,
				reason: "Canvas mode forced by setting",
			};
		}

		const webgl2Available = isWebGL2Available();
		if (this.mode === "webgl" && !webgl2Available) {
			throw new Error(
				"WebGL2 is not available in this environment, but 'webgl' mode was forced",
			);
		}
		if (this.mode === "auto" && !webgl2Available) {
			return {
				renderer: undefined,
				type: "canvas",
				fallback: true,
				reason: "WebGL2 not available",
			};
		}

		if (!this.createWebglRenderer) {
			if (this.mode === "webgl") {
				throw new Error(
					"WebGL mode was forced, but WebGL renderer is not bundled",
				);
			}
			return {
				renderer: undefined,
				type: "canvas",
				fallback: true,
				reason: "WebGL renderer not bundled",
			};
		}

		try {
			const renderer = this.createWebglRenderer(() =>
				this.handleWebglContextLoss(),
			);
			return {
				renderer,
				type: "webgl",
				fallback: false,
			};
		} catch (err) {
			if (this.mode === "webgl") {
				throw err;
			}
			return {
				renderer: undefined,
				type: "canvas",
				fallback: true,
				reason: `WebGL renderer creation failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}
}
