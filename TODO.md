# TODO - VS Code-style Bell Indicators

## Completed
- [x] Add hasBell property to TerminalListItem interface (iteration 1)
- [x] Add setBellIndicator method to TerminalList class (iteration 1)
- [x] Update renderItem to show bell icon when hasBell is true (iteration 1)
- [x] Clear bell indicator on terminal activation - setActive(), setFocused(), handleItemClick() (iteration 1)
- [x] Add bell-indicator CSS styles to panel-styles.css with pulse animation (iteration 1)
- [x] Modify onBell handler in panel-main.ts to call setBellIndicator for non-active terminals (iteration 1)
- [x] Run verification - typecheck passes (iteration 1)
- [x] Run verification - lint passes (after auto-fix) (iteration 1)
- [x] Run verification - build succeeds (iteration 1)
- [x] Remove .claude/ralph-loop.local.md from VCS and add to .gitignore (iteration 2)
- [x] Remove bell-flash visual behavior from onBell handler (iteration 2)
- [x] Run verification - all checks pass (iteration 2)

## In Progress
- [ ] None

## Pending
- [ ] None

## Blocked
- [ ] None

## Notes
- Bell indicator shows inline with terminal name in the terminal list (matches VS Code style)
- Bell only appears for non-active terminals (background terminals)
- Bell clears when terminal becomes active, focused, or clicked
- Yellow color uses VS Code theme variables for consistency
- Pulse animation provides visual feedback when bell appears
- Removed screen flash behavior - now only shows bell icon in list
- .claude/*.local.md files are excluded from VCS
