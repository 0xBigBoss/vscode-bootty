# TODO - BooTTY Extension Implementation

## Completed
- [x] Phase 1: Project structure (package.json, tsconfig, esbuild.config.mjs) - iteration 1
- [x] Phase 2: Type definitions (terminal.ts, messages.ts) - iteration 1
- [x] Phase 3: PTY service (terminal-utils.ts, pty-service.ts) - iteration 1
- [x] Phase 4: Webview files (template.html, styles.css, main.ts) - iteration 1
- [x] Phase 5: Webview provider (webview-provider.ts) - iteration 1
- [x] Phase 6: Terminal manager (terminal-manager.ts) - iteration 1
- [x] Phase 7: Extension entry (extension.ts) - iteration 1
- [x] npm install succeeds - iteration 1
- [x] npm run build succeeds - iteration 1
- [x] TypeScript type check passes (npx tsc --noEmit) - iteration 1
- [x] Fix shell detection for macOS (fallback to /bin/zsh) - iteration 2
- [x] Add TERM_PROGRAM=bootty environment variable - iteration 2
- [x] Manual VS Code Extension Development Host testing - iteration 2
  - [x] Extension activates without errors
  - [x] "BooTTY: New Terminal" opens webview terminal
  - [x] Shell prompt appears (PTY connected)
  - [x] Input echoes correctly
  - [x] $TERM_PROGRAM shows "bootty"
  - [x] $COLORTERM shows "truecolor"
- [x] #2 Keybinding Passthrough - Platform-specific: Mac (Cmd→VS Code, Ctrl→terminal), Win/Linux (Ctrl+Shift→VS Code, Ctrl+letter→terminal)
- [x] #3 Custom Fonts - Settings (minimum: 6), hot reload with PTY resize notification
- [x] #4 Custom Themes - CSS variables with MutationObserver, colorCustomizations merge
- [x] #8 Open File in Editor - FilePathLinkProvider with registerLinkProvider, checkFileExists validation, OSC 7 CWD tracking, Windows path support
- [x] Cache file existence checks with TTL (5s, 100 entries max) - Ralph iteration
- [x] Bell notification (visual flash + status bar) - Ralph iteration
- [x] Drag-and-drop files into terminal (paste path with shell quoting) - Ralph iteration
- [x] Double-click to select word (ghostty-web SelectionManager) - Ralph iteration
- [x] Triple-click to select line (added to ghostty-web) - Ralph iteration
- [x] Search in terminal (Cmd+F / Ctrl+F) with prev/next navigation - Ralph iteration
- [x] Unit tests for path resolution, file cache, keybinding logic (63 tests) - Ralph iteration
- [x] Panel-based terminals (bottom panel like VS Code built-in terminal) - Ralph iteration
  - [x] Added `BooTTYPanelViewProvider` with WebviewViewProvider
  - [x] Created panel webview with tab bar (panel-main.ts, panel-template.html, panel-styles.css)
  - [x] Discriminated union types for EditorTerminalInstance vs PanelTerminalInstance
  - [x] Message protocol for panel-specific messages (add-tab, remove-tab, tab-activated, etc.)
  - [x] Location-based routing in terminal-manager.ts
  - [x] Commands: bootty.togglePanel, bootty.newTerminalInEditor, bootty.newTerminalInPanel
  - [x] Keybindings: ctrl+` (toggle panel), ctrl+shift+` (new terminal), ctrl+shift+t (new in editor)
  - [x] Configuration: bootty.defaultTerminalLocation (panel/editor)
  - [x] Auto-create terminal when panel is empty on toggle
  - [x] Panel revealed before creating panel terminals (prevents timeout)
  - [x] State restoration preserves tab titles and active state

## In Progress
(none)

## Bugs (from QA)
- [x] **Font defaults wrong**: Fixed - now defaults to `editor.fontFamily`/`editor.fontSize`, overridable by `bootty.*`
- [x] **Custom color schemes broken**: Fixed - MutationObserver now watches documentElement style changes
- [x] **Keybindings captured by terminal**: Fixed in commit 28feb7d
- [x] **Scrollback lost on window move**: Fixed - scrollback content extracted from buffer via `term.buffer.active.getLine()` API and persisted via getState/setState. Content restored with dim styling on webview recreation.
- [x] **Theme regression after QA fixes**: Fixed - Now uses editor colors as primary (`--vscode-editor-*`), with terminal colors as fallback. Consistent with font settings priority (editor.* > terminal.integrated.*).

## Pending
- [x] Test exit closes terminal cleanly
- [ ] Explore e2e testing setup (Playwright + VS Code or @vscode/test-electron)

## Known Issues (upstream)
- **Resize crash during active rendering**: Resizing window while cmatrix or similar high-output programs are running can crash the WASM terminal. This is a race condition in ghostty-web's `wasmTerm.resize()` - needs fix in ghostty-web repo. Workaround: 150ms debounce on resize.

## Blocked
(none)

## Notes
- Build output: `out/extension.js`, `out/webview/main.js`, `out/webview/panel-main.js`, `out/webview/*.html`, `out/webview/*.css`
- All 13 files created per plan at `.claude/plans/validated-crunching-pelican.md`
- Shell detection improved to check VS Code settings, then $SHELL, then fallback to /bin/zsh
- Terminal identifies as TERM_PROGRAM=bootty, COLORTERM=truecolor
- Theme hot reload limitation: existing cell content keeps original colors (cells store RGB at write time)
- Font/theme settings priority: bootty.* > editor.* > defaults (fixed from terminal.integrated.*)
- OSC 7 tracked per terminal instance for CWD-relative path resolution
- Unit tests added for settings resolution, file cache, keybinding logic (73 tests via `npm test`)
- Panel terminals use discriminated union types for type-safe access to location-specific fields
- Panel state restoration on reload recreates PTY processes but preserves tab titles and active state
