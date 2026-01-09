# Architecture

This document describes the architecture of the BooTTY VS Code extension.

## Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         VS Code                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Extension Host                         │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │   │
│  │  │ extension.ts│  │terminal-mgr │  │ pty-service.ts  │  │   │
│  │  │  (entry)    │──│  .ts        │──│ (node-pty)      │  │   │
│  │  └─────────────┘  └─────────────┘  └────────┬────────┘  │   │
│  │         │                │                   │           │   │
│  │         │                │                   │           │   │
│  │         ▼                ▼                   ▼           │   │
│  │  ┌─────────────────────────────────────────────────┐    │   │
│  │  │              Message Passing                     │    │   │
│  │  │    (postMessage / onDidReceiveMessage)          │    │   │
│  │  └─────────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                              ▼                                   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                      Webview                              │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │   │
│  │  │ main.ts /   │  │ghostty-web  │  │  xterm.js       │  │   │
│  │  │panel-main.ts│──│ (WASM)      │──│ (rendering)     │  │   │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘  │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │   Shell (PTY)    │
                    │  bash/zsh/etc   │
                    └─────────────────┘
```

## Components

### Extension Host (Node.js)

#### `extension.ts`
- Extension entry point
- Registers commands, views, and providers
- Initializes TerminalManager and PanelViewProvider

#### `terminal-manager.ts`
- Central coordinator for all terminal instances
- Routes messages between webviews and PTY processes
- Handles terminal lifecycle (create, destroy, focus)
- Parses OSC sequences (OSC 7 for CWD, OSC 9 for notifications)

#### `panel-view-provider.ts`
- Implements `WebviewViewProvider` for panel-based terminals
- Manages internal tab bar UI
- Queues messages until webview is ready

#### `pty-service.ts`
- Wraps `node-pty` for cross-platform PTY management
- Spawns shell processes
- Handles input/output streaming
- Manages terminal resize

### Webview (Browser Context)

#### `main.ts` (Editor Terminals)
- Single-terminal webview for editor tabs
- Initializes ghostty-web terminal
- Handles keyboard events, file path detection
- Manages search overlay

#### `panel-main.ts` (Panel Terminals)
- Multi-terminal webview for bottom panel
- Manages tab bar and terminal switching
- Handles drag-and-drop tab reordering
- Similar functionality to main.ts but supports multiple terminals

#### `ghostty-web`
- WebAssembly terminal emulator
- Uses xterm.js for rendering
- Provides Terminal API (write, resize, selection, etc.)

## Message Flow

### Extension → Webview

| Message Type | Purpose |
|-------------|---------|
| `pty-data` | Terminal output data |
| `pty-exit` | Process exited |
| `resize` | Terminal dimensions changed |
| `update-settings` | Font settings changed |
| `update-theme` | Color theme changed |
| `update-cwd` | Working directory changed |
| `update-config` | Runtime config (bell, etc.) |
| `batch-file-exists-result` | Batch file existence check results |

### Webview → Extension

| Message Type | Purpose |
|-------------|---------|
| `terminal-ready` | Webview initialized with dimensions |
| `terminal-input` | User keyboard input |
| `terminal-resize` | Terminal container resized |
| `terminal-bell` | Bell character received |
| `open-url` | User clicked URL |
| `open-file` | User clicked file path |
| `batch-check-file-exists` | Batch validate file paths exist (debounced) |

### Panel-Specific Messages

| Message Type | Direction | Purpose |
|-------------|-----------|---------|
| `panel-ready` | W→E | Panel webview initialized |
| `add-tab` | E→W | Create new terminal tab |
| `remove-tab` | E→W | Remove terminal tab |
| `activate-tab` | E→W | Switch to specific tab |
| `tab-activated` | W→E | User switched tabs |
| `tab-close-requested` | W→E | User closed tab |

## Terminal Types

The extension supports two terminal locations:

### Editor Terminals
- Open in editor tab group
- Each has its own `WebviewPanel`
- Accessed via `bootty.newTerminalInEditor`

### Panel Terminals
- Open in bottom panel (like built-in terminal)
- Share single `WebviewView` with internal tabs
- Accessed via `bootty.newTerminalInPanel` or `bootty.newTerminal`

## Type System

Uses discriminated unions for type-safe terminal handling:

```typescript
// Base fields shared by all terminals
interface TerminalInstanceBase {
  id: TerminalId;
  ready: boolean;
  dataQueue: string[];
  currentCwd?: string;
}

// Editor terminal has WebviewPanel
interface EditorTerminalInstance extends TerminalInstanceBase {
  location: "editor";
  panel: WebviewPanel;
}

// Panel terminal doesn't have individual panel
interface PanelTerminalInstance extends TerminalInstanceBase {
  location: "panel";
}

// Discriminated union - use location to narrow
type TerminalInstance = EditorTerminalInstance | PanelTerminalInstance;
```

## Data Flow Example

### User Types Character

1. Browser captures `keydown` event in webview
2. ghostty-web processes key, may generate escape sequence
3. `terminal-input` message sent to extension
4. `pty-service` writes data to PTY stdin
5. Shell processes input
6. Shell output written to PTY stdout
7. `pty-service` emits data event
8. `terminal-manager` receives data
9. Checks for OSC sequences (7, 9)
10. Sends `pty-data` message to webview
11. ghostty-web renders output

### File Path Click

1. User clicks detected file path
2. Webview checks file existence via `check-file-exists`
3. Extension checks filesystem, responds with result
4. If exists, webview sends `open-file` message
5. Extension calls `vscode.window.showTextDocument`

## Configuration

Settings in `package.json`:

| Setting | Description |
|---------|-------------|
| `bootty.fontFamily` | Terminal font family |
| `bootty.fontSize` | Terminal font size |
| `bootty.defaultTerminalLocation` | Where new terminals open |
| `bootty.bell` | Bell notification style |
| `bootty.notifications` | Enable OSC 9 notifications |

## Security Considerations

- Webview runs in sandboxed iframe
- File operations validated before execution
- URL schemes can be restricted
- No arbitrary code execution from terminal output
