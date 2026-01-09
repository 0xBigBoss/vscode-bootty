# Cross-Platform Build System

## Overview

Build native node-pty binaries for all major platforms using Docker, enabling vscode-ghostty to work on remote hosts (SSH, WSL, containers) without requiring compilation on the target machine.

## Problem

- node-pty npm package only ships prebuilds for darwin (macOS) and win32 (Windows)
- Linux requires compilation from source, which doesn't happen when VS Code extracts a vsix
- Extension fails to activate on Linux remote hosts with "command not found" error

## Goals

- Build node-pty native binaries for Linux platforms (glibc and musl)
- Single script runnable locally and in CI (GitHub Actions)
- Use Docker as the build host for reproducibility
- Package all platform binaries into the vsix

## Target Platforms

| Platform | Source | Notes |
|----------|--------|-------|
| darwin-x64 | npm prebuild | Preserve existing |
| darwin-arm64 | npm prebuild | Preserve existing |
| win32-x64 | npm prebuild | Preserve existing |
| win32-arm64 | npm prebuild | Preserve existing |
| linux-x64 | Docker build | glibc 2.28 (Debian 10/buster base) |
| linux-arm64 | Docker build | glibc 2.28 (Debian 10/buster base) |
| linux-x64-musl | Docker build | Alpine 3.16+ |
| linux-arm64-musl | Docker build | Alpine 3.16+ |

### Platform Requirements

- **Node.js**: Target VS Code's bundled Node version (~v20). node-pty uses NAPI for ABI compatibility.
- **glibc**: 2.28+ (matches VS Code Remote SSH minimum requirement)
- **musl**: Alpine 3.16+ (VS Code supported for containers/WSL)

## Implementation

### Script Interface

```bash
# Build all Linux platforms
npm run build:native

# Build specific platform(s)
npm run build:native -- --platform linux-x64
npm run build:native -- --platform linux-x64,linux-arm64

# Force rebuild (ignore cache)
npm run build:native -- --force
```

### Script Location

`scripts/build-native.mjs` (ES module for modern Node.js)

### Docker Images

| Platform | Base Image |
|----------|------------|
| linux-x64 | node:20-buster |
| linux-arm64 | node:20-buster |
| linux-x64-musl | node:20-alpine |
| linux-arm64-musl | node:20-alpine |

### Build Process

1. **Check prerequisites**: Verify Docker is available, error with clear message if not
2. **Determine platforms**: All Linux platforms by default, or subset via `--platform` flag
3. **Check cache**: Skip platforms where `prebuilds/<platform>/pty.node` exists (unless `--force`)
4. **For each platform**:
   a. Pull/use Docker image for target platform
   b. Run container with project mounted
   c. Install build dependencies (python3, make, g++)
   d. Run `npm rebuild` for node-pty
   e. Copy `build/Release/pty.node` to `prebuilds/<platform>/`
   f. **Smoke test**: Load the .node file in a matching Docker container to verify
5. **Fail fast**: If any platform fails, abort immediately

### Output Location

`node_modules/node-pty/prebuilds/<platform>/pty.node`

This location is automatically picked up by `vsce package` without additional configuration.

### Smoke Test

For each built binary, verify it loads correctly:

```bash
docker run --platform linux/amd64 -v ./prebuilds:/prebuilds node:20-buster \
  node -e "require('/prebuilds/linux-x64/pty.node')"
```

## CI Integration

### GitHub Actions Workflow

`.github/workflows/build-native.yml`

**Triggers**:
- `workflow_dispatch` (manual, for testing)
- `push` to tags matching `v*` (releases)

**Jobs**:
1. Build all Linux native binaries using the npm script
2. Upload prebuilds as artifacts
3. (On release) Include in vsix packaging

### Required CI Configuration

- Docker must be available (GitHub-hosted runners have Docker)
- QEMU for arm64 cross-compilation: `docker/setup-qemu-action`

## Error Handling

| Condition | Behavior |
|-----------|----------|
| Docker not available | Exit with error and installation instructions |
| Platform build fails | Fail fast, abort all remaining platforms |
| Smoke test fails | Treat as build failure |
| Unknown `--platform` value | Exit with error listing valid platforms |

## Success Criteria

- [ ] `npm run build:native` produces Linux prebuilds on macOS/Linux host
- [ ] Built vsix installs and activates on Linux x64 remote host
- [ ] Built vsix installs and activates on Alpine Linux container
- [ ] GitHub Actions workflow builds natives on release tags
- [ ] Script errors clearly when Docker is unavailable
- [ ] `--platform` flag builds subset correctly
- [ ] `--force` flag rebuilds even when cache exists
- [ ] Smoke tests catch ABI mismatches before packaging

## File Changes

| File | Change |
|------|--------|
| `package.json` | Add `build:native` script |
| `scripts/build-native.mjs` | New build script |
| `.github/workflows/build-native.yml` | New CI workflow |
| `.gitignore` | Ignore `node_modules/node-pty/prebuilds/linux-*` (built artifacts) |

## Future Considerations

- Consider caching Docker layers in CI for faster builds
- May need to pin exact Node.js version if ABI issues arise
- Could add `--dry-run` flag for debugging
- Windows native builds via Docker are complex; rely on npm prebuilds for now
