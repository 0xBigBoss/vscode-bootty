import * as fs from "node:fs";
import * as path from "node:path";
import * as esbuild from "esbuild";

const isWatch = process.argv.includes("--watch");
const isProd = process.env.NODE_ENV === "production";

// Extension bundle (Node.js, CommonJS)
const extensionConfig = {
	entryPoints: ["src/extension.ts"],
	bundle: true,
	outfile: "out/extension.js",
	platform: "node",
	external: ["vscode", "node-pty"], // Don't bundle native module
	format: "cjs",
	sourcemap: !isProd,
	minify: isProd,
	target: "node18",
};

// Webview bundle (browser, IIFE) - Editor terminals
const webviewConfig = {
	entryPoints: ["src/webview/main.ts"],
	bundle: true,
	outfile: "out/webview/main.js",
	platform: "browser",
	format: "iife",
	sourcemap: !isProd,
	minify: isProd,
	target: "es2022",
};

// Panel webview bundle (browser, IIFE) - Panel terminals
const panelWebviewConfig = {
	entryPoints: ["src/webview/panel-main.ts"],
	bundle: true,
	outfile: "out/webview/panel-main.js",
	platform: "browser",
	format: "iife",
	sourcemap: !isProd,
	minify: isProd,
	target: "es2022",
};

// PTY drain worker bundle (browser, classic script)
const ptyDrainWorkerConfig = {
	entryPoints: ["src/webview/pty-drain-worker.ts"],
	bundle: true,
	outfile: "out/webview/pty-drain-worker.js",
	platform: "browser",
	format: "iife",
	sourcemap: !isProd,
	minify: isProd,
	target: "es2022",
};

async function build() {
	try {
		// Clean out directory before build (cross-platform)
		const outDir = path.join(process.cwd(), "out");
		try {
			await fs.promises.rm(outDir, { recursive: true, force: true });
		} catch {
			// Ignore if doesn't exist or can't remove
		}

		// Build extension
		if (isWatch) {
			const extensionCtx = await esbuild.context(extensionConfig);
			await extensionCtx.watch();
			console.log("[esbuild] Watching extension...");
		} else {
			await esbuild.build(extensionConfig);
			console.log("[esbuild] Extension built.");
		}

		// Build webview (if entry exists)
		const webviewEntry = path.join(process.cwd(), "src/webview/main.ts");
		if (fs.existsSync(webviewEntry)) {
			if (isWatch) {
				const webviewCtx = await esbuild.context(webviewConfig);
				await webviewCtx.watch();
				console.log("[esbuild] Watching webview...");
			} else {
				await esbuild.build(webviewConfig);
				console.log("[esbuild] Webview built.");
			}
		} else {
			console.log("[esbuild] Webview entry not found, skipping webview build.");
		}

		// Build panel webview (if entry exists)
		const panelWebviewEntry = path.join(
			process.cwd(),
			"src/webview/panel-main.ts",
		);
		if (fs.existsSync(panelWebviewEntry)) {
			if (isWatch) {
				const panelWebviewCtx = await esbuild.context(panelWebviewConfig);
				await panelWebviewCtx.watch();
				console.log("[esbuild] Watching panel webview...");
			} else {
				await esbuild.build(panelWebviewConfig);
				console.log("[esbuild] Panel webview built.");
			}
		} else {
			console.log(
				"[esbuild] Panel webview entry not found, skipping panel webview build.",
			);
		}

		// Build PTY drain worker (if entry exists)
		const workerEntry = path.join(
			process.cwd(),
			"src/webview/pty-drain-worker.ts",
		);
		if (fs.existsSync(workerEntry)) {
			if (isWatch) {
				const workerCtx = await esbuild.context(ptyDrainWorkerConfig);
				await workerCtx.watch();
				console.log("[esbuild] Watching PTY drain worker...");
			} else {
				await esbuild.build(ptyDrainWorkerConfig);
				console.log("[esbuild] PTY drain worker built.");
			}
		} else {
			console.log(
				"[esbuild] PTY drain worker entry not found, skipping worker build.",
			);
		}

		// Copy static files
		const templateSrc = path.join(process.cwd(), "src/webview/template.html");
		const stylesSrc = path.join(process.cwd(), "src/webview/styles.css");
		const panelTemplateSrc = path.join(
			process.cwd(),
			"src/webview/panel-template.html",
		);
		const panelStylesSrc = path.join(
			process.cwd(),
			"src/webview/panel-styles.css",
		);
		const outWebview = path.join(process.cwd(), "out/webview");

		function copyStaticFiles() {
			if (!fs.existsSync(outWebview)) {
				fs.mkdirSync(outWebview, { recursive: true });
			}
			if (fs.existsSync(templateSrc)) {
				fs.copyFileSync(templateSrc, path.join(outWebview, "template.html"));
			}
			if (fs.existsSync(stylesSrc)) {
				fs.copyFileSync(stylesSrc, path.join(outWebview, "styles.css"));
			}
			if (fs.existsSync(panelTemplateSrc)) {
				fs.copyFileSync(
					panelTemplateSrc,
					path.join(outWebview, "panel-template.html"),
				);
			}
			if (fs.existsSync(panelStylesSrc)) {
				fs.copyFileSync(
					panelStylesSrc,
					path.join(outWebview, "panel-styles.css"),
				);
			}
		}

		copyStaticFiles();
		console.log("[esbuild] Static files copied.");

		// Watch static files in dev mode
		if (isWatch) {
			fs.watch(path.dirname(templateSrc), (_eventType, filename) => {
				if (
					filename === "template.html" ||
					filename === "styles.css" ||
					filename === "panel-template.html" ||
					filename === "panel-styles.css"
				) {
					copyStaticFiles();
					console.log(`[esbuild] Static file ${filename} updated.`);
				}
			});
		}
	} catch (error) {
		console.error("[esbuild] Build failed:", error);
		process.exit(1);
	}
}

build();
