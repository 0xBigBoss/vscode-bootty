#!/usr/bin/env node
/**
 * Cross-platform native build script for node-pty
 *
 * Builds Linux native binaries using Docker for glibc and musl targets.
 * Preserves existing darwin and win32 prebuilds from npm.
 *
 * Usage:
 *   npm run build:native                           # Build all Linux platforms
 *   npm run build:native -- --platform linux-x64   # Build specific platform
 *   npm run build:native -- --force                # Force rebuild (ignore cache)
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const NODE_PTY_DIR = join(PROJECT_ROOT, "node_modules", "node-pty");
const PREBUILDS_DIR = join(NODE_PTY_DIR, "prebuilds");

/** Platform configurations
 * Using node:20-bullseye for glibc builds (glibc 2.31, Debian 11).
 * Debian 10 (buster) is EOL with unavailable repos. Bullseye is the oldest
 * maintained Debian with working repos and modern Python for node-gyp.
 */
const PLATFORMS = {
	"linux-x64": {
		dockerPlatform: "linux/amd64",
		image: "node:20-bullseye",
		deps: "apt-get update && apt-get install -y python3 make g++",
		prebuildDir: "linux-x64",
	},
	"linux-arm64": {
		dockerPlatform: "linux/arm64",
		image: "node:20-bullseye",
		deps: "apt-get update && apt-get install -y python3 make g++",
		prebuildDir: "linux-arm64",
	},
	"linux-x64-musl": {
		dockerPlatform: "linux/amd64",
		image: "node:20-alpine",
		deps: "apk add --no-cache python3 make g++",
		prebuildDir: "linux-x64-musl",
	},
	"linux-arm64-musl": {
		dockerPlatform: "linux/arm64",
		image: "node:20-alpine",
		deps: "apk add --no-cache python3 make g++",
		prebuildDir: "linux-arm64-musl",
	},
};

const VALID_PLATFORMS = Object.keys(PLATFORMS);

