# SPEC: Open File in Editor (Cmd+Click) (#8)

## Goal
Allow Cmd+Click (Ctrl+Click on Linux/Windows) on file paths in terminal output to open them in VS Code editor, matching VS Code's integrated terminal behavior.

## Features

1. **File path detection** - Recognize file paths in terminal output
2. **CWD tracking** - Track current directory via OSC 7 for relative path resolution
3. **Line/column navigation** - Support `file:line:col` format to jump to specific location
4. **Validation** - Only activate links for paths that exist on disk

## Path Patterns (Match VS Code)

### Supported Formats

1. **Absolute paths**
   - `/Users/allen/project/src/index.ts`
   - `C:\Users\allen\project\src\index.ts`

2. **Relative paths** (requires CWD tracking)
   - `./src/index.ts`
   - `../lib/utils.ts`
   - `src/index.ts` (without leading ./)

3. **Line/column format** (compiler output)
   - `src/index.ts:42` (file + line)
   - `src/index.ts:42:10` (file + line + column)
   - `src/index.ts(42,10)` (TypeScript style)
   - `src/index.ts(42)` (line only, parens)

4. **Git diff paths**
   - `a/src/index.ts`
   - `b/src/index.ts`

### Path Regex

```typescript
// Simplified regex for path detection
const FILE_PATH_REGEX = /(?:^|[\s'"(])(?:\.{0,2}\/)?([a-zA-Z]:)?[\w./-]+(?:\.[a-zA-Z0-9]+)(?:[:(\[][0-9]+[,:]?[0-9]*[\])]?)?/g;

// More structured approach:
interface FileMatch {
  path: string;      // The file path
  line?: number;     // Line number (1-indexed)
  column?: number;   // Column number (1-indexed)
}
```

## OSC 7: CWD Tracking

### Format

```
ESC ] 7 ; file://hostname/path/to/dir ESC \
```

Example: `\e]7;file://localhost/Users/allen/project\e\\`

### Shell Configuration

**Zsh** (add to `.zshrc`):
```zsh
precmd() {
  print -Pn "\e]7;file://${HOST}${PWD}\e\\"
}
```

**Bash** (add to `.bashrc`):
```bash
PROMPT_COMMAND='printf "\e]7;file://%s%s\e\\" "$HOSTNAME" "$PWD"'
```

**Fish** (add to `config.fish`):
```fish
function __update_cwd --on-variable PWD
  printf '\e]7;file://%s%s\e\\' (hostname) $PWD
end
```

### Implementation

```typescript
// Track CWD per terminal
private currentCwd: string | undefined;

// In write handler, check for OSC 7
private parseOSC7(data: string): string | undefined {
  const match = data.match(/\x1b\]7;file:\/\/[^\/]*([^\x07\x1b]+)(?:\x07|\x1b\\)/);
  if (match) {
    return decodeURIComponent(match[1]);
  }
  return undefined;
}

// Update CWD on write
write(data: string, callback?: () => void): void {
  const cwd = this.parseOSC7(data);
  if (cwd) {
    this.currentCwd = cwd;
  }
  // ... rest of write implementation
}
```

## Link Provider

### Interface

Implement `ILinkProvider` for ghostty-web:

```typescript
export class FilePathLinkProvider implements ILinkProvider {
  constructor(
    private getCurrentCwd: () => string | undefined,
    private openFile: (path: string, line?: number, col?: number) => void,
    private fileExists: (path: string) => Promise<boolean>
  ) {}

  async provideLinks(y: number, callback: (links: ILink[]) => void): Promise<void> {
    // Get line content from buffer
    const line = this.getLineContent(y);

    // Find all file path matches
    const matches = this.findFileMatches(line);

    // Validate and create links
    const links: ILink[] = [];
    for (const match of matches) {
      const absolutePath = this.resolvePath(match.path);
      if (await this.fileExists(absolutePath)) {
        links.push({
          range: { start: { x: match.startX, y }, end: { x: match.endX, y } },
          text: match.text,
          activate: () => this.openFile(absolutePath, match.line, match.column),
        });
      }
    }

    callback(links);
  }

  private resolvePath(path: string): string {
    if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
      return path; // Already absolute
    }
    const cwd = this.getCurrentCwd();
    if (cwd) {
      return require('path').resolve(cwd, path);
    }
    return path; // Can't resolve without CWD
  }
}
```

## Message Protocol

Add to `types/messages.ts`:

