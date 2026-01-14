# Changelog

All notable changes to the BooTTY extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.6] - 2026-01-13

### Added
- VS Code-style bell indicators in terminal list (icon next to terminal name)
- Transient bell animation for active terminals (fades out after 1.5s)
- Persistent bell indicator for inactive terminals (clears on focus)

### Fixed
- Terminal flicker during typing when scrolled up (RAF deferral)
- Scroll drift during rapid output when scrolled up (RAF coalescing)
- Bell timer race condition with rapid bells

### Changed
- Removed screen flash bell animation (replaced with list indicator)
- Removed status bar bell notification (matches VS Code native behavior)

## [0.2.0] - 2026-01-09

### Changed
- **BREAKING**: Rebranded from "Ghostty Terminal" to "BooTTY" per upstream feedback
- All commands renamed from `ghostty.*` to `bootty.*`
- All settings renamed from `ghostty.*` to `bootty.*`
- New pirate-ghost terminal icon
- `TERM_PROGRAM` now set to `bootty` instead of `ghostty_vscode`

### Added
- Performance disclaimer about unoptimized WASM builds
- Alpine Linux (musl) support for native builds

### Migration
Users upgrading from v0.1.x need to update their settings:
- `ghostty.fontFamily` → `bootty.fontFamily`
- `ghostty.fontSize` → `bootty.fontSize`
- `ghostty.defaultTerminalLocation` → `bootty.defaultTerminalLocation`
- `ghostty.bell` → `bootty.bell`
- `ghostty.notifications` → `bootty.notifications`

## [Unreleased]

### Added
- OSC 9 notification support for terminal application notifications
- Bell setting (`bootty.bell`) to control visual/status notifications
- Keyboard shortcuts: `Ctrl+`` toggle panel, `Ctrl+Shift+`` new terminal
- Tab navigation: `Cmd+Shift+[` / `Cmd+Shift+]` to switch tabs
- `Cmd+Shift+T` opens new terminal in panel
- Theme-aware CSS styling for all UI elements
- SGR mouse reporting for terminal applications (vim, htop, etc.)

### Changed
- Panel now appears in bottom area alongside built-in Terminal
- Terminal focus is automatic after panel toggle

### Fixed
- Tab hover colors now respect VS Code theme
- `Ctrl+`` no longer sent to terminal when toggling panel

## [0.0.1] - 2024-01-01

### Added
- Initial release
- WebGL-based terminal rendering via ghostty-web
- Editor tab and panel-based terminal support
- File path detection and clickable links
- Drag-and-drop file support
- Search in terminal (`Cmd+F`)
- Copy/paste via context menu
- Double-click word selection
- Triple-click line selection
- OSC 7 CWD tracking
- Theme integration with VS Code colors
