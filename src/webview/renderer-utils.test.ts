import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RendererBackendController } from "./renderer-utils";

describe("RendererBackendController", () => {
	const previousDocument = (globalThis as any).document;

	beforeEach(() => {
		(globalThis as any).document = {
			createElement: () => ({
				getContext: () => ({}),
			}),
		};
	});

	afterEach(() => {
		(globalThis as any).document = previousDocument;
	});

	test("swaps from WebGL to Canvas on context loss when host supports runtime swap", () => {
		const setRenderer = vi.fn();
		const controller = new RendererBackendController({
			mode: "auto",
			createWebglRenderer: () => ({ backend: "webgl" }),
		});

		const initial = controller.initialize();
		expect(initial.type).toBe("webgl");

		controller.bindHost({ setRenderer });
		controller.handleWebglContextLoss();

		expect(setRenderer).toHaveBeenCalledTimes(1);
		expect(setRenderer).toHaveBeenCalledWith(undefined);
		expect(controller.getState()).toEqual({
			type: "canvas",
			status: "active",
			fallback: true,
			reason: "WebGL context lost after repeated failures",
		});
	});

	test("queues fallback until host is bound", () => {
		const setRenderer = vi.fn();
		const controller = new RendererBackendController({
			mode: "auto",
			createWebglRenderer: () => ({ backend: "webgl" }),
		});

		controller.initialize();
		controller.handleWebglContextLoss();
		expect(controller.getState().status).toBe("degraded");
		expect(controller.getState().type).toBe("webgl");

		controller.bindHost({ setRenderer });
		expect(setRenderer).toHaveBeenCalledTimes(1);
		expect(controller.getState().type).toBe("canvas");
		expect(controller.getState().status).toBe("active");
	});
});
