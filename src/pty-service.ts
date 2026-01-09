import * as fs from "node:fs";
import * as pty from "node-pty";
import * as vscode from "vscode";
import type { TerminalConfig, TerminalId } from "./types/terminal";

/** Result of spawn attempt */
export type SpawnResult = { ok: true } | { ok: false; error: string };

/** PTY event handlers */
export interface PtyHandlers {
	onData: (data: string) => void;
	onExit: (code: number) => void;
	onError: (error: Error) => void; // Runtime errors (e.g., process crash)
}

interface PtyInstance {
	id: TerminalId;
	process: pty.IPty;
}

export class PtyService implements vscode.Disposable {
	private instances = new Map<TerminalId, PtyInstance>();

	/** Get the default shell for the current platform */
	private getDefaultShell(): string {
		if (process.platform === "win32") {
			return process.env.COMSPEC || "cmd.exe";
		}

		// Try VS Code's terminal profile setting first (platform-specific)
		const terminalConfig = vscode.workspace.getConfiguration(
			"terminal.integrated",
		);
		const profileKey =
			process.platform === "darwin" ? "osx" : process.platform;
		const profileName = terminalConfig.get<string>(
			`defaultProfile.${profileKey}`,
		);
		if (profileName) {
			const profiles = terminalConfig.get<
				Record<string, { path?: string }>
			>(`profiles.${profileKey}`);
			const shellPath = profiles?.[profileName]?.path;
			// Only use if the shell actually exists on this system
			if (shellPath && fs.existsSync(shellPath)) {
				return shellPath;
			}
		}

		// Check if SHELL env var points to an existing file
		const envShell = process.env.SHELL;
		if (envShell && fs.existsSync(envShell)) {
			return envShell;
		}

		// Fallback to common shell locations
		const fallbackShells = ["/bin/zsh", "/bin/bash", "/bin/sh"];
		for (const shell of fallbackShells) {
			if (fs.existsSync(shell)) {
				return shell;
			}
		}

		return "/bin/sh";
	}

	/** Spawn PTY, returns error if shell/cwd invalid or native module fails */
	spawn(
		id: TerminalId,
		config: TerminalConfig,
		handlers: PtyHandlers,
	): SpawnResult {
		try {
			const shell = config.shell || this.getDefaultShell();
			const cwd = config.cwd || process.env.HOME || process.cwd();

			// Log for debugging
			console.log(`[PtyService] Spawning shell: ${shell}, cwd: ${cwd}`);

			const proc = pty.spawn(shell, [], {
				name: "xterm-256color",
				cols: config.cols || 80,
				rows: config.rows || 24,
				cwd,
				env: config.env,
			});

			// Setup listeners
			proc.onData(handlers.onData);
			proc.onExit(({ exitCode }) => handlers.onExit(exitCode));

			// Handle runtime errors (node-pty emits 'error' on process failures)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(proc as any).on?.("error", (err: Error) => {
				handlers.onError(err);
				this.kill(id); // Cleanup on error
			});

			this.instances.set(id, { id, process: proc });
			return { ok: true };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { ok: false, error: msg };
		}
	}

	/** Write data to PTY */
	write(id: TerminalId, data: string): void {
		const instance = this.instances.get(id);
		if (instance) {
			instance.process.write(data);
		}
	}

	/** Resize PTY */
	resize(id: TerminalId, cols: number, rows: number): void {
		const instance = this.instances.get(id);
		if (instance) {
			instance.process.resize(cols, rows);
		}
	}

	/** Kill PTY process */
	kill(id: TerminalId): void {
		const instance = this.instances.get(id);
		if (instance) {
			instance.process.kill();
			this.instances.delete(id);
		}
	}

	/** Dispose all PTY processes */
	dispose(): void {
		for (const [id] of this.instances) {
			this.kill(id);
		}
		this.instances.clear();
	}
}
