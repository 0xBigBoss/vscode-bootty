# BooTTY

<img src="./images/icon.png" width="200" align="center"/>

An alternative terminal extension for VS Code powered by [Ghostty's](https://ghostty.org/) terminal emulation (libghostty-vt) via WebAssembly.

*Pronounced "Boo-T-T-Y"* 👻

> **Note**: This is an unofficial community project. It is not affiliated with or endorsed by the Ghostty project.

> **Performance**: The underlying ghostty-web library and WASM builds have not been optimized for web/VS Code environments. Performance may not match native terminal emulators. This is expected and improvements are ongoing upstream.

## Features

- **Ghostty's terminal emulation** - VT100/xterm escape sequence parsing via libghostty-vt WASM
- **Real PTY integration** - Full terminal emulation with native shell support
- **Panel and editor terminals** - Open terminals in the bottom panel or as editor tabs
- **Multi-tab support** - Multiple terminal sessions in the panel view
- **Theme integration** - Automatically uses VS Code's color theme
- **File path detection** - Ctrl/Cmd+click to open files from terminal output

## How It Works

This extension uses two main components:

1. **libghostty-vt (WASM)** - Ghostty's terminal emulation library handles:
   - VT100/xterm escape sequence parsing
   - Terminal state management (cells, cursor, scrollback)
   - Unicode/grapheme handling
   - Key encoding (Kitty protocol, xterm modifyOtherKeys)

2. **Canvas2D Renderer (JavaScript)** - The extension renders the terminal using:
   - HTML5 Canvas with 2D context
   - Dirty line tracking for efficient updates
   - VS Code theme color integration

> **Note**: This extension uses Canvas2D rendering, not WebGL. GPU-accelerated WebGL rendering is a potential future enhancement.

## Installation

Search for "BooTTY" in the VS Code extensions marketplace, or install from the command line:

```bash
code --install-extension bigboss.bootty
```

## Usage

| Action | Windows/Linux | macOS |
|--------|---------------|-------|
| Toggle terminal panel | <kbd>Ctrl</kbd>+<kbd>`</kbd> | <kbd>Cmd</kbd>+<kbd>`</kbd> |
| New terminal | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>`</kbd> | <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>`</kbd> |
| New terminal in panel | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> | <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> |
| Next tab | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>]</kbd> | <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>]</kbd> |
| Previous tab | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>[</kbd> | <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>[</kbd> |

You can also use the Command Palette (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> / <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>):

- `BooTTY: New Terminal`
- `BooTTY: New Terminal in Editor`
- `BooTTY: New Terminal in Panel`
- `BooTTY: Toggle Terminal Panel`

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `bootty.fontFamily` | `""` | Font family (empty = use editor font) |
| `bootty.fontSize` | `0` | Font size in pixels (0 = use editor size) |
| `bootty.defaultTerminalLocation` | `"panel"` | Where new terminals open (`"panel"` or `"editor"`) |
| `bootty.bell` | `"visual"` | Bell style (`"visual"` or `"none"`) |
| `bootty.notifications` | `true` | Show notifications from terminal apps (OSC 9) |

## Requirements

- VS Code 1.106.0 or later
- macOS, Linux, or Windows

## Credits

- [Ghostty](https://ghostty.org/) by Mitchell Hashimoto - The terminal emulator whose VT100 parser (libghostty-vt) powers this extension
- [ghostty-web](https://github.com/coder/ghostty-web) by Coder - WebAssembly bindings and Canvas2D renderer for libghostty-vt

## Related Repositories

- [BooTTY](https://github.com/0xBigBoss/vscode-bootty) - This VS Code extension
- [@0xbigboss/ghostty-web](https://github.com/0xBigBoss/ghostty-web) - Fork of ghostty-web with enhanced selection handling ([npm](https://www.npmjs.com/package/@0xbigboss/ghostty-web))

## License

MIT - See [LICENSE](LICENSE) for details.