/** ANSI color codes */
const colors = {
	reset: "\x1b[0m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	dim: "\x1b[2m",
};

function log(message, color = "") {
	console.log(`${color}${message}${colors.reset}`);
}

function logStep(step, message) {
	log(`[${step}] ${message}`, colors.blue);
}

function logSuccess(message) {
	log(`  ${message}`, colors.green);
}

function logError(message) {
	log(`  ${message}`, colors.red);
}

function logWarn(message) {
	log(`  ${message}`, colors.yellow);
}

/** Check if Docker is available */
function checkDocker() {
	try {
		execSync("docker --version", { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

/** Get current user ID for Docker --user flag (avoids root-owned files) */
function getUserId() {
	try {
		const uid = execSync("id -u", { stdio: "pipe" }).toString().trim();
		const gid = execSync("id -g", { stdio: "pipe" }).toString().trim();
		return `${uid}:${gid}`;
	} catch {
		return null; // Fall back to root on Windows or if id command fails
	}
}

/** Check if a prebuild already exists */
function prebuildExists(platform) {
	const config = PLATFORMS[platform];
	const prebuildPath = join(PREBUILDS_DIR, config.prebuildDir, "pty.node");
	return existsSync(prebuildPath);
}

/** Run Docker command and stream output */
function runDocker(args, options = {}) {
	return new Promise((resolve, reject) => {
		const proc = spawn("docker", args, {
			stdio: ["inherit", "pipe", "pipe"],
			...options,
		});

		let stdout = "";
		let stderr = "";

		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
			if (options.verbose) {
				process.stdout.write(colors.dim + data.toString() + colors.reset);
			}
		});

		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
			if (options.verbose) {
				process.stderr.write(colors.dim + data.toString() + colors.reset);
			}
		});

		proc.on("close", (code) => {
			if (code === 0) {
				resolve({ stdout, stderr });
			} else {
				reject(new Error(`Docker command failed with code ${code}\n${stderr}`));
			}
		});

		proc.on("error", reject);
	});
}

/** Build native binary for a platform */
async function buildPlatform(platform, verbose) {
	const config = PLATFORMS[platform];
	logStep(platform, `Building for ${platform}...`);

	// Get host user ID to fix file ownership after build
	const userId = getUserId();
	const chownCmd = userId ? `chown -R ${userId} /project/node_modules/node-pty/build /project/node_modules/node-pty/prebuilds/${config.prebuildDir}` : "true";

	// Build command that runs inside Docker
	const buildScript = `
		set -e
		${config.deps}
		cd /project/node_modules/node-pty
		npm install node-addon-api 2>/dev/null || true
		npm rebuild
		mkdir -p /project/node_modules/node-pty/prebuilds/${config.prebuildDir}
		cp build/Release/pty.node /project/node_modules/node-pty/prebuilds/${config.prebuildDir}/
		${chownCmd}
		echo "Build complete for ${platform}"
	`;

	const args = [
		"run",
		"--rm",
		"--platform",
		config.dockerPlatform,
		"-v",
		`${PROJECT_ROOT}:/project`,
		"-w",
		"/project",
		config.image,
		"sh",
		"-c",
		buildScript,
	];

	await runDocker(args, { verbose });
	logSuccess(`Built ${platform}`);
}

/** Smoke test a built binary */
async function smokeTest(platform, verbose) {
	const config = PLATFORMS[platform];
	logStep(platform, `Smoke testing ${platform}...`);

	const testScript = `
		node -e "
			try {
				const binding = require('/project/node_modules/node-pty/prebuilds/${config.prebuildDir}/pty.node');
				console.log('Binding loaded successfully');
				process.exit(0);
			} catch (e) {
				console.error('Failed to load binding:', e.message);
				process.exit(1);
			}
		"
	`;

	const args = [
		"run",
		"--rm",
		"--platform",
		config.dockerPlatform,
		"-v",
		`${PROJECT_ROOT}:/project:ro`,
		config.image,
		"sh",
		"-c",
		testScript,
	];

	await runDocker(args, { verbose });
	logSuccess(`Smoke test passed for ${platform}`);
}

/** Main entry point */
async function main() {
	// Parse arguments
	const { values } = parseArgs({
		options: {
			platform: { type: "string", short: "p" },
			force: { type: "boolean", short: "f", default: false },
			verbose: { type: "boolean", short: "v", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
		allowPositionals: false,
	});

	if (values.help) {
		console.log(`
Usage: npm run build:native [options]

Options:
  -p, --platform <platforms>  Comma-separated list of platforms to build
                              Valid: ${VALID_PLATFORMS.join(", ")}
  -f, --force                 Force rebuild even if prebuild exists
  -v, --verbose               Show detailed build output
  -h, --help                  Show this help message

Examples:
  npm run build:native                           # Build all Linux platforms
  npm run build:native -- --platform linux-x64   # Build specific platform
  npm run build:native -- --force                # Force rebuild all
`);
		process.exit(0);
	}

	// Check Docker
	log("\nCross-platform native build for node-pty\n", colors.blue);

	if (!checkDocker()) {
		logError("Docker is not available.");
		console.log(`
To install Docker:
  macOS:  brew install --cask docker
  Linux:  https://docs.docker.com/engine/install/
  Windows: https://docs.docker.com/desktop/install/windows-install/

Then start Docker Desktop or the Docker daemon.
`);
		process.exit(1);
	}
	logSuccess("Docker is available");

	// Determine platforms to build
	let platforms = VALID_PLATFORMS;
	if (values.platform) {
		platforms = values.platform.split(",").map((p) => p.trim());
		for (const p of platforms) {
			if (!VALID_PLATFORMS.includes(p)) {
				logError(`Unknown platform: ${p}`);
				console.log(`Valid platforms: ${VALID_PLATFORMS.join(", ")}`);
				process.exit(1);
			}
		}
	}

	log(`\nPlatforms to build: ${platforms.join(", ")}\n`);

	// Check cache and filter platforms
	if (!values.force) {
		const cached = [];
		const toBuild = [];
		for (const p of platforms) {
			if (prebuildExists(p)) {
				cached.push(p);
			} else {
				toBuild.push(p);
			}
		}
		if (cached.length > 0) {
			logWarn(`Skipping cached: ${cached.join(", ")} (use --force to rebuild)`);
		}
		platforms = toBuild;
	}

	if (platforms.length === 0) {
		log("\nAll platforms already built. Use --force to rebuild.\n", colors.green);
		process.exit(0);
	}

	// Ensure prebuilds directory exists
	mkdirSync(PREBUILDS_DIR, { recursive: true });

	// Build each platform
	const startTime = Date.now();
	for (const platform of platforms) {
		try {
			await buildPlatform(platform, values.verbose);
			await smokeTest(platform, values.verbose);
		} catch (error) {
			logError(`Failed to build ${platform}`);
			console.error(error.message);
			process.exit(1);
		}
	}

	const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
	log(`\nAll platforms built successfully in ${elapsed}s\n`, colors.green);

	// Summary
	console.log("Prebuilds created:");
	for (const platform of platforms) {
		const config = PLATFORMS[platform];
		console.log(`  ${PREBUILDS_DIR}/${config.prebuildDir}/pty.node`);
	}
	console.log("");
}

main().catch((error) => {
	logError("Unexpected error:");
	console.error(error);
	process.exit(1);
});
