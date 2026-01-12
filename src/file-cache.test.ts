import { describe, expect, it } from "vitest";
import {
	createFileCache,
	fileUriToPath,
	isAbsolutePath,
	isWindowsPlatform,
	quoteShellPath,
	resolvePath,
	stripGitDiffPrefix,
} from "./file-cache";

describe("file-cache", () => {
	describe("createFileCache", () => {
		it("returns undefined for non-existent entries", () => {
			const cache = createFileCache();
			expect(cache.get("/path/to/file.ts")).toBeUndefined();
		});

		it("returns cached value for existing entries", () => {
			const cache = createFileCache();
			cache.set("/path/to/file.ts", true);
			expect(cache.get("/path/to/file.ts")).toBe(true);
		});

		it("returns false when file does not exist", () => {
			const cache = createFileCache();
			cache.set("/nonexistent.ts", false);
			expect(cache.get("/nonexistent.ts")).toBe(false);
		});

		it("expires entries after TTL", async () => {
			const cache = createFileCache(50); // 50ms TTL
			cache.set("/path/to/file.ts", true);
			expect(cache.get("/path/to/file.ts")).toBe(true);

			// Wait for expiry
			await new Promise((resolve) => setTimeout(resolve, 60));
			expect(cache.get("/path/to/file.ts")).toBeUndefined();
		});

		it("evicts oldest entry when at capacity", () => {
			const cache = createFileCache(5000, 3); // Max 3 entries
			cache.set("/file1.ts", true);
			cache.set("/file2.ts", true);
			cache.set("/file3.ts", true);

			// All three should exist
			expect(cache.size()).toBe(3);

			// Add fourth - should evict first
			cache.set("/file4.ts", true);
			expect(cache.size()).toBe(3);
			expect(cache.get("/file1.ts")).toBeUndefined(); // Evicted
			expect(cache.get("/file4.ts")).toBe(true); // Added
		});

		it("refreshes entry position on get (LRU)", () => {
			const cache = createFileCache(5000, 3); // Max 3 entries
			cache.set("/file1.ts", true);
			cache.set("/file2.ts", true);
			cache.set("/file3.ts", true);

			// Access file1, moving it to end (most recently used)
			cache.get("/file1.ts");

			// Add file4 - should evict file2 (now oldest), not file1
			cache.set("/file4.ts", true);
			expect(cache.size()).toBe(3);
			expect(cache.get("/file1.ts")).toBe(true); // Still exists (was accessed)
			expect(cache.get("/file2.ts")).toBeUndefined(); // Evicted (oldest)
			expect(cache.get("/file4.ts")).toBe(true); // Added
		});

		it("does not evict when updating existing entry", () => {
			const cache = createFileCache(5000, 3); // Max 3 entries
			cache.set("/file1.ts", true);
			cache.set("/file2.ts", true);
			cache.set("/file3.ts", true);

			// Update existing entry - should NOT evict anything
			cache.set("/file1.ts", false);
			expect(cache.size()).toBe(3);
			expect(cache.get("/file1.ts")).toBe(false); // Updated value
			expect(cache.get("/file2.ts")).toBe(true); // Still exists
			expect(cache.get("/file3.ts")).toBe(true); // Still exists
		});

		it("refreshes entry position on set (LRU)", () => {
			const cache = createFileCache(5000, 3); // Max 3 entries
			cache.set("/file1.ts", true);
			cache.set("/file2.ts", true);
			cache.set("/file3.ts", true);

			// Update file1 (moves to end)
			cache.set("/file1.ts", false);

			// Add file4 - should evict file2 (now oldest)
			cache.set("/file4.ts", true);
			expect(cache.get("/file1.ts")).toBe(false); // Still exists
			expect(cache.get("/file2.ts")).toBeUndefined(); // Evicted
		});

		it("clear removes all entries", () => {
			const cache = createFileCache();
			cache.set("/file1.ts", true);
			cache.set("/file2.ts", true);
			expect(cache.size()).toBe(2);

			cache.clear();
			expect(cache.size()).toBe(0);
		});
	});

	describe("isAbsolutePath", () => {
		it("returns true for Unix absolute paths", () => {
			expect(isAbsolutePath("/home/user/file.ts")).toBe(true);
			expect(isAbsolutePath("/file.ts")).toBe(true);
		});

		it("returns true for Windows absolute paths", () => {
			expect(isAbsolutePath("C:/Users/file.ts")).toBe(true);
			expect(isAbsolutePath("D:\\Program Files\\app.exe")).toBe(true);
			expect(isAbsolutePath("c:/lowercase.txt")).toBe(true);
		});

		it("returns false for relative paths", () => {
			expect(isAbsolutePath("src/file.ts")).toBe(false);
			expect(isAbsolutePath("./file.ts")).toBe(false);
			expect(isAbsolutePath("../parent/file.ts")).toBe(false);
			expect(isAbsolutePath("file.ts")).toBe(false);
		});
	});

	describe("stripGitDiffPrefix", () => {
		it("strips a/ prefix", () => {
			expect(stripGitDiffPrefix("a/src/file.ts")).toBe("src/file.ts");
		});

		it("strips b/ prefix", () => {
			expect(stripGitDiffPrefix("b/src/file.ts")).toBe("src/file.ts");
		});

		it("leaves other paths unchanged", () => {
			expect(stripGitDiffPrefix("src/file.ts")).toBe("src/file.ts");
			expect(stripGitDiffPrefix("/absolute/file.ts")).toBe("/absolute/file.ts");
			expect(stripGitDiffPrefix("./relative.ts")).toBe("./relative.ts");
		});
	});

	describe("resolvePath", () => {
		it("returns absolute paths unchanged", () => {
			expect(resolvePath("/absolute/path.ts", "/cwd")).toBe(
				"/absolute/path.ts",
			);
			expect(resolvePath("C:/windows/path.ts", "/cwd")).toBe(
				"C:/windows/path.ts",
			);
		});

		it("resolves relative paths against CWD", () => {
			expect(resolvePath("src/file.ts", "/home/user/project")).toBe(
				"/home/user/project/src/file.ts",
			);
			expect(resolvePath("./file.ts", "/home/user")).toBe(
				"/home/user/./file.ts",
			);
		});

		it("strips git diff prefix before resolving", () => {
			expect(resolvePath("a/src/file.ts", "/project")).toBe(
				"/project/src/file.ts",
			);
			expect(resolvePath("b/src/file.ts", "/project")).toBe(
				"/project/src/file.ts",
			);
		});

		it("returns relative path when no CWD provided", () => {
			expect(resolvePath("src/file.ts")).toBe("src/file.ts");
		});
	});

	describe("quoteShellPath", () => {
		describe("POSIX (default)", () => {
			it("leaves simple paths unquoted", () => {
				expect(quoteShellPath("/home/user/file.ts")).toBe("/home/user/file.ts");
				expect(quoteShellPath("src/file.ts")).toBe("src/file.ts");
			});

			it("quotes paths with spaces", () => {
				expect(quoteShellPath("/path/with spaces/file.ts")).toBe(
					"'/path/with spaces/file.ts'",
				);
			});

			it("quotes paths with special characters", () => {
				expect(quoteShellPath("/path/$variable/file.ts")).toBe(
					"'/path/$variable/file.ts'",
				);
				expect(quoteShellPath("/path/with&ampersand.ts")).toBe(
					"'/path/with&ampersand.ts'",
				);
				expect(quoteShellPath("/path/(parens)/file.ts")).toBe(
					"'/path/(parens)/file.ts'",
				);
			});

			it("escapes single quotes within quoted paths", () => {
				expect(quoteShellPath("/path/it's/file.ts")).toBe(
					"'/path/it'\\''s/file.ts'",
				);
			});

			it("handles multiple special characters", () => {
				const complexPath = "/path/with spaces & symbols/file's name.ts";
				const quoted = quoteShellPath(complexPath);
				// Should be single-quoted with escaped internal quotes
				expect(quoted.startsWith("'")).toBe(true);
				expect(quoted.endsWith("'")).toBe(true);
			});
		});

		describe("Windows (isWindows=true)", () => {
			it("leaves simple paths unquoted", () => {
				expect(quoteShellPath("C:\\Users\\file.ts", true)).toBe(
					"C:\\Users\\file.ts",
				);
				expect(quoteShellPath("D:/Projects/app.js", true)).toBe(
					"D:/Projects/app.js",
				);
			});

			it("quotes paths with spaces using double quotes", () => {
				expect(quoteShellPath("C:\\Program Files\\app.exe", true)).toBe(
					'"C:\\Program Files\\app.exe"',
				);
			});

			it("quotes paths with special cmd.exe characters", () => {
				expect(quoteShellPath("C:\\path&name\\file.ts", true)).toBe(
					'"C:\\path&name\\file.ts"',
				);
				expect(quoteShellPath("C:\\path|pipe\\file.ts", true)).toBe(
					'"C:\\path|pipe\\file.ts"',
				);
				expect(quoteShellPath("C:\\(parens)\\file.ts", true)).toBe(
					'"C:\\(parens)\\file.ts"',
				);
			});

			it("escapes double quotes within quoted paths", () => {
				expect(quoteShellPath('C:\\path"with"quotes\\file.ts', true)).toBe(
					'"C:\\path^"with^"quotes\\file.ts"',
				);
			});

			it("does not quote backslashes (literal in cmd.exe)", () => {
				// Backslashes are path separators in Windows, not escape chars
				expect(quoteShellPath("C:\\simple\\path.ts", true)).toBe(
					"C:\\simple\\path.ts",
				);
			});
		});
	});

	describe("isWindowsPlatform", () => {
		it("returns true for Windows platforms", () => {
			expect(isWindowsPlatform({ platform: "Win32" })).toBe(true);
			expect(isWindowsPlatform({ platform: "Windows" })).toBe(true);
			expect(isWindowsPlatform({ platform: "win32" })).toBe(true);
		});

		it("returns false for non-Windows platforms", () => {
			expect(isWindowsPlatform({ platform: "MacIntel" })).toBe(false);
			expect(isWindowsPlatform({ platform: "Linux x86_64" })).toBe(false);
			expect(isWindowsPlatform({ platform: "darwin" })).toBe(false);
		});
	});

	describe("fileUriToPath", () => {
		it("returns null for non-file URIs", () => {
			expect(fileUriToPath("https://example.com")).toBeNull();
			expect(fileUriToPath("/some/path")).toBeNull();
			expect(fileUriToPath("")).toBeNull();
		});

		it("converts Unix file URIs", () => {
			expect(fileUriToPath("file:///home/user/file.ts")).toBe(
				"/home/user/file.ts",
			);
			expect(fileUriToPath("file:///Users/dev/project/src/main.ts")).toBe(
				"/Users/dev/project/src/main.ts",
			);
		});

		it("converts Windows file URIs", () => {
			expect(fileUriToPath("file:///C:/Users/dev/file.ts")).toBe(
				"C:/Users/dev/file.ts",
			);
			expect(fileUriToPath("file:///D:/Projects/app.js")).toBe(
				"D:/Projects/app.js",
			);
		});

		it("decodes URL-encoded characters", () => {
			expect(fileUriToPath("file:///path/with%20spaces/file.ts")).toBe(
				"/path/with spaces/file.ts",
			);
			expect(fileUriToPath("file:///C:/Program%20Files/app.exe")).toBe(
				"C:/Program Files/app.exe",
			);
		});

		it("handles special characters", () => {
			expect(fileUriToPath("file:///path/%24variable/file.ts")).toBe(
				"/path/$variable/file.ts",
			);
			expect(fileUriToPath("file:///path/%26ampersand.ts")).toBe(
				"/path/&ampersand.ts",
			);
		});
	});
});
