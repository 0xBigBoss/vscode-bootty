/**
 * File existence cache with TTL
 * Extracted from webview/main.ts for testability
 */

export interface CacheEntry {
	exists: boolean;
	timestamp: number;
}

export interface FileCache {
	get(path: string): boolean | undefined;
	set(path: string, exists: boolean): void;
	clear(): void;
	size(): number;
}

/**
 * Create a file existence cache with TTL
 * @param ttlMs - Time-to-live for cache entries in milliseconds
 * @param maxSize - Maximum number of entries before eviction
 */
export function createFileCache(
	ttlMs: number = 5000,
	maxSize: number = 100,
): FileCache {
	const cache = new Map<string, CacheEntry>();

	return {
		get(path: string): boolean | undefined {
			const entry = cache.get(path);
			if (!entry) return undefined;

			// Check if entry is expired
			if (Date.now() - entry.timestamp > ttlMs) {
				cache.delete(path);
				return undefined;
			}

			// LRU: move to end on access (delete and re-add to refresh position)
			cache.delete(path);
			cache.set(path, entry);

			return entry.exists;
		},

		set(path: string, exists: boolean): void {
			// LRU: if key exists, delete first to refresh position (avoids evicting unrelated keys)
			if (cache.has(path)) {
				cache.delete(path);
			} else if (cache.size >= maxSize) {
				// Only evict if adding new key and at capacity
				const firstKey = cache.keys().next().value;
				if (firstKey) cache.delete(firstKey);
			}
			cache.set(path, { exists, timestamp: Date.now() });
		},

		clear(): void {
			cache.clear();
		},

		size(): number {
			return cache.size;
		},
	};
}

/**
 * Path resolution utilities for terminal file links
 */

/**
 * Check if a path is absolute (Unix or Windows)
 */
export function isAbsolutePath(path: string): boolean {
	return path.startsWith("/") || /^[a-zA-Z]:/.test(path);
}

/**
 * Strip git diff prefixes (a/ or b/) from paths
 */
export function stripGitDiffPrefix(path: string): string {
	if (path.startsWith("a/") || path.startsWith("b/")) {
		return path.slice(2);
	}
	return path;
}

/**
 * Resolve a path relative to a CWD
 * Returns the original path if already absolute
 */
export function resolvePath(path: string, cwd?: string): string {
	// Already absolute
	if (isAbsolutePath(path)) {
		return path;
	}
	// Strip git diff prefixes
	path = stripGitDiffPrefix(path);
	// Resolve relative to CWD
	if (cwd) {
		return `${cwd}/${path}`;
	}
	return path;
}

/**
 * Detect if running on Windows
 */
export function isWindowsPlatform(navigator: { platform: string }): boolean {
	// Match Win32, Win64, Windows - but not darwin which contains 'win'
	const platform = navigator.platform.toUpperCase();
	return platform.startsWith("WIN");
}

/**
 * Convert a file:// URI to a filesystem path
 * Handles URL-encoded characters and platform differences
 */
export function fileUriToPath(uri: string): string | null {
	if (!uri.startsWith("file://")) {
		return null;
	}

	// Remove 'file://' prefix
	let path = uri.slice(7);

	// URL-decode the path (handles %20 for spaces, etc.)
	path = decodeURIComponent(path);

	// On Unix, file:///path/to/file -> /path/to/file (3 slashes, path starts with /)
	// On Windows, file:///C:/path -> C:/path (3 slashes, then drive letter)
	// Check for Windows drive letter pattern
	if (/^\/[a-zA-Z]:/.test(path)) {
		// Remove leading slash for Windows paths: /C:/... -> C:/...
		path = path.slice(1);
	}

	return path;
}

/**
 * Extract file paths from a DataTransfer object
 * Handles both Finder/external drops (via file.path) and VS Code Explorer drops (via text/uri-list)
 */
export function extractPathsFromDataTransfer(
	dataTransfer: DataTransfer,
): string[] {
	const paths: string[] = [];

	// First try: files from Finder/Desktop (VS Code adds .path to File objects)
	const files = dataTransfer.files;
	if (files && files.length > 0) {
		for (let i = 0; i < files.length; i++) {
			const file = files[i];
			const path = (file as File & { path?: string }).path;
			if (path) {
				paths.push(path);
			}
		}
	}

	// Second try: text/uri-list format (VS Code Explorer drag + Shift key)
	// Only if we didn't get paths from files
	if (paths.length === 0) {
		const uriList = dataTransfer.getData("text/uri-list");
		if (uriList) {
			// text/uri-list contains one URI per line, lines starting with # are comments
			const lines = uriList.split(/\r?\n/);
			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed && !trimmed.startsWith("#")) {
					const filePath = fileUriToPath(trimmed);
					if (filePath) {
						paths.push(filePath);
					}
				}
			}
		}
	}

	return paths;
}

/**
 * Quote a shell path if it contains special characters
 * Uses POSIX single-quoting for Unix shells, double-quoting for Windows cmd.exe
 */
export function quoteShellPath(
	path: string,
	isWindows: boolean = false,
): string {
	if (isWindows) {
		// Windows cmd.exe: use double quotes, escape internal double quotes with ^
		// Backslashes are literal in cmd.exe (not escape chars)
		if (/[\s"&|<>()^]/.test(path)) {
			return `"${path.replace(/"/g, '^"')}"`;
		}
		return path;
	}
	// POSIX shells: use single quotes, escape internal single quotes
	if (/[\s"'$`\\!&;|<>()]/.test(path)) {
		return `'${path.replace(/'/g, "'\\''")}'`;
	}
	return path;
}
