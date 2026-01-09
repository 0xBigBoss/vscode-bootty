# Backlog - BooTTY Extension

## Quick Wins

- [x] Add keyboard shortcut for "New Terminal" (`Cmd+Shift+T`)
- [x] Cache file existence checks with TTL (avoid repeated round-trips)
- [x] Debounce resize handler (150ms)
- [x] Add `.vscodeignore` for lean extension packaging

## Code Quality

- [x] Split `webview/main.ts` into modules (file-link-provider.ts, search-controller.ts, theme-utils.ts)
- [ ] Export proper TypeScript types from ghostty-web (blocked: requires ghostty-web changes)
- [x] Add unit tests for path resolution, message handling, keybinding logic

## Performance

- [x] Batch `checkFileExists` requests (50ms debounce, parallel fs.stat)
- [x] Add LRU cache for file existence results (implemented in file-cache.ts)
- [x] Profile and optimize link detection regex (pre-compiled patterns, early-out)

## Features

- [x] Terminal tabs
- [ ] Split panes
- [x] Copy/paste context menu (browser default)
- [x] Search in terminal (Cmd+F)
- [x] Scrollback persistence across window reloads
- [x] Drag-and-drop files into terminal (paste path)
- [x] Bracketed paste mode support (handled by xterm.js when shell requests DECSET 2004)
- [x] Bell notification (visual/audio)
- [x] OSC 9 notifications

## Developer Experience

- [ ] Publish ghostty-web to npm (replace `file:../ghostty-web`)
- [x] Add `CHANGELOG.md` for releases
- [x] Add contributing guide
- [x] Document architecture (extension ↔ webview ↔ PTY flow)

## Selection & Clipboard

- [x] Verify ghostty-web selection API works correctly
- [x] Double-click to select word
- [x] Triple-click to select line
- [x] Shift+click to extend selection (native xterm.js feature)
