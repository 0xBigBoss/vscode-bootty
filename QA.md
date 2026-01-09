# QA Checklist - BooTTY Extension

## Prerequisites

1. Open the `vscode-bootty` folder in VS Code
2. Run `npm install` and `npm run build`
3. Press `F5` to launch Extension Development Host

---

## 1. Basic Terminal Functionality

### 1.1 Terminal Creation
- [ ] Run command `BooTTY: New Terminal` from Command Palette (Cmd/Ctrl+Shift+P)
- [ ] Terminal panel opens in editor area
- [ ] Shell prompt appears within 2 seconds

### 1.2 Input/Output
- [ ] Type `echo "hello world"` → output appears correctly
- [ ] Type `ls -la` → directory listing shows with colors
- [ ] Run `cat` and type multiple lines → input echoes correctly
- [ ] Press Ctrl+D to exit cat

### 1.3 Environment
- [ ] Run `echo $TERM_PROGRAM` → shows `bootty`
- [ ] Run `echo $COLORTERM` → shows `truecolor`
- [ ] Run `echo $SHELL` → shows your default shell

### 1.4 Resize
- [ ] Drag panel edges to resize → terminal content reflows
- [ ] Run `tput cols; tput lines` before and after resize → values change

### 1.5 Exit
- [ ] Type `exit` → terminal shows exit message
- [ ] Panel closes after brief delay (~1.5s)

---

## 2. Keybinding Passthrough (#2)

### 2.1 Mac-specific
- [ ] **Cmd+P** → VS Code Quick Open (not captured by terminal)
- [ ] **Cmd+Shift+P** → VS Code Command Palette
- [ ] **Cmd+C** (with selection) → Copies selected text
- [ ] **Cmd+V** → Pastes from clipboard
- [ ] **Cmd+N** → Opens new file (bubbles to VS Code)
- [ ] **Ctrl+C** → Sends SIGINT (interrupt running process like `sleep 100`)
- [ ] **Ctrl+D** → Sends EOF (exits shell or `cat`)
- [ ] **Ctrl+L** → Clears screen
- [ ] **Ctrl+Z** → Suspends process (run `sleep 100`, then Ctrl+Z)

### 2.2 Windows/Linux-specific
- [ ] **Ctrl+Shift+P** → VS Code Command Palette
- [ ] **Ctrl+C** (with selection) → Copies selected text
- [ ] **Ctrl+C** (no selection) → Sends SIGINT
- [ ] **Ctrl+V** → Pastes from clipboard
- [ ] **Ctrl+D** → Sends EOF
- [ ] **Ctrl+L** → Clears screen
- [ ] **Ctrl+Z** → Suspends process

---

## 3. Custom Fonts (#3)

### 3.1 Settings
- [ ] Open Settings → search "bootty"
- [ ] `bootty.fontFamily` and `bootty.fontSize` settings appear

### 3.2 Font Family
- [ ] Set `bootty.fontFamily` to `"Courier New"` → font changes immediately
- [ ] Clear setting → falls back to `terminal.integrated.fontFamily`
- [ ] Clear both → falls back to monospace default

### 3.3 Font Size
- [ ] Set `bootty.fontSize` to `20` → font size increases
- [ ] Verify terminal dimensions change (run `tput cols; tput lines`)
- [ ] Set to `12` → font size decreases
- [ ] Set to `0` → falls back to `terminal.integrated.fontSize`

### 3.4 Hot Reload
- [ ] With terminal open, change font size in settings
- [ ] Terminal updates without restart
- [ ] New dimensions are sent to PTY (verify with `tput cols; tput lines`)

---

## 4. Custom Themes (#4)

### 4.1 Theme Colors
- [ ] Run `ls --color=auto` or colorful command → ANSI colors render
- [ ] Colors match VS Code's terminal theme

### 4.2 Theme Switching
- [ ] Open Command Palette → "Preferences: Color Theme"
- [ ] Switch from dark to light theme
- [ ] Terminal background/foreground update (new content uses new colors)
- [ ] **Note**: Existing text keeps original colors (documented limitation)

### 4.3 Color Customizations
- [ ] Add to settings.json:
  ```json
  "workbench.colorCustomizations": {
    "terminal.background": "#1a1a2e",
    "terminal.foreground": "#eaeaea"
  }
  ```
- [ ] Terminal colors update to match

---

## 5. Open File in Editor (#8)

### 5.1 File Path Detection
Setup: Create a test file first:
```bash
echo "test content" > /tmp/testfile.txt
```

- [ ] Run `ls /tmp/testfile.txt` → path appears in output
- [ ] Hover over path → underline appears (link detected)
- [ ] **Cmd/Ctrl+Click** on path → file opens in editor

### 5.2 Line/Column Navigation
- [ ] Create a multi-line file:
  ```bash
  printf "line1\nline2\nline3\n" > /tmp/lines.txt
  ```
- [ ] Echo path with line number: `echo "/tmp/lines.txt:2"`
- [ ] Cmd/Ctrl+Click → opens file at line 2

### 5.3 Compiler-style Output
- [ ] Echo TypeScript-style error: `echo "src/index.ts(42,10): error"`
- [ ] If `src/index.ts` exists, Cmd/Ctrl+Click opens at line 42, col 10

### 5.4 Relative Paths
- [ ] `cd` to a directory with files
- [ ] Run `ls *.ts` or similar → relative paths shown
- [ ] Cmd/Ctrl+Click on relative path → opens correct file

### 5.5 Non-existent Files
- [ ] Echo a fake path: `echo "/nonexistent/fake.txt"`
- [ ] Hover → no underline (file doesn't exist, no link created)

### 5.6 Plain Click (Negative Test)
- [ ] Click on a file path WITHOUT Cmd/Ctrl held
- [ ] File should NOT open (requires modifier key)

### 5.7 Windows Paths (if on Windows)
- [ ] Echo Windows path: `echo "C:\Users\test.txt"`
- [ ] Path detected and clickable (if file exists)

---

## 6. URL Links

### 6.1 HTTP/HTTPS Links
- [ ] Echo a URL: `echo "https://github.com"`
- [ ] Hover → underline appears
- [ ] Cmd/Ctrl+Click → opens in external browser

### 6.2 Non-HTTP Schemes
- [ ] `mailto:` links work
- [ ] `ssh://` links work
- [ ] Dangerous schemes (file://, vscode://, command://) are blocked

---

## 7. Multiple Terminals

- [ ] Open multiple terminals (run command multiple times)
- [ ] Each terminal has independent state
- [ ] Closing one doesn't affect others
- [ ] Settings changes apply to all open terminals

---

## 8. Error Handling

### 8.1 Invalid Shell
- [ ] Set `terminal.integrated.shell.osx` to invalid path
- [ ] Open terminal → error message shown

### 8.2 Webview Load Failure
- [ ] (Hard to test) If webview fails to load within 10s, timeout error shown

---

## Test Results

| Section | Pass | Fail | Notes |
|---------|------|------|-------|
| 1. Basic Terminal | | | |
| 2. Keybinding Passthrough | | | |
| 3. Custom Fonts | | | |
| 4. Custom Themes | | | |
| 5. Open File in Editor | | | |
| 6. URL Links | | | |
| 7. Multiple Terminals | | | |
| 8. Error Handling | | | |

**Tester**: ________________
**Date**: ________________
**Platform**: macOS / Windows / Linux
**VS Code Version**: ________________
