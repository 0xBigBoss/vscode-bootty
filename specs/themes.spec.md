# SPEC: Custom Terminal Themes (#4)

## Goal
Support VS Code's terminal color theming so BooTTY matches the user's active color theme.

## Theme Source

Read terminal colors from VS Code's workbench theme system:
- `terminal.foreground`
- `terminal.background`
- `terminal.cursor.foreground`
- `terminal.cursor.background`
- `terminal.selectionBackground`
- `terminal.selectionForeground`
- `terminal.ansiBlack` through `terminal.ansiWhite`
- `terminal.ansiBrightBlack` through `terminal.ansiBrightWhite`

## Implementation

### Theme Resolution

```typescript
// theme.ts
import * as vscode from 'vscode';
import type { ITheme } from 'ghostty-web';

function getThemeColor(key: string): string | undefined {
  // VS Code doesn't directly expose terminal colors via API
  // We need to use workbench.colorCustomizations or compute from theme
  const colorCustomizations = vscode.workspace
    .getConfiguration('workbench')
    .get<Record<string, string>>('colorCustomizations') ?? {};

  return colorCustomizations[key];
}

export function resolveTerminalTheme(): ITheme {
  return {
    foreground: getThemeColor('terminal.foreground'),
    background: getThemeColor('terminal.background'),
    cursor: getThemeColor('terminal.cursor.foreground'),
    cursorAccent: getThemeColor('terminal.cursor.background'),
    selectionBackground: getThemeColor('terminal.selectionBackground'),
    selectionForeground: getThemeColor('terminal.selectionForeground'),
    black: getThemeColor('terminal.ansiBlack'),
    red: getThemeColor('terminal.ansiRed'),
    green: getThemeColor('terminal.ansiGreen'),
    yellow: getThemeColor('terminal.ansiYellow'),
    blue: getThemeColor('terminal.ansiBlue'),
    magenta: getThemeColor('terminal.ansiMagenta'),
    cyan: getThemeColor('terminal.ansiCyan'),
    white: getThemeColor('terminal.ansiWhite'),
    brightBlack: getThemeColor('terminal.ansiBrightBlack'),
    brightRed: getThemeColor('terminal.ansiBrightRed'),
    brightGreen: getThemeColor('terminal.ansiBrightGreen'),
    brightYellow: getThemeColor('terminal.ansiBrightYellow'),
    brightBlue: getThemeColor('terminal.ansiBrightBlue'),
    brightMagenta: getThemeColor('terminal.ansiBrightMagenta'),
    brightCyan: getThemeColor('terminal.ansiBrightCyan'),
    brightWhite: getThemeColor('terminal.ansiBrightWhite'),
  };
}
```

### Message Protocol

Add to `types/messages.ts`:
```typescript
export type ExtensionMessage =
  | { type: 'pty-data'; terminalId: TerminalId; data: string }
  | { type: 'pty-exit'; terminalId: TerminalId; exitCode: number }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'update-settings'; settings: { fontFamily?: string; fontSize?: number } }
  | { type: 'update-theme'; theme: ITheme };
```

### Webview Handler

In `webview/main.ts`:
```typescript
case 'update-theme':
  // Note: ghostty-web's handleOptionChange warns that theme changes
  // are "not yet fully supported" - we may need to reinitialize the terminal
  // or wait for upstream support
  term.options.theme = msg.theme;
  break;
```

### Hot Reload on Theme Change

In `terminal-manager.ts`:
```typescript
constructor(context: vscode.ExtensionContext) {
  // ... existing code ...

  // Listen for color theme changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(() => {
      this.broadcastThemeUpdate();
    })
  );

  // Also listen for workbench.colorCustomizations changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('workbench.colorCustomizations')) {
        this.broadcastThemeUpdate();
      }
    })
  );
}

private broadcastThemeUpdate(): void {
  const theme = resolveTerminalTheme();
  for (const [, instance] of this.terminals) {
    if (instance.ready) {
      instance.panel.webview.postMessage({
        type: 'update-theme',
        theme,
      });
    }
  }
}
```

### Initial Theme Injection

Pass theme when creating terminal:
```typescript
const theme = resolveTerminalTheme();
const termOptions = {
  cols: 80,
  rows: 24,
  theme,
  // ... other options
};
```

## Limitations

### Theme Hot Reload Scope

**What hot reload DOES affect:**
- Selection colors (selectionBackground, selectionForeground)
- Terminal background color
- Cursor color
- New content written after theme change

**What hot reload does NOT affect:**
- Existing cell content (text already on screen keeps original colors)

This is a fundamental terminal emulator limitation: cells store final RGB values at write time, not palette indices. The WASM terminal resolves colors when content is written. There's no standard mechanism to "re-color" existing content.

**Workarounds for users:**
- Run `clear` to clear the screen after theme change
- New output will use the new theme colors
- Scrollback content retains original colors

### VS Code Theme Color Access

VS Code doesn't directly expose computed theme colors via extension API. Options:

1. **workbench.colorCustomizations only**: Only works if user has explicitly customized colors
2. **CSS variables**: Webview can read CSS custom properties from VS Code's theme
3. **registerColorProvider**: Not applicable for terminal colors

**Recommendation:** Use CSS variables in webview for reliable theme access.

### CSS Variable Approach

```typescript
// In webview/main.ts
function getVSCodeThemeColors(): ITheme {
  const style = getComputedStyle(document.documentElement);
  return {
    foreground: style.getPropertyValue('--vscode-terminal-foreground').trim() || undefined,
    background: style.getPropertyValue('--vscode-terminal-background').trim() || undefined,
    // ... etc
  };
}

// Listen for theme changes via MutationObserver on document.body
const observer = new MutationObserver(() => {
  const theme = getVSCodeThemeColors();
  term.options.theme = theme;
});
observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
```

## Data Flow

```
User changes VS Code theme
        │
        ▼
onDidChangeActiveColorTheme fires
        │
        ▼
OR webview detects body class change
        │
        ▼
resolveTerminalTheme() / getVSCodeThemeColors()
        │
        ▼
postMessage({ type: 'update-theme', ... }) or direct update
        │
        ▼
Webview updates term.options.theme
        │
        ▼
ghostty-web applies theme (with limitations)
```

## Testing

1. Set dark theme -> terminal has dark background
2. Switch to light theme -> terminal updates (may need restart due to upstream limitation)
3. Customize specific colors in workbench.colorCustomizations -> applied
4. Verify ANSI colors render correctly (ls with colors, git diff, etc.)

## Future Work

- Contribute theme hot reload fix to ghostty-web
- Support Ghostty's native `.ghostty` config file themes
- Support theme presets (Dracula, Solarized, etc.)
