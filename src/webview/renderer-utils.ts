/**
 * Renderer selection utilities for BooTTY webviews.
 * Handles WebGL2 detection, renderer creation, and fallback logic.
 */

import type { RendererMode, RendererType } from "../types/messages";

/** Result of renderer creation */
export interface RendererResult {
	renderer: unknown;
	type: RendererType;
	fallback: boolean;
	reason?: string;
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

/**
 * Create the appropriate renderer based on mode and availability.
 *
 * @param mode - The renderer mode from settings ('auto', 'webgl', 'canvas')
 * @param webglRendererFactory - Factory function to create WebGLRenderer (imported dynamically)
 * @returns RendererResult with the created renderer and metadata
 */
export function createRenderer(
	mode: RendererMode,
	webglRendererFactory: (() => unknown) | null,
): RendererResult {
	// Canvas forced - skip WebGL entirely
	if (mode === "canvas") {
		return {
			renderer: undefined,
			type: "canvas",
			fallback: false,
			reason: "Canvas mode forced by setting",
		};
	}

	// Check WebGL2 availability
	const webgl2Available = isWebGL2Available();

	// WebGL forced but not available - error
	if (mode === "webgl" && !webgl2Available) {
		throw new Error(
			"WebGL2 is not available in this environment, but 'webgl' mode was forced",
		);
	}

	// Auto mode and WebGL2 not available - use Canvas
	if (mode === "auto" && !webgl2Available) {
		return {
			renderer: undefined,
			type: "canvas",
			fallback: true,
			reason: "WebGL2 not available",
		};
	}

	// Try to create WebGL renderer
	if (webglRendererFactory) {
		try {
			const renderer = webglRendererFactory();
			return {
				renderer,
				type: "webgl",
				fallback: false,
			};
		} catch (err) {
			// Auto mode - fall back to Canvas
			if (mode === "auto") {
				return {
					renderer: undefined,
					type: "canvas",
					fallback: true,
					reason: `WebGL renderer creation failed: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
			// WebGL forced - propagate error
			throw err;
		}
	}

	// No WebGL renderer factory available
	// At this point mode is either "auto" or "webgl"
	if (mode === "webgl") {
		// WebGL forced but factory missing - error per setting semantics
		throw new Error("WebGL mode was forced, but WebGL renderer is not bundled");
	}

	// Auto mode - fall back to Canvas
	return {
		renderer: undefined,
		type: "canvas",
		fallback: true,
		reason: "WebGL renderer not bundled",
	};
}
