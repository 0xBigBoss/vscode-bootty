# SPEC: Terminal Benchmark Suite

## Goal
Provide apples-to-apples performance comparison across terminal emulators to validate ghostty-vscode performance claims.

## Methodology Limitations

Shell-based benchmarks have inherent limitations:
- **No direct render sync**: Cannot directly measure when pixels are drawn
- **Best-effort sync**: Use DSR (Device Status Report) escape sequence to synchronize
- **Terminal width affects scrollback**: Line counts depend on terminal width (line wrapping)
- **Results are relative**: Compare terminals under identical conditions

## Target Terminals
- ghostty_vscode (ghostty-web in VS Code webview)
- VS Code built-in terminal (xterm.js)
- Native Ghostty
- iTerm2
- Terminal.app (baseline)

## Metrics

### 1. Throughput (MiB/s)
Measure data rendering speed by timing display of pre-generated data.

**Method**: Pre-generate 10 MiB data file, then time only the display + DSR sync
```bash
# Data pre-generated before timing
cat "$THROUGHPUT_DATA_FILE"
sync_terminal  # DSR sync
```

### 2. Scrollback Stress (lines/sec)
Measure line output rate under sustained high-frequency output.

**Note**: Metric is lines_per_sec (source lines), not FPS. Actual rendered lines depend on terminal width.

**Test**: Rapid line output for 5 seconds
```bash
timeout 5 yes "$(printf 'x%.0s' {1..200})"
```

### 3. Color/SGR Performance
Measure overhead of ANSI escape sequence parsing and rendering.

**Test**: Render 1000 lines with full 256-color cycling + DSR sync
```bash
for i in {1..1000}; do
  for c in {0..255}; do printf "\e[38;5;${c}m█"; done
  echo
done
sync_terminal
```

### 4. Unicode Rendering
Measure complex text shaping with mixed-width characters.

**Test**: Render CJK + emoji mixed content + DSR sync
```bash
for i in {1..500}; do
  echo "日本語テスト 🎉🚀💻 中文测试 한국어 テスト emoji: 👨‍👩‍👧‍👦"
done
sync_terminal
```

### 5. Cursor Movement
Measure terminal control sequence performance using actual terminal dimensions.

**Test**: Random cursor positioning within current terminal size + DSR sync
```bash
term_size=$(stty size)  # Use actual dimensions
for i in {1..1000}; do
  row=$((RANDOM % rows + 1))
  col=$((RANDOM % cols + 1))
  printf "\e[${row};${col}H*"
done
sync_terminal
```

## Synchronization

All tests use DSR (Device Status Report) to synchronize:
```bash
sync_terminal() {
  printf '\e[5n'        # Request device status
  read -t 0.5 response  # Wait for CSI 0 n response
}
```

This ensures the terminal has processed all preceding escape sequences before stopping the timer.

## Benchmark Runner

### Design
Shell script that runs in any terminal, outputs structured JSON results with full statistics.

```
benchmarks/
├── SPEC.md           # This file
├── run.sh            # Main runner (contains all tests)
├── compare.sh        # Results comparison tool
└── results/          # JSON output per terminal
    └── {terminal}-{timestamp}.json
```

### Dependencies
- `jq` - JSON processing (brew install jq / apt install jq)
- `bc` - Floating point math (brew install bc / apt install bc)
- `base64` - Data encoding (usually pre-installed)
- `timeout` / `gtimeout` - Process timeout (brew install coreutils / apt install coreutils)
- `gdate` or `perl` - High-precision timing on macOS (brew install coreutils)
- `stty` - Terminal size detection (usually pre-installed)

### Output Format
```json
{
  "terminal": "ghostty_vscode",
  "timestamp": "2024-01-15T10:30:00Z",
  "system": {
    "os": "darwin",
    "arch": "arm64",
    "cpu": "Apple M2",
    "memory_gb": 16,
    "terminal_rows": 40,
    "terminal_cols": 120
  },
  "results": {
    "throughput": {
      "mib_per_sec": 45.2,
      "duration_ms": 228,
      "bytes": 10485760,
      "median_duration_ms": 228,
      "min_duration_ms": 220,
      "max_duration_ms": 235,
      "avg_duration_ms": 227,
      "variance_pct": 6.6,
      "runs": 3,
      "all_runs": [...]
    },
    "scrollback": {
      "lines_rendered": 50000,
      "duration_ms": 5000,
      "lines_per_sec": 10000,
      "variance_pct": 2.1,
      "runs": 3,
      "all_runs": [...]
    },
    "colors": {
      "duration_ms": 1200,
      "lines": 1000,
      "colors_per_line": 256,
      "variance_pct": 3.5,
      "runs": 3,
      "all_runs": [...]
    },
    "unicode": {
      "duration_ms": 800,
      "lines": 500,
      "variance_pct": 5.0,
      "runs": 3,
      "all_runs": [...]
    },
    "cursor": {
      "operations": 1000,
      "duration_ms": 150,
      "grid_rows": 40,
      "grid_cols": 120,
      "variance_pct": 4.2,
      "runs": 3,
      "all_runs": [...]
    }
  }
}
```

### Usage
```bash
# Run all benchmarks in current terminal
./benchmarks/run.sh

# Run specific test
./benchmarks/run.sh throughput

# Compare results
./benchmarks/compare.sh results/*.json
```

## Statistical Validity

Each test runs 3 times and reports:
- **Median**: Primary metric (middle run)
- **Min/Max**: Range of results
- **Variance %**: (max - min) / median × 100

Results with variance > 10% should be re-run or investigated for interference.

All individual run results are stored in `all_runs` array for post-hoc analysis.

## Prior Art Integration

### xterm.js Benchmark
The xterm.js project has its own benchmark at `xterm.js/demo/benchmark/`. Consider:
- Running their benchmark in VS Code's xterm.js terminal
- Extracting comparable metrics
- Noting methodology differences

### vtebench
Reference vtebench patterns for additional test cases if needed.

## Success Criteria
- All benchmarks runnable from any terminal via shell
- Results are reproducible (< 10% variance between runs)
- JSON output enables automated comparison
- Terminal size recorded for cursor test comparability
- All individual runs stored for variance analysis

## Implementation Notes
- Use `gdate` (GNU date) for nanosecond precision on macOS
- Warm up terminal before benchmarks (run simple command first)
- Run each test 3x and report median with variance
- Detect terminal via $TERM_PROGRAM for automatic labeling
- Pre-generate throughput data to isolate rendering from CPU overhead
- Use DSR sync after each test to measure render completion
- Record terminal dimensions for fair cursor test comparison
