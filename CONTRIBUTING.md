# Contributing to BooTTY

Thank you for your interest in contributing to the BooTTY VS Code extension!

## Development Setup

### Prerequisites
- Node.js 18+
- npm or pnpm
- VS Code 1.85+

### Getting Started

1. Clone the repository:
   ```bash
   git clone https://github.com/0xBigBoss/vscode-bootty.git
   cd vscode-bootty
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the extension:
   ```bash
   npm run build
   ```

4. Open in VS Code and press `F5` to launch the Extension Development Host.

## Project Structure

```
vscode-bootty/
├── src/
│   ├── extension.ts          # Extension entry point
│   ├── terminal-manager.ts   # Terminal lifecycle management
│   ├── panel-view-provider.ts # Panel-based terminal UI
│   ├── pty-service.ts        # PTY process management
│   ├── webview/
│   │   ├── main.ts           # Editor terminal webview script
│   │   ├── panel-main.ts     # Panel terminal webview script
│   │   ├── styles.css        # Editor terminal styles
│   │   └── panel-styles.css  # Panel terminal styles
│   └── types/
│       ├── messages.ts       # Message type definitions
│       └── terminal.ts       # Terminal type definitions
├── package.json              # Extension manifest
└── esbuild.config.mjs        # Build configuration
```

## Code Style

This project uses:
- **Biome** for linting and formatting
- **TypeScript** with strict mode
- **tsgo** for fast type checking

Run checks before committing:
```bash
npm run lint        # Check for issues
npm run lint:fix    # Auto-fix issues
npm run typecheck   # Type check
```

## Making Changes

1. Create a feature branch from `main`
2. Make your changes
3. Ensure all checks pass:
   ```bash
   npm run build && npm run typecheck && npm run lint
   ```
4. Commit with a descriptive message following conventional commits:
   - `feat:` New feature
   - `fix:` Bug fix
   - `docs:` Documentation
   - `refactor:` Code refactoring
   - `chore:` Maintenance tasks
5. Open a pull request

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for detailed architecture documentation.

## Testing

Run the test suite:
```bash
npm test
```

For manual testing, use the Extension Development Host (`F5`) and test:
- Terminal creation in panel and editor tabs
- Keyboard shortcuts
- File path detection and links
- Search functionality
- Theme switching

## Reporting Issues

When reporting bugs, please include:
- VS Code version
- Extension version
- Operating system
- Steps to reproduce
- Expected vs actual behavior

## License

By contributing, you agree that your contributions will be licensed under the project's license.
