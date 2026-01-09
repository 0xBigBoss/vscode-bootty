# SPEC: Keybinding Passthrough (#2)

## Goal
Allow VS Code keybindings (Cmd+P, Cmd+Shift+P, Ctrl+`, etc.) to work while BooTTY terminal is focused, matching VS Code's integrated terminal behavior.

## Current Problem

The ghostty-web library's InputHandler captures all keyboard events with `preventDefault()`, blocking VS Code from seeing any keybindings when terminal has focus.

## Behavior Model: Match Integrated Terminal

VS Code's integrated terminal:
- **Passes through** most Cmd/Ctrl combos to VS Code (quick open, command palette, etc.)
- **Captures** terminal-specific inputs (Ctrl+C for interrupt, raw typing, etc.)

We'll implement the same model.

## Implementation

### Key Filter Logic

Keys that should go to **terminal**:
- All non-modifier keys (typing)
- `Ctrl+C` (interrupt signal 0x03)
- `Ctrl+D` (EOF)
- `Ctrl+Z` (suspend)
- `Ctrl+L` (clear)
- `Ctrl+A` through `Ctrl+Z` when no Cmd/Meta (control sequences)
- `Ctrl+Shift+C` / `Ctrl+Shift+V` (terminal copy/paste on Linux/Windows)
- Arrow keys, function keys, etc.

Keys that should **pass through** to VS Code:
- `Cmd+P` / `Ctrl+P` (Quick Open)
- `Cmd+Shift+P` / `Ctrl+Shift+P` (Command Palette)
- `Cmd+Shift+E` / `Ctrl+Shift+E` (Explorer)
- `Cmd+Shift+F` / `Ctrl+Shift+F` (Search)
- `Cmd+Shift+G` / `Ctrl+Shift+G` (Source Control)
- `Cmd+Shift+D` / `Ctrl+Shift+D` (Debug)
- `Cmd+Shift+X` / `Ctrl+Shift+X` (Extensions)
- `Cmd+B` / `Ctrl+B` (Toggle Sidebar)
- `Cmd+J` / `Ctrl+J` (Toggle Panel)
- `Cmd+,` / `Ctrl+,` (Settings)
- `Cmd+W` / `Ctrl+W` (Close Tab)
- `Cmd+N` / `Ctrl+N` (New File)
- `Cmd+O` / `Ctrl+O` (Open File)
- `Cmd+S` / `Ctrl+S` (Save)
- `Ctrl+`` ` (Toggle Terminal)
- `Cmd+1-9` / `Ctrl+1-9` (Editor groups)
- Most other `Cmd+*` combos

### Implementation Approach

Use `attachCustomKeyEventHandler` with three-way return semantics:

```typescript
// Return values:
// - true: Terminal handles the key (preventDefault, process in terminal)
// - false: Let event bubble to VS Code (don't preventDefault, don't process)
// - undefined: Continue with default terminal processing

// webview/main.ts
term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const cmdOrCtrl = isMac ? event.metaKey : event.ctrlKey;

  // Terminal-specific bindings (capture these)
  if (event.ctrlKey && !event.metaKey && !event.altKey) {
    // Ctrl+Letter without other modifiers -> send to terminal
    // These produce control sequences (Ctrl+C = 0x03, etc.)
    if (event.key.length === 1 && /[a-zA-Z]/.test(event.key)) {
      return true; // Terminal handles it
    }
  }

  // Cmd/Ctrl combos should pass through to VS Code
  if (cmdOrCtrl) {
    // Exception: Cmd+C with selection should copy (handled by SelectionManager)
    if (event.key === 'c' && !event.shiftKey && term.hasSelection()) {
      return false; // Let VS Code/browser handle copy
    }

    // Exception: Cmd+V should paste (handled separately)
    if (event.key === 'v' && !event.shiftKey) {
      return false; // Let browser handle paste
    }

    // All other Cmd/Ctrl combos pass through to VS Code
    return false; // Let event bubble to VS Code
  }

  // Everything else: use default terminal processing
  return undefined;
});
```

### Data Flow for Passthrough

```
Keyboard event in webview
        │
        ▼
customKeyEventHandler returns false
        │
        ▼
Event NOT prevented, bubbles up
        │
        ▼
VS Code webview host sees keydown
        │
        ▼
VS Code keybinding system matches command
        │
        ▼
Command executes (Quick Open, etc.)
```

### Data Flow for Terminal Capture

```
Keyboard event in webview
        │
        ▼
customKeyEventHandler returns true
        │
        ▼
InputHandler processes key
        │
        ▼
Escape sequence sent via onData
        │
        ▼
PTY receives input
```

## User Customization (Future)

Add settings for power users:
```json
{
  "contributes": {
    "configuration": {
      "properties": {
        "bootty.terminalKeybindings": {
          "type": "array",
          "default": [],
          "items": { "type": "string" },
          "description": "Additional keybindings to capture in terminal (e.g., 'ctrl+p' to send to terminal instead of VS Code)"
        },
        "bootty.passthroughKeybindings": {
          "type": "array",
          "default": [],
          "items": { "type": "string" },
          "description": "Additional keybindings to pass through to VS Code"
        }
      }
    }
  }
}
```

For MVP, skip user customization - defaults should cover 95% of cases.

## Edge Cases

### Ctrl+C Behavior
- With selection: Should copy (pass through)
- Without selection: Should send interrupt (capture)

Implementation:
```typescript
if (event.ctrlKey && event.key === 'c') {
  if (term.hasSelection()) {
    return false; // Let VS Code/browser handle copy
  }
  return true; // Send interrupt to terminal
}
```

### Alt Key on Mac
- `Alt+letter` produces special characters (e.g., `Alt+3` = `#`)
- Should go to terminal for special character input

### Function Keys
- F1-F12 without modifiers go to terminal
- F1 with modifiers might be VS Code help - pass through

## Testing

1. `Cmd+P` / `Ctrl+P` opens Quick Open while terminal focused
2. `Cmd+Shift+P` / `Ctrl+Shift+P` opens Command Palette
3. `Ctrl+`` ` toggles terminal panel
4. `Ctrl+C` sends interrupt (verify with `sleep 100` then Ctrl+C)
5. `Ctrl+C` with text selected copies text
6. Regular typing works normally
7. Arrow keys, function keys work normally

## Limitations

- Webview keyboard event handling may differ slightly from native terminals
- Some VS Code extensions may have keybindings that conflict
- Complex modifier combinations may have edge cases

## References

- VS Code integrated terminal keybinding docs
- xterm.js keyboard handling
- Browser keyboard event propagation
