# SPEC: Custom Fonts (#3)

## Goal
Allow users to configure terminal font family and size, with sensible defaults that respect existing VS Code terminal settings.

## Settings Priority

1. `bootty.fontFamily` / `bootty.fontSize` (explicit override)
2. `terminal.integrated.fontFamily` / `terminal.integrated.fontSize` (VS Code terminal default)
3. ghostty-web default (`'monospace'` / `15`)

## Implementation

### Package Contribution

Add to `package.json`:
```json
{
  "contributes": {
    "configuration": {
      "title": "BooTTY",
      "properties": {
        "bootty.fontFamily": {
          "type": "string",
          "default": "",
          "description": "Font family for BooTTY. Leave empty to use terminal.integrated.fontFamily."
        },
        "bootty.fontSize": {
          "type": "number",
          "default": 0,
          "minimum": 6,
          "maximum": 72,
          "description": "Font size in pixels. Set to 0 to use terminal.integrated.fontSize."
        }
      }
    }
  }
}
```

### Types

```typescript
// types/settings.ts
export interface BooTTYDisplaySettings {
  fontFamily: string;
  fontSize: number;
}
```

### Settings Resolution

```typescript
// settings.ts
export function resolveDisplaySettings(): BooTTYDisplaySettings {
  const boottyConfig = vscode.workspace.getConfiguration('bootty');
  const terminalConfig = vscode.workspace.getConfiguration('terminal.integrated');

  const fontFamily = boottyConfig.get<string>('fontFamily') ||
                     terminalConfig.get<string>('fontFamily') ||
                     'monospace';

  const fontSize = boottyConfig.get<number>('fontSize') ||
                   terminalConfig.get<number>('fontSize') ||
                   15;

  return { fontFamily, fontSize };
}
```

### Message Protocol

Add to `types/messages.ts`:
```typescript
export type ExtensionMessage =
  | { type: 'pty-data'; terminalId: TerminalId; data: string }
  | { type: 'pty-exit'; terminalId: TerminalId; exitCode: number }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'update-settings'; settings: { fontFamily?: string; fontSize?: number } };
```

### Webview Handler

In `webview/main.ts`:
```typescript
case 'update-settings':
  if (msg.settings.fontFamily !== undefined) {
    term.options.fontFamily = msg.settings.fontFamily;
  }
  if (msg.settings.fontSize !== undefined) {
    term.options.fontSize = msg.settings.fontSize;
  }
  // FitAddon will recalculate dimensions on next fit()
  fitAddon.fit();
  break;
```

### Hot Reload

In `terminal-manager.ts`:
```typescript
constructor(context: vscode.ExtensionContext) {
  // ... existing code ...

  // Listen for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('bootty') ||
          e.affectsConfiguration('terminal.integrated.fontFamily') ||
          e.affectsConfiguration('terminal.integrated.fontSize')) {
        this.broadcastSettingsUpdate();
      }
    })
  );
}

private broadcastSettingsUpdate(): void {
  const settings = resolveDisplaySettings();
  for (const [, instance] of this.terminals) {
    if (instance.ready) {
      instance.panel.webview.postMessage({
        type: 'update-settings',
        settings: {
          fontFamily: settings.fontFamily,
          fontSize: settings.fontSize,
        },
      });
    }
  }
}
```

### Initial Settings Injection

Pass settings when creating terminal:
```typescript
const settings = resolveDisplaySettings();
const termOptions = {
  cols: 80,
  rows: 24,
  fontFamily: settings.fontFamily,
  fontSize: settings.fontSize,
  // ... other options
};
```

## Data Flow

```
User changes setting
        │
        ▼
onDidChangeConfiguration fires
        │
        ▼
resolveDisplaySettings() reads priority chain
        │
        ▼
postMessage({ type: 'update-settings', ... })
        │
        ▼
Webview updates term.options.fontFamily/fontSize
        │
        ▼
ghostty-web Proxy triggers handleOptionChange()
        │
        ▼
handleFontChange() resizes canvas + re-renders
        │
        ▼
fitAddon.fit() recalculates dimensions
        │
        ▼
postMessage({ type: 'terminal-resize', ... })
        │
        ▼
PTY resized to new dimensions
```

## Edge Cases

1. **Font not found**: Browser falls back gracefully; no error handling needed
2. **Invalid font size**: VS Code schema validates 6-72 range
3. **Empty string**: Treated as "not set", falls through priority chain
4. **Zero fontSize**: Treated as "not set", falls through priority chain

## Testing

1. Set `bootty.fontFamily` to `"Fira Code"` -> terminal uses Fira Code
2. Clear `bootty.fontFamily`, set `terminal.integrated.fontFamily` to `"Monaco"` -> terminal uses Monaco
3. Clear both -> terminal uses `monospace`
4. Change font while terminal is open -> hot reload works
5. Verify resize message sent after font change
