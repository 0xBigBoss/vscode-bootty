# Ghostty Terminal for VS Code

A GPU-accelerated terminal extension for VS Code powered by [Ghostty's](https://ghostty.org/) VT100 parser via WebAssembly.

> **Note**: This is an unofficial community extension. It is not affiliated with or endorsed by the Ghostty project.

## Features

- **GPU-accelerated rendering** via Ghostty's WebGL renderer
- **Real PTY integration** with full terminal emulation
- **Panel and editor terminals** - open terminals in the bottom panel or as editor tabs
- **Multi-tab support** in the panel view
- **Theme integration** - automatically uses VS Code's color theme
- **File path detection** - Ctrl/Cmd+click to open files from terminal output
- **Drag and drop** - drop files into the terminal to paste their paths

## Installation

Search for "Ghostty Terminal" in the VS Code extensions marketplace, or install from the command line:

```bash
code --install-extension bigboss.vscode-ghostty
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

- `Ghostty: New Terminal`
- `Ghostty: New Terminal in Editor`
- `Ghostty: New Terminal in Panel`
- `Ghostty: Toggle Terminal Panel`

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `ghostty.fontFamily` | `""` | Font family (empty = use editor font) |
| `ghostty.fontSize` | `0` | Font size in pixels (0 = use editor size) |
| `ghostty.defaultTerminalLocation` | `"panel"` | Where new terminals open (`"panel"` or `"editor"`) |
| `ghostty.bell` | `"visual"` | Bell style (`"visual"` or `"none"`) |
| `ghostty.notifications` | `true` | Show notifications from terminal apps (OSC 9) |

## Requirements

- VS Code 1.106.0 or later
- macOS, Linux, or Windows

## Credits

- [Ghostty](https://ghostty.org/) by Mitchell Hashimoto - The terminal emulator whose renderer powers this extension
- [ghostty-web](https://github.com/coder/ghostty-web) by Coder - WebAssembly bindings for Ghostty's renderer

## Related Repositories

- [vscode-ghostty](https://github.com/0xBigBoss/vscode-ghostty) - This VS Code extension
- [@0xbigboss/ghostty-web](https://github.com/0xBigBoss/ghostty-web) - Fork of ghostty-web with enhanced selection handling ([npm](https://www.npmjs.com/package/@0xbigboss/ghostty-web))

## License

MIT - See [LICENSE](LICENSE) for details.