```typescript
export type WebviewMessage =
  | { type: 'terminal-input'; terminalId: TerminalId; data: string }
  | { type: 'terminal-resize'; terminalId: TerminalId; cols: number; rows: number }
  | { type: 'terminal-ready'; terminalId: TerminalId; cols: number; rows: number }
  | { type: 'open-url'; terminalId: TerminalId; url: string }
  | { type: 'open-file'; terminalId: TerminalId; path: string; line?: number; column?: number }
  | { type: 'check-file-exists'; terminalId: TerminalId; requestId: string; path: string };

export type ExtensionMessage =
  | { type: 'pty-data'; terminalId: TerminalId; data: string }
  | { type: 'pty-exit'; terminalId: TerminalId; exitCode: number }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'update-settings'; settings: { fontFamily?: string; fontSize?: number } }
  | { type: 'update-theme'; theme: ITheme }
  | { type: 'file-exists-result'; requestId: string; exists: boolean };
```

## Extension Handler

```typescript
// In terminal-manager.ts
case 'open-file':
  this.handleOpenFile(message.path, message.line, message.column);
  break;

case 'check-file-exists':
  this.handleCheckFileExists(message.requestId, message.path);
  break;

private async handleOpenFile(path: string, line?: number, column?: number): Promise<void> {
  try {
    const uri = vscode.Uri.file(path);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);

    if (line !== undefined) {
      const position = new vscode.Position(
        Math.max(0, line - 1), // Convert to 0-indexed
        column !== undefined ? Math.max(0, column - 1) : 0
      );
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenter
      );
    }
  } catch (error) {
    console.warn(`[bootty] Failed to open file: ${path}`, error);
  }
}

private async handleCheckFileExists(requestId: string, path: string): Promise<void> {
  const instance = this.getCurrentInstance(); // Need to track which terminal requested
  if (!instance) return;

  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(path));
    instance.panel.webview.postMessage({
      type: 'file-exists-result',
      requestId,
      exists: true,
    });
  } catch {
    instance.panel.webview.postMessage({
      type: 'file-exists-result',
      requestId,
      exists: false,
    });
  }
}
```

## Data Flow

```
Terminal output contains "src/index.ts:42"
        │
        ▼
ghostty-web write() detects path pattern
        │
        ▼
FilePathLinkProvider.provideLinks() called
        │
        ▼
postMessage({ type: 'check-file-exists', path: '/cwd/src/index.ts' })
        │
        ▼
Extension checks fs.stat()
        │
        ▼
postMessage({ type: 'file-exists-result', exists: true })
        │
        ▼
Link created with underline on hover
        │
        ▼
User Cmd+Clicks
        │
        ▼
postMessage({ type: 'open-file', path, line: 42 })
        │
        ▼
Extension opens editor at line 42
```

## CWD Tracking State

Track CWD per terminal instance:

```typescript
// types/terminal.ts
export interface TerminalInstance {
  id: TerminalId;
  config: Partial<TerminalConfig>;
  panel: vscode.WebviewPanel;
  ready: boolean;
  readyTimeout?: ReturnType<typeof setTimeout>;
  dataQueue: string[];
  currentCwd?: string; // <-- Add this
}
```

## Validation Rules

1. **Path must exist** - Only create link if file exists on disk
2. **Within workspace** - Optionally restrict to workspace paths for security
3. **Reasonable length** - Ignore very long "paths" that are likely false positives
4. **Valid characters** - Reject paths with invalid filesystem characters

## Performance Considerations

1. **Async validation** - File existence checks are async to avoid blocking
2. **Caching** - Cache file existence results to avoid repeated fs.stat calls
3. **Debouncing** - Don't check every path immediately; batch checks on hover
4. **Link detector invalidation** - Already implemented in ghostty-web

## Edge Cases

1. **No CWD set** - Fall back to workspace root or show absolute path only
2. **Path outside workspace** - Still open if file exists
3. **Symlinks** - Follow symlinks to real path
4. **Network paths** - May have slow validation; consider timeout
5. **Deleted files** - Link becomes inactive; show tooltip

## Testing

1. `ls -la` output with absolute paths -> links work
2. TypeScript error `src/foo.ts(42,10)` -> opens at line 42, col 10
3. `git diff` output -> a/b prefix stripped, link works
4. Relative path after `cd subdir` -> OSC 7 updates CWD, link resolves correctly
5. Non-existent file path -> no link created

## Security

1. **No arbitrary code execution** - Only open files in editor, never execute
2. **Path traversal** - Validate resolved path is reasonable
3. **Workspace restriction** - Optional setting to only allow workspace files

## Future Enhancements

- `Cmd+Click` on error to open file + show error tooltip
- Integration with Problems panel
- Support for `grep -n` output format
- Support for `find` output format
