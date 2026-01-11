# SPEC: Webview Terminal List UI

## Goal

Replace the VS Code TreeView-based terminal list with an in-webview terminal list component using `@vscode/webview-ui-toolkit`. This gives full control over layout, eliminating the 50-50 split issue caused by VS Code's panel view behavior (`visibility: "hidden"` doesn't work for panel views - confirmed via GitHub issue #140725).

## Design Principle

**Match VS Code's built-in terminal UX.** Only deviate from VS Code's design when it provides a clear improvement to DX/UX.

## Current State

- Panel webview (`src/webview/panel-main.ts`) manages multiple terminals internally
- Message protocol already supports: `add-tab`, `remove-tab`, `rename-tab`, `activate-tab`
- No visual tab/list UI in webview - terminals container takes 100% height
- External TreeView (`src/terminal-tree-provider.ts`) shows terminal list separately
- No split terminal support currently

## UI Framework

Using `@vscode/webview-ui-toolkit`:
- Native VS Code look and feel
- Automatic theme support via CSS custom properties
- Components: `vscode-button`, `vscode-text-field`, etc.
- ~50KB bundle size
- Custom CSS context menu (toolkit doesn't provide one)

## Layout Design

### Terminal List Position
- **Right-side vertical list** (matches VS Code's built-in terminal)
- Always visible (not collapsible)

### Sizing
- **Resizable width** via draggable divider
- Maximum: 50% of panel width
- Minimum: Shows icons only with small padding
- **Width persisted** via extension state (see State Persistence section)

### Responsive Behavior (CSS-based)
At progressively narrower widths:
1. Full width: icon + title + hover buttons (split, trash)
2. Narrower: hide hover buttons, truncate title with `...`
3. Narrowest: icons only with horizontal padding

## Terminal List Items

Each terminal entry displays:
- **Icon**: Customizable (default: terminal icon)
- **Title**: Customizable, truncates with `...` when narrow
- **Color indicator**: Optional colored bar/dot
- **Active indicator**: Highlighted background for active terminal
- **Hover buttons**: Split + Trash icons (hidden at narrow widths)

### Interactions and State Model

The list tracks two distinct states:

| State | Meaning | Visual Indicator |
|-------|---------|------------------|
| **Selected** | Which terminal(s) are shown in the display area | Bold text or subtle background |
| **Focused** | Which terminal has keyboard input focus | Highlighted background (active color) |

#### Selection vs Focus

- **Selection** determines which terminals are visible in the pane area (persisted as `activeTerminalId`)
- **Focus** determines which terminal receives keyboard input (transient, not persisted)
- A terminal can be selected but not focused (visible but not receiving input)
- **Focus requires visibility**: A terminal can only be focused if it is currently selected (visible). When selection changes to a different terminal/group, focus is **cleared** (set to null)
- The user must click in a pane to focus a terminal after selection changes

#### Click Behaviors

| Action | Effect on Selection | Effect on Focus |
|--------|---------------------|-----------------|
| Click standalone in list | Selects that terminal (shows it) | No change (must click pane) |
| Click grouped terminal in list | Selects entire group (shows split) | No change (must click pane) |
| Click in terminal pane | No change (already selected) | Focuses that terminal |
| Click split terminal already visible | No change | No change |

#### Detailed Rules

1. **Click standalone in list** → switches view to that terminal, but terminal pane is not focused (user must click in pane to type)
2. **Click grouped terminal in list** → switches view to that group (all panes visible), no focus change
3. **Click in terminal pane** → focuses that terminal, list updates highlight to show focused terminal
4. **Click grouped terminal when group already showing** → no effect (all panes already visible; user clicks in pane to focus)

#### Right-click and Drag
- **Right-click in list** → context menu (does not change selection or focus)
- **Drag in list** → reorder terminals (see Drag-and-Drop Behavior below)

## Split Terminals

### Layout
- **Horizontal split only** (side-by-side)
- **Unlimited splits** per group
- Terminals in a split group share the terminal display area **equally** (no user-resizable pane widths)
- **List order = pane order** (left-to-right in display matches top-to-bottom in list)

### Split Layout Sizing

Each pane in a split group gets equal width:
```
┌─────────────────────────────────────────┐
│ Pane 1 (33%) │ Pane 2 (33%) │ Pane 3 (33%) │
└─────────────────────────────────────────┘
```

**Per-pane dimensions:**
- Width: `(displayAreaWidth - (N-1) * dividerWidth) / N` where N = number of panes
- Height: Full display area height
- Each pane calculates its own terminal cols/rows based on its width

### Resize Message Protocol

The current architecture sends resize for the active terminal only. Split terminals require per-pane sizing:

#### Current (single terminal):
```typescript
// Webview → Extension
{ type: "terminal-resize"; terminalId: TerminalId; cols: number; rows: number }
```

#### Split-aware extension:
```typescript
// Webview → Extension (unchanged message type, but sent per-pane)
{ type: "terminal-resize"; terminalId: TerminalId; cols: number; rows: number }
```

**Resize flow for split groups:**
1. Display area resizes (window resize, list width change)
2. Webview calculates new pane dimensions for each terminal in visible group
3. Webview sends `terminal-resize` for **each visible terminal** with its new cols/rows
4. Extension resizes each PTY accordingly

#### When resize messages are sent:
- **Window resize** → resize all visible terminals
- **List width change** → resize all visible terminals (display area changed)
- **Terminal added to split** → resize all terminals in group (panes got narrower)
- **Terminal removed from split** → resize remaining terminals (panes got wider)
- **Switch to different group** → resize all terminals in newly visible group

### FitAddon Changes

Current `panel-main.ts` only fits the active terminal. With splits:
```typescript
// On resize, fit ALL visible terminals
function fitVisibleTerminals(): void {
  const visibleGroup = getVisibleGroup();
  for (const terminalId of visibleGroup.terminals) {
    const terminal = terminals.get(terminalId);
    terminal.fitAddon.fit();
    vscode.postMessage({
      type: "terminal-resize",
      terminalId,
      cols: terminal.term.cols,
      rows: terminal.term.rows,
    });
  }
}
```

### List Display (Tree Connectors)
VS Code uses Unicode box-drawing characters to show split grouping:
```
┌ Terminal 1      ← First/parent of group
├ Terminal 2      ← Middle child
└ Terminal 3      ← Last child
  Terminal 4      ← Standalone (no connector)
```

Tree connector characters:
- `┌` (U+250C) - First terminal in split group
- `├` (U+251C) - Middle terminal(s) in split group
- `└` (U+2514) - Last terminal in split group
- No prefix - Standalone terminal

### Behavior
- Killing a terminal in split: remaining terminal(s) expand to fill space
- If all terminals in group killed, group is removed
- **Keyboard shortcut**: `Cmd+\` (Mac) / `Ctrl+\` (Windows/Linux)

## Drag-and-Drop Behavior

Dragging reorders terminals. List order determines pane order for splits.

### Drag Gesture Rules

**Single rule**: Dragging a terminal reorders it **within its current scope**:

| Terminal Type | Drag Target Zone | Result |
|---------------|------------------|--------|
| Standalone | Between other standalones or groups | Reorders standalone position |
| Grouped | Within same group | Reorders pane position (left-to-right) |
| Grouped | Outside group boundaries | **Entire group moves** as a unit |

### Detailed Behavior

1. **Standalone terminals**: Drag to reorder among other standalones and group boundaries
2. **Terminals in a split group**:
   - Drag **within group** (drop between siblings) → reorders panes within the group
   - Drag **outside group** (drop between groups or standalones) → entire group moves as a unit
3. **Visual feedback**: Drop indicator shows whether drop will reorder within group or move entire group

### Drop Zone Detection

The list UI detects drop zones based on mouse position:
- Drop **between** items in same group → within-group reorder
- Drop **between** groups or standalones → group/standalone reorder

### What Drag Cannot Do
- **Cannot extract** a terminal from a split group to make it standalone
- **Cannot merge** a standalone into an existing split group
- Use context menu actions (Unsplit/Join) to change group membership

## Context Menu

Custom CSS-styled context menu positioned at click location. Uses VS Code CSS variables for theming.

### Menu Items
| Action | Shortcut | Notes |
|--------|----------|-------|
| Split Terminal | `Cmd+\` | Creates horizontal split with new terminal |
| Unsplit Terminal | | Only shown for grouped terminals. Removes from group to standalone (placed after remaining group). |
| Join Group → | | Submenu shown for standalone terminals when groups exist. Lists available groups. |
| Change Color... | | Opens color picker (VS Code's ~8 color palette) |
| Change Icon... | | Opens icon picker (VS Code's terminal icon set) |
| Rename... | | Opens inline text field or input box |
| Kill Terminal | `Cmd+Backspace` | Closes terminal |

### Join Group Target Selection

When "Join Group →" is selected, a **submenu** appears listing all existing split groups:

```
Join Group →  ┌ Terminal 1, Terminal 2    ← Group display name
              └ Terminal 5, Terminal 6    ← Another group
```

- Each submenu item shows the group's terminal titles (comma-separated, truncated)
- Clicking a group adds the standalone terminal to the **end** of that group (rightmost pane)
- If only one group exists, "Join Group" can be a direct action (no submenu)

### Group ID Semantics

Groups are identified by auto-generated UUIDs:
```typescript
interface TerminalGroup {
  id: string;              // UUID v4, generated when first split creates the group
  terminals: TerminalId[]; // Ordered list - first is leftmost pane
}
```

**Group lifecycle:**
1. **Created**: When user splits a terminal → new group with 2 terminals
2. **Expanded**: When user joins a terminal or splits within group → terminal added to `terminals` array
3. **Shrunk**: When terminal killed or unsplit → terminal removed from array
4. **Destroyed**: When only 1 terminal remains → group dissolved, terminal becomes standalone

**Group ID stability:**
- Group ID persists across VS Code restarts (stored in extension state)
- If all terminals in a group are killed, the group ID is deleted
- Joining a terminal to a group uses the existing group ID

### Excluded Actions (not feasible from webview)
- Move Terminal into Editor Area
- Move Terminal into New Window
- Toggle Size to Content Width

## State Persistence

### Single Source of Truth: Extension State

**All persistent state is owned by the extension** (`context.workspaceState`). The webview is stateless on restart - it receives all state from the extension via messages.

#### What Extension Persists (`context.workspaceState`)
- Terminal order (array of stable IDs)
- Terminal customizations (color, icon, userTitle)
- Split group configuration
- Active terminal ID
- **List width** (user's sizing preference)

#### What Webview Caches (`vscode.setState()`)
For fast restore when webview is hidden/shown **within the same VS Code session only**:
- Scroll position
- Transient UI state (hover, expanded menus)

**Important**: `vscode.setState()` is NOT used for restart persistence. On VS Code restart, webview state is lost and all state comes from extension.

### Stable Terminal IDs

Terminal IDs are UUIDs generated by the extension when a terminal is created:
```typescript
type TerminalId = string;  // UUID v4, e.g., "550e8400-e29b-41d4-a716-446655440000"
```

The extension maintains a persistent registry mapping IDs to terminal metadata:
```typescript
interface PersistedTerminalState {
  id: TerminalId;
  userTitle?: string;      // User-set name (vs auto-generated)
  icon?: string;           // Codicon name
  color?: string;          // Color from palette
  groupId?: string;        // Split group membership
  orderIndex: number;      // Position in list
}

interface PersistedWorkspaceState {
  terminals: PersistedTerminalState[];
  groups: TerminalGroup[];
  activeTerminalId?: TerminalId;  // Maps to SELECTION (which terminal/group is visible)
  listWidth: number;
}

// Note: focusedTerminalId is NOT directly persisted - it is DERIVED from activeTerminalId
// On restart, the active terminal is both selected AND focused (restored to ready-to-type state)
```

### Hydration Flow on VS Code Restart

The **extension is the source of truth** for terminal state. On restart, the extension recreates terminals using the existing `add-tab` message flow.

#### Message Sequence

```
Extension                              Webview
    |                                     |
    |--- (reads PersistedWorkspaceState) -|
    |                                     |
    |                   panel-ready ----->|
    |                                     |
    |<--- hydrate-state (UI config only) -|  (list width, UI prefs)
    |                                     |
    |  For each saved terminal:           |
    |    - spawn PTY with saved ID        |
    |    - add-tab (with customizations)->|  (title, icon, color, groupId)
    |                                     |
    |<--- terminal-ready ----------------|
    |                                     |
    |  After all terminals created:       |
    |--- activate-tab (saved active) ---->|
    |                                     |
    |--- focus-terminal ----------------->|
```

#### Detailed Steps

1. **Extension activates** → reads `PersistedWorkspaceState` from `context.workspaceState`
2. **Panel webview opens** → sends `panel-ready` message
3. **Extension sends `hydrate-state`** with UI-only config:
   ```typescript
   { type: "hydrate-state"; listWidth: number }  // No terminals - those come via add-tab
   ```
4. **For each saved terminal** (in saved order):
   - Extension spawns new PTY, associates with saved stable ID
   - Extension sends `add-tab` with saved customizations:
     ```typescript
     { type: "add-tab"; terminalId: "saved-uuid"; title: "saved-title";
       icon?: "saved-icon"; color?: "saved-color"; groupId?: "saved-group";
       makeActive: false }
     ```
   - Webview creates terminal entry and responds with `terminal-ready`
5. **Extension sends `activate-tab`** for saved active terminal ID → webview sets `selectedTerminalId`
6. **Extension sends `focus-terminal`** → webview sets `focusedTerminalId` to the active terminal

**Restart focus behavior**: On VS Code restart, the previously active terminal is restored to a **ready-to-type state** (both selected and focused). This matches VS Code's built-in terminal behavior.

#### Extended `add-tab` Message

The existing `add-tab` message is extended to include customizations:
```typescript
{ type: "add-tab";
  terminalId: TerminalId;
  title: string;
  makeActive: boolean;
  // NEW: optional customization fields for hydration
  icon?: string;
  color?: string;
  groupId?: string;
}
```

### Reconciliation Rules

When hydrating, handle mismatches gracefully:
- **Saved terminal with no PTY**: Skip it (can't restore shell state, remove from saved state)
- **Extra terminals in webview**: Should not happen (extension sends all terminals via `add-tab`)
- **Group references missing terminal**: Remove terminal ID from group, if group has <2 terminals, dissolve group

## Component Structure

### File Organization
```
src/webview/
├── panel-main.ts          # Main panel script (existing)
├── panel-styles.css       # Panel styles (existing)
├── panel-template.html    # Panel HTML (existing)
├── terminal-list.ts       # NEW: Terminal list component
├── terminal-list.css      # NEW: Terminal list styles
├── context-menu.ts        # NEW: Custom context menu component
├── context-menu.css       # NEW: Context menu styles
├── split-layout.ts        # NEW: Split terminal layout manager
└── search-controller.ts   # Search overlay (existing)
```

### Terminal List Component Interface
```typescript
interface TerminalListItem {
  id: TerminalId;
  title: string;
  icon?: string;        // Codicon name
  color?: string;       // Color from palette
  groupId?: string;     // For split terminals (null = standalone)
}

interface TerminalGroup {
  id: string;
  terminals: TerminalId[];  // Ordered list of terminals in split
}

interface TerminalListState {
  items: TerminalListItem[];
  groups: TerminalGroup[];
  listWidth: number;

  // Selection: which terminal/group is shown in display area
  // For standalone: the terminal ID
  // For grouped: any terminal ID in the group (entire group is selected)
  selectedTerminalId: TerminalId | null;

  // Focus: which terminal has keyboard input (cursor blinking, receives keystrokes)
  // Always a single terminal, or null if no terminal focused
  focusedTerminalId: TerminalId | null;
}

// Derived helper: get selected group ID from selected terminal
function getSelectedGroupId(state: TerminalListState): string | null {
  if (!state.selectedTerminalId) return null;
  const item = state.items.find(i => i.id === state.selectedTerminalId);
  return item?.groupId ?? null;
}
```

#### Focus Lifecycle

Focus represents which terminal pane has keyboard input. It is managed as follows:

| Event | Focus Behavior |
|-------|----------------|
| Click in terminal pane | Sets focus to that terminal |
| Click in list area (same terminal/group) | No change (terminal already visible) |
| Click in list area (different terminal/group) | Focus **cleared** (new selection, user must click pane) |
| Click in VS Code editor/other view | Focus cleared (webview lost focus) |
| Webview loses focus (blur event) | Focus cleared |

**Key principle**: Focus requires visibility. When selection changes to show different terminals, focus is cleared. The user must explicitly click in a terminal pane to focus it.

**Invariant**: `focusedTerminalId` is always null OR refers to a terminal that is currently visible (selected or in selected group).

```typescript
interface TerminalListEvents {
  onSelect: (id: TerminalId) => void;           // List click - changes selection
  onFocus: (id: TerminalId) => void;            // Pane click - changes focus
  onClose: (id: TerminalId) => void;
  onSplit: (id: TerminalId) => void;
  onUnsplit: (id: TerminalId) => void;
  onJoin: (id: TerminalId, targetGroupId: string) => void;
  onRename: (id: TerminalId, newTitle: string) => void;
  onReorder: (ids: TerminalId[]) => void;
  onColorChange: (id: TerminalId, color: string) => void;
  onIconChange: (id: TerminalId, icon: string) => void;
}
```

## Message Protocol Updates

### New Extension → Webview Messages
```typescript
| { type: "hydrate-state"; listWidth: number }  // UI config only; terminals come via add-tab
| { type: "update-terminal-color"; terminalId: TerminalId; color: string }
| { type: "update-terminal-icon"; terminalId: TerminalId; icon: string }
| { type: "split-terminal"; terminalId: TerminalId; newTerminalId: TerminalId; groupId: string; insertAfter: TerminalId }
| { type: "unsplit-terminal"; terminalId: TerminalId }  // Terminal removed from group, now standalone
| { type: "join-terminal"; terminalId: TerminalId; groupId: string }  // Terminal added to existing group
| { type: "group-created"; group: TerminalGroup }  // New split group formed
| { type: "group-destroyed"; groupId: string }  // Group dissolved (1 terminal left)
```

### Join Flow Message Sequence

1. **User selects "Join Group → [Group X]"** from context menu
2. **Webview sends**: `{ type: "join-requested"; terminalId: "abc"; targetGroupId: "xyz" }`
3. **Extension validates**: target group exists, terminal is standalone
4. **Extension persists**: updates `PersistedWorkspaceState` with new group membership
5. **Extension sends**: `{ type: "join-terminal"; terminalId: "abc"; groupId: "xyz" }`
6. **Webview updates**: moves terminal into group, updates list display with tree connector

### New Webview → Extension Messages
```typescript
| { type: "terminal-selected"; terminalId: TerminalId }  // User clicked in list, changes active/visible terminal
| { type: "split-requested"; terminalId: TerminalId }
| { type: "unsplit-requested"; terminalId: TerminalId }
| { type: "join-requested"; terminalId: TerminalId; targetGroupId: string }
| { type: "terminal-color-changed"; terminalId: TerminalId; color: string }
| { type: "terminal-icon-changed"; terminalId: TerminalId; icon: string }
| { type: "terminals-reordered"; terminalIds: TerminalId[] }
| { type: "list-width-changed"; width: number }  // User resized list divider
```

### Selection Change Protocol

Selection changes can be initiated by the webview (user clicks) OR by the extension (programmatic activation).

#### Webview-Initiated Selection (User Clicks in List)

1. **User clicks terminal in list** (different from current selection)
2. **Webview clears focus** (focusedTerminalId = null)
3. **Webview updates selection** (selectedTerminalId = clicked terminal)
4. **Webview sends**: `{ type: "terminal-selected"; terminalId: "abc" }`
5. **Extension persists**: updates `activeTerminalId` in `PersistedWorkspaceState`
6. **Extension does NOT send ack** - webview already updated UI optimistically

#### Extension-Initiated Selection (Programmatic Activation)

Used during hydration, new terminal creation, and other extension-driven scenarios:

1. **Extension sends**: `{ type: "activate-tab"; terminalId: "abc" }`
2. **Webview clears focus** (focusedTerminalId = null)
3. **Webview updates selection** (selectedTerminalId = activated terminal)
4. **Webview does NOT echo back** `terminal-selected` - extension already knows

**Note**: `activate-tab` is the existing message type in `src/types/messages.ts`. It serves as the extension → webview counterpart to `terminal-selected`.

#### When to Send `focus-terminal` After Activation

`activate-tab` only changes **selection** (visibility). To give keyboard focus, the extension must also send `focus-terminal`:

| Scenario | Send `activate-tab`? | Send `focus-terminal`? | Result |
|----------|---------------------|------------------------|--------|
| Hydration (restart) | Yes | Yes | Terminal ready to type |
| New terminal created | Yes | Yes | Terminal ready to type |
| Auto-create (last killed) | Yes | Yes | Terminal ready to type |
| Split terminal created | No (group already visible) | No | Focus stays on source |

**Rule**: When creating a new standalone terminal that should be ready for user input, always send `activate-tab` followed by `focus-terminal`.

#### Summary

| Direction | Message | Purpose |
|-----------|---------|---------|
| Webview → Extension | `terminal-selected` | User clicked in list, persist new active |
| Extension → Webview | `activate-tab` | Programmatic activation (hydration, new terminal) |

For grouped terminals, the `terminalId` refers to any terminal in the group - the entire group becomes visible.

### Split Creation Message Sequence

1. **User presses `Cmd+\` or clicks "Split Terminal"** from context menu
2. **Webview sends**: `{ type: "split-requested"; terminalId: "abc" }`
3. **Extension validates**: terminal exists
4. **Extension creates**: new PTY with new UUID, creates or expands group
5. **Extension persists**: updates `PersistedWorkspaceState`:
   - If standalone → create new `TerminalGroup` with both terminals, assign `groupId`
   - If already grouped → **insert new terminal immediately after source** in group's `terminals` array
6. **Extension sends** (in order):
   - If new group: `{ type: "group-created"; group: { id: "xyz", terminals: ["abc", "new-id"] } }`
   - `{ type: "split-terminal"; terminalId: "abc"; newTerminalId: "new-id"; groupId: "xyz"; insertAfter: "abc" }`
   - `{ type: "add-tab"; terminalId: "new-id"; title: "bash"; makeActive: false; groupId: "xyz" }`
7. **Webview updates**:
   - Creates new terminal entry with `groupId`
   - **Inserts new terminal immediately after source** in list (using `insertAfter` from message)
   - Updates original terminal with `groupId` (if was standalone)
   - Adds tree connector prefixes to list items
   - Recalculates pane widths and sends `terminal-resize` for all panes in group
8. **Focus/Selection outcome**: New terminal is added to group but focus stays on original terminal

#### Insertion Position Rule

New split terminals are **always inserted immediately to the right of the source terminal** (in pane order) / **immediately below in list order**:

```
Before split of "Terminal 2":        After split:
┌ Terminal 1                         ┌ Terminal 1
├ Terminal 2  ← split this           ├ Terminal 2  ← source
└ Terminal 3                         ├ Terminal 2 (new)  ← inserted here
                                     └ Terminal 3
```

This matches VS Code's built-in terminal split behavior where the new pane appears to the right of the split source.

### Unsplit Message Sequence

1. **User selects "Unsplit Terminal"** from context menu on a grouped terminal
2. **Webview sends**: `{ type: "unsplit-requested"; terminalId: "abc" }`
3. **Extension validates**: terminal exists and is in a group
4. **Extension updates group**: removes terminal from group's `terminals` array
5. **Extension persists**: updates `PersistedWorkspaceState`:
   - If group now has 1 terminal → dissolve group (remove `groupId` from remaining terminal)
   - If group still has 2+ terminals → group remains, tree connectors update
6. **Extension sends** (in order):
   - `{ type: "unsplit-terminal"; terminalId: "abc" }`
   - If group dissolved: `{ type: "group-destroyed"; groupId: "xyz" }`
7. **Webview updates**:
   - Removes `groupId` from unsplit terminal (now standalone)
   - **Places standalone immediately after the remaining group** in list order
   - Updates tree connector prefixes for remaining group members
   - If unsplit terminal was visible, it remains selected (now shows alone instead of in split)

#### Unsplit Placement Rule

The unsplit terminal is **placed immediately after the remaining group** in list order:

```
Before unsplit "Terminal 2":         After unsplit:
┌ Terminal 1                         ┌ Terminal 1
├ Terminal 2  ← unsplit this         └ Terminal 3
└ Terminal 3                           Terminal 2  ← standalone, placed after group
  Terminal 4                           Terminal 4
```

**Rationale**: Placing the terminal after the group keeps related items visually near each other and maintains a predictable list order.

**Edge case - Group dissolves** (unsplitting leaves only 1 terminal):
```
Before unsplit "Terminal 2":         After unsplit:
┌ Terminal 1                           Terminal 1  ← now standalone (was first in group)
└ Terminal 2  ← unsplit this           Terminal 2  ← now standalone (placed after)
  Terminal 3                           Terminal 3
```

Both terminals become standalone. The originally first terminal stays in place; the unsplit terminal is placed immediately after it.

## Color Palette

Match VS Code's terminal color options:
```typescript
const TERMINAL_COLORS = [
  { name: "red", value: "#f14c4c" },
  { name: "orange", value: "#f5a623" },
  { name: "yellow", value: "#e2c541" },
  { name: "green", value: "#4fb86e" },
  { name: "blue", value: "#3b8eea" },
  { name: "purple", value: "#a95ec7" },
  { name: "magenta", value: "#e3699e" },
  { name: "cyan", value: "#4ec9b0" },
] as const;
```

## Icon Set

Use VS Code's Codicons. Relevant terminal icons:
- `terminal` (default)
- `terminal-bash`
- `terminal-cmd`
- `terminal-powershell`
- `star`
- `flame`
- `bug`
- `beaker`
- `rocket`
- `heart`
- `zap`
- `cloud`

## Empty State and Last Terminal Behavior

### Panel Open: Auto-Create First Terminal

When the panel opens with no terminals (fresh start or all terminals killed):
1. Extension automatically creates a new terminal
2. Sends `add-tab` to webview
3. User sees a terminal immediately - no empty state UI

### Killing the Last Terminal

When user kills the only remaining terminal:
1. Terminal is removed from list
2. **Extension immediately creates a new terminal** (same as panel open behavior)
3. New terminal appears in list and display area
4. User always has at least one terminal available

**Rationale**: This matches VS Code's built-in terminal behavior where closing the last terminal in a panel causes a new one to be created. An empty terminal panel provides no value.

### Testing
- [ ] Killing last terminal auto-creates new terminal
- [ ] New terminal receives focus after auto-create
- [ ] No empty state UI is ever shown

## Migration Plan

### Pre-Migration: Remove Webview-Driven Restore Path

**Breaking change required**: The current implementation in `src/panel-view-provider.ts` uses webview-driven restore where:
1. Webview reads `context.state` on load (`src/panel-view-provider.ts:63`)
2. Webview sends `new-tab-requested-with-title` on `panel-ready` (`src/panel-view-provider.ts:102`)

This conflicts with the new extension-driven hydration flow where the extension owns all state and sends `add-tab` messages.

**Must remove before Phase 1:**
1. Remove `context.state` reading from webview initialization
2. Remove `new-tab-requested-with-title` handling from `panel-ready` flow
3. Ensure webview waits for extension to send `hydrate-state` and `add-tab` messages
4. Update extension to persist/restore terminal state via `context.workspaceState`

**If not removed**: Terminals will be duplicated on restart (both webview and extension will try to create terminals).

### Phase 1: Add Terminal List UI
1. Add `@vscode/webview-ui-toolkit` dependency
2. Create `terminal-list.ts` component
3. Create `context-menu.ts` component
4. Update `panel-template.html` layout
5. Update `panel-styles.css` with list styles

### Phase 2: Add Split Terminals
1. Create `split-layout.ts` for managing split panes
2. Update terminal container to support side-by-side layout
3. Wire up split keyboard shortcut (`Cmd+\`)
4. Handle split group state in list

### Phase 3: Add Customization
1. Implement color picker UI
2. Implement icon picker UI
3. Add color/icon to terminal list items
4. Persist customizations in extension state (`context.workspaceState`)

### Phase 4: Add Drag-and-Drop
1. Implement drag-and-drop reordering in list
2. Persist order in extension state (`context.workspaceState`)
3. Communicate order changes to extension via `terminals-reordered` message

### Phase 5: Remove TreeView
1. Remove `boottyTerminalList` from `package.json` views
2. Remove `src/terminal-tree-provider.ts`
3. Clean up related code in `src/extension.ts`
4. Update keybindings/commands if needed

## Testing

### Terminal List
- [ ] Single terminal: list shows one item, selected and focused
- [ ] Click standalone in list → selects (shows) that terminal, does NOT focus pane
- [ ] Click grouped terminal in list → selects (shows) entire group, does NOT focus pane
- [ ] Click in pane → focuses that terminal, list updates to show focused indicator
- [ ] Selection and focus are visually distinct (bold vs highlighted background)
- [ ] Right-click opens context menu (does not change selection or focus)
- [ ] Hover shows split/trash buttons

### Customization
- [ ] Rename: opens input, persists across sessions
- [ ] Change Color: shows palette, applies to item
- [ ] Change Icon: shows picker, applies to item

### Close/Kill
- [ ] Close button removes terminal
- [ ] If active, activates adjacent terminal
- [ ] In split, remaining terminal expands

### Split
- [ ] Cmd+\ creates horizontal split with new terminal
- [ ] Split terminals shown with tree connectors (┌├└) in list
- [ ] All terminals in split group visible side-by-side in display
- [ ] Panes share width equally (no resizable pane dividers)
- [ ] Clicking split terminal in list has no effect (all already visible)
- [ ] Clicking in a split pane updates list highlight to that terminal
- [ ] Killing split terminal expands remaining siblings
- [ ] All visible panes resize on window resize (resize message sent per-pane)
- [ ] Adding terminal to split resizes all panes in group

### Drag and Drop
- [ ] Drag standalone terminal to reorder among standalones/groups
- [ ] Drag grouped terminal, drop **within same group** → reorders panes
- [ ] Drag grouped terminal, drop **outside group** → moves entire group
- [ ] Visual drop indicator distinguishes within-group vs group-move
- [ ] Cannot extract terminal from group via drag
- [ ] Cannot merge standalone into group via drag
- [ ] Order persists across sessions

### Unsplit/Join
- [ ] Unsplit removes terminal from group to standalone
- [ ] Join submenu lists all existing groups with terminal titles
- [ ] Join adds standalone to end of selected group (rightmost pane)
- [ ] If only one group exists, Join is direct action (no submenu)
- [ ] Unsplit only shown for grouped terminals
- [ ] Join only shown when groups exist
- [ ] Group destroyed when last terminal unsplit (remaining terminal becomes standalone)

### Resize
- [ ] Drag divider to resize list width
- [ ] Width persists across sessions
- [ ] Respects min/max constraints
- [ ] Responsive: truncates titles, hides buttons at narrow widths

### Theme
- [ ] UI respects VS Code theme
- [ ] Dark/light mode switching works
- [ ] Custom theme colors work

### State Persistence
- [ ] List width restored after webview hidden/shown (from extension state via hydrate-state)
- [ ] Extension state (order, customizations, groups, list width) restored after VS Code restart
- [ ] Hydration message sent on panel-ready with saved state
- [ ] Terminal IDs are stable UUIDs that survive restarts
- [ ] Dangling group references (killed terminals) handled gracefully
- [ ] Active terminal restored to focused state after restart

## Open Questions

None - all design decisions captured.
