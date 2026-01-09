#!/usr/bin/env node
/**
 * Pre-publish check to verify all required native prebuilds exist.
 * Runs before vsce package to prevent shipping incomplete extensions.
 */

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PREBUILDS_DIR = join(__dirname, "..", "node_modules", "node-pty", "prebuilds");

/** Required prebuilds for a complete release */
const REQUIRED_PREBUILDS = [
	// Linux glibc (Docker-built)
	"linux-x64/pty.node",
	"linux-arm64/pty.node",
	// npm-provided (should always exist after npm install)
	"darwin-x64/pty.node",
	"darwin-arm64/pty.node",
	"win32-x64/pty.node",
	"win32-arm64/pty.node",
];

const colors = {
	reset: "\x1b[0m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
};

console.log("\nChecking native prebuilds...\n");

const missing = [];
const found = [];

for (const prebuild of REQUIRED_PREBUILDS) {
	const fullPath = join(PREBUILDS_DIR, prebuild);
	if (existsSync(fullPath)) {
		found.push(prebuild);
		console.log(`${colors.green}  ✓${colors.reset} ${prebuild}`);
	} else {
		missing.push(prebuild);
		console.log(`${colors.red}  ✗${colors.reset} ${prebuild} ${colors.red}(MISSING)${colors.reset}`);
	}
}

console.log("");

if (missing.length > 0) {
	console.log(`${colors.red}ERROR: Missing ${missing.length} prebuild(s).${colors.reset}`);
	console.log(`\nRun the following to build missing Linux prebuilds:`);
	console.log(`  npm run build:native\n`);
	process.exit(1);
} else {
	console.log(`${colors.green}All ${found.length} prebuilds present.${colors.reset}\n`);
}
