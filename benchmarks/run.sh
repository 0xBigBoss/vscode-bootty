#!/bin/bash
# Terminal Benchmark Suite
# Run from any terminal to measure performance
#
# METHODOLOGY NOTES:
# - Shell-based benchmarks cannot directly measure render completion
# - We use DSR (Device Status Report) as a synchronization point to ensure
#   the terminal has processed all preceding escape sequences
# - Throughput uses pre-generated data to isolate rendering from CPU overhead
# - Scrollback measures lines/sec, not FPS (terminal-dependent)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results"
NUM_RUNS=3  # Run each test 3x and report median

# Pre-generated data file for throughput test (avoids CPU overhead during timing)
THROUGHPUT_DATA_FILE=$(mktemp)

# Check dependencies upfront with actionable guidance
check_dependencies() {
  local missing=()

  if ! command -v jq &>/dev/null; then
    missing+=("jq (install via: brew install jq / apt install jq)")
  fi
  if ! command -v bc &>/dev/null; then
    missing+=("bc (install via: brew install bc / apt install bc)")
  fi
  if ! command -v base64 &>/dev/null; then
    missing+=("base64 (usually pre-installed, check coreutils)")
  fi
  if ! command -v timeout &>/dev/null && ! command -v gtimeout &>/dev/null; then
    missing+=("timeout (install via: brew install coreutils / apt install coreutils)")
  fi
  if ! command -v stty &>/dev/null; then
    missing+=("stty (usually pre-installed)")
  fi

  # Check for timing command on macOS
  if [[ "$(uname)" == "Darwin" ]]; then
    if ! command -v gdate &>/dev/null && ! command -v perl &>/dev/null; then
      missing+=("gdate or perl (install gdate via: brew install coreutils)")
    fi
  fi

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "ERROR: Missing required dependencies:"
    for dep in "${missing[@]}"; do
      echo "  - $dep"
    done
    exit 1
  fi
}

# Detect terminal
detect_terminal() {
  if [[ -n "$TERM_PROGRAM" ]]; then
    echo "$TERM_PROGRAM"
  elif [[ -n "$TERMINAL_EMULATOR" ]]; then
    echo "$TERMINAL_EMULATOR"
  else
    echo "unknown"
  fi
}

# Get current terminal size
get_terminal_size() {
  local size=$(stty size 2>/dev/null || echo "24 80")
  echo "$size"
}

# Cross-platform system info with proper JSON escaping
get_system_info() {
  local os=$(uname -s | tr '[:upper:]' '[:lower:]')
  local arch=$(uname -m)
  local cpu="unknown"
  local memory_gb=0
  local term_size=$(get_terminal_size)
  local term_rows=$(echo "$term_size" | cut -d' ' -f1)
  local term_cols=$(echo "$term_size" | cut -d' ' -f2)

  if [[ "$os" == "darwin" ]]; then
    cpu=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "unknown")
    local memsize=$(sysctl -n hw.memsize 2>/dev/null || echo 0)
    memory_gb=$(( memsize / 1024 / 1024 / 1024 ))
  elif [[ -f /proc/cpuinfo ]]; then
    cpu=$(grep "model name" /proc/cpuinfo 2>/dev/null | head -1 | cut -d: -f2 | xargs || echo "unknown")
    local memkb=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}' || echo 0)
    if [[ -n "$memkb" && "$memkb" -gt 0 ]]; then
      memory_gb=$(( memkb / 1024 / 1024 ))
    fi
  else
    cpu=$(sysctl -n hw.model 2>/dev/null || echo "unknown")
    local memsize=$(sysctl -n hw.physmem 2>/dev/null || echo 0)
    if [[ -n "$memsize" && "$memsize" -gt 0 ]]; then
      memory_gb=$(( memsize / 1024 / 1024 / 1024 ))
    fi
  fi

  jq -n \
    --arg os "$os" \
    --arg arch "$arch" \
    --arg cpu "$cpu" \
    --argjson mem "$memory_gb" \
    --argjson rows "$term_rows" \
    --argjson cols "$term_cols" \
    '{os: $os, arch: $arch, cpu: $cpu, memory_gb: $mem, terminal_rows: $rows, terminal_cols: $cols}'
}

# High-precision timing (milliseconds)
now_ms() {
  if command -v gdate &>/dev/null; then
    gdate +%s%3N
  elif [[ "$(uname)" == "Darwin" ]]; then
    perl -MTime::HiRes=time -e 'printf "%.0f\n", time * 1000'
  else
    date +%s%3N
  fi
}

# Cross-platform timeout command
get_timeout_cmd() {
  if command -v gtimeout &>/dev/null; then
    echo "gtimeout"
  else
    echo "timeout"
  fi
}

# ISSUE-1: Synchronization point using DSR (Device Status Report)
# Send CSI 5 n and wait for response CSI 0 n to ensure terminal has processed all output
# This provides best-effort render sync for shell-based benchmarks
sync_terminal() {
  # Save current tty settings
  local old_settings=$(stty -g 2>/dev/null || true)

  # Set raw mode to read escape sequence response
  stty -echo -icanon min 0 time 1 2>/dev/null || true

  # Send Device Status Report request (CSI 5 n)
  printf '\e[5n'

  # Read response (should be CSI 0 n = \e[0n)
  local response=""
  while IFS= read -r -n1 -t 0.5 char 2>/dev/null; do
    response+="$char"
    # Stop when we get 'n' which ends the DSR response
    [[ "$char" == "n" ]] && break
  done

  # Restore tty settings
  stty "$old_settings" 2>/dev/null || true
}

# Temporary files for capturing results
RESULT_FILE=$(mktemp)
ALL_RESULTS_FILE=$(mktemp)
trap "rm -f $RESULT_FILE $ALL_RESULTS_FILE $THROUGHPUT_DATA_FILE" EXIT

# ISSUE-5: Pre-generate throughput data to isolate rendering from data generation
prepare_throughput_data() {
  local bytes=10485760  # 10 MiB
  echo "  Pre-generating $((bytes / 1048576)) MiB test data..."
  cat /dev/urandom | base64 | head -c $bytes > "$THROUGHPUT_DATA_FILE"
}

# Throughput test: 10 MiB of pre-generated data
test_throughput() {
  local bytes=$(stat -f%z "$THROUGHPUT_DATA_FILE" 2>/dev/null || stat -c%s "$THROUGHPUT_DATA_FILE" 2>/dev/null)
  local start=$(now_ms)

  # Display pre-generated data (no CPU overhead from generation)
  cat "$THROUGHPUT_DATA_FILE"

  # Sync to ensure terminal processed the data
  sync_terminal

  local end=$(now_ms)
  local duration=$((end - start))
  local mib_per_sec
  if [[ $duration -gt 0 ]]; then
    mib_per_sec=$(echo "scale=2; $bytes / 1048576 / ($duration / 1000)" | bc)
  else
    mib_per_sec="0"
  fi

  echo "{\"mib_per_sec\":$mib_per_sec,\"duration_ms\":$duration,\"bytes\":$bytes}" > "$RESULT_FILE"
}

# ISSUE-2: Scrollback test - renamed metric to lines_per_sec (not FPS)
# Note: Line count is unwrapped source lines, actual rendered lines depend on terminal width
test_scrollback() {
  local line=$(printf 'x%.0s' {1..200})
  local timeout_cmd=$(get_timeout_cmd)
  local start=$(now_ms)

  # Use timeout + yes as per SPEC
  local count=$($timeout_cmd 5 yes "$line" 2>/dev/null | tee /dev/tty | wc -l)

  # Sync to ensure terminal finished rendering
  sync_terminal

  local end=$(now_ms)
  local duration=$((end - start))
  # ISSUE-10: Use floating point division to avoid truncation
  local lines_per_sec=0
  if [[ $duration -gt 0 ]]; then
    lines_per_sec=$(echo "scale=2; $count * 1000 / $duration" | bc)
  fi

  echo "{\"lines_rendered\":$count,\"duration_ms\":$duration,\"lines_per_sec\":$lines_per_sec}" > "$RESULT_FILE"
}

# Color rendering test with sync
test_colors() {
  local start=$(now_ms)

  for i in {1..1000}; do
    for c in {0..255}; do
      printf "\e[38;5;${c}m█"
    done
    echo -e "\e[0m"
  done

  # ISSUE-1: Sync to ensure terminal finished rendering colors
  sync_terminal

  local end=$(now_ms)
  echo "{\"duration_ms\":$((end - start)),\"lines\":1000,\"colors_per_line\":256}" > "$RESULT_FILE"
}

# Unicode rendering test with sync
test_unicode() {
  local start=$(now_ms)

  for i in {1..500}; do
    echo "日本語テスト 🎉🚀💻 中文测试 한국어 テスト emoji: 👨‍👩‍👧‍👦"
  done

  # ISSUE-1: Sync to ensure terminal finished rendering unicode
  sync_terminal

  local end=$(now_ms)
  echo "{\"duration_ms\":$((end - start)),\"lines\":500}" > "$RESULT_FILE"
}

# ISSUE-3: Cursor test uses actual terminal size, not hardcoded 24x80
test_cursor() {
  local term_size=$(get_terminal_size)
  local rows=$(echo "$term_size" | cut -d' ' -f1)
  local cols=$(echo "$term_size" | cut -d' ' -f2)
  local ops=1000

  local start=$(now_ms)

  # Clear screen and hide cursor
  printf "\e[2J\e[?25l"

  for i in $(seq 1 $ops); do
    local row=$((RANDOM % rows + 1))
    local col=$((RANDOM % cols + 1))
    printf "\e[${row};${col}H*"
  done

  # Show cursor and reset
  printf "\e[?25h\e[H\e[2J"

  # ISSUE-1: Sync to ensure terminal finished rendering
  sync_terminal

  local end=$(now_ms)
  echo "{\"operations\":$ops,\"duration_ms\":$((end - start)),\"grid_rows\":$rows,\"grid_cols\":$cols}" > "$RESULT_FILE"
}

# Store all run results and compute variance on primary metric
run_test_with_stats() {
  local test_func=$1
  local test_name=$2

  # Clear results array file
  echo "[]" > "$ALL_RESULTS_FILE"

  echo "  Running $NUM_RUNS iterations..."
  for run in $(seq 1 $NUM_RUNS); do
    echo "    Run $run/$NUM_RUNS"
    $test_func
    local result=$(cat "$RESULT_FILE")

    # Append result to array
    local current=$(cat "$ALL_RESULTS_FILE")
    echo "$current" | jq --argjson r "$result" '. + [$r]' > "$ALL_RESULTS_FILE"
  done

  # Calculate statistics from all runs
  local all_runs=$(cat "$ALL_RESULTS_FILE")
  local mid_idx=$((NUM_RUNS / 2))

  # ISSUE-14: Sort by primary metric, not duration
  # For scrollback, sort by lines_per_sec; for throughput, sort by mib_per_sec; otherwise by duration
  local has_lines_per_sec=$(echo "$all_runs" | jq '.[0].lines_per_sec // null')
  local has_mib_per_sec=$(echo "$all_runs" | jq '.[0].mib_per_sec // null')
  local sorted
  local variance_pct=0

  if [[ "$has_lines_per_sec" != "null" ]]; then
    # Scrollback: sort and compute variance on lines_per_sec
    sorted=$(echo "$all_runs" | jq 'sort_by(.lines_per_sec)')
    local metrics=$(echo "$all_runs" | jq '[.[].lines_per_sec]')
    local min_metric=$(echo "$metrics" | jq 'min')
    local max_metric=$(echo "$metrics" | jq 'max')
    local median_metric=$(echo "$sorted" | jq ".[$mid_idx].lines_per_sec")
    if [[ "$median_metric" != "0" && "$median_metric" != "null" ]]; then
      variance_pct=$(echo "scale=1; ($max_metric - $min_metric) / $median_metric * 100" | bc)
    fi
  elif [[ "$has_mib_per_sec" != "null" ]]; then
    # Throughput: sort and compute variance on mib_per_sec
    sorted=$(echo "$all_runs" | jq 'sort_by(.mib_per_sec)')
    local metrics=$(echo "$all_runs" | jq '[.[].mib_per_sec]')
    local min_metric=$(echo "$metrics" | jq 'min')
    local max_metric=$(echo "$metrics" | jq 'max')
    local median_metric=$(echo "$sorted" | jq ".[$mid_idx].mib_per_sec")
    if [[ "$median_metric" != "0" && "$median_metric" != "null" ]]; then
      variance_pct=$(echo "scale=1; ($max_metric - $min_metric) / $median_metric * 100" | bc)
    fi
  else
    # Other tests: sort and compute variance on duration_ms
    sorted=$(echo "$all_runs" | jq 'sort_by(.duration_ms)')
    local durations=$(echo "$all_runs" | jq '[.[].duration_ms]')
    local min_dur=$(echo "$durations" | jq 'min')
    local max_dur=$(echo "$durations" | jq 'max')
    local median_dur=$(echo "$sorted" | jq ".[$mid_idx].duration_ms")
    if [[ "$median_dur" != "0" && "$median_dur" != "null" ]]; then
      variance_pct=$(echo "scale=1; ($max_dur - $min_dur) / $median_dur * 100" | bc)
    fi
  fi

  # Extract duration stats for metadata (always useful)
  local durations=$(echo "$all_runs" | jq '[.[].duration_ms]')
  local min_dur=$(echo "$durations" | jq 'min')
  local max_dur=$(echo "$durations" | jq 'max')
  local avg_dur=$(echo "$durations" | jq 'add / length | floor')
  local median_dur=$(echo "$sorted" | jq ".[$mid_idx].duration_ms")

  # Include all runs and statistics in output
  echo "$sorted" | jq \
    --argjson runs "$NUM_RUNS" \
    --argjson all_runs "$all_runs" \
    --argjson min "$min_dur" \
    --argjson max "$max_dur" \
    --argjson avg "$avg_dur" \
    --argjson median "$median_dur" \
    --arg variance "$variance_pct" \
    ".[$mid_idx] + {
      runs: \$runs,
      median_duration_ms: \$median,
      min_duration_ms: \$min,
      max_duration_ms: \$max,
      avg_duration_ms: \$avg,
      variance_pct: (\$variance | tonumber),
      all_runs: \$all_runs
    }" > "$RESULT_FILE"
}

# Run all tests or specific test
run_benchmarks() {
  local test_name="${1:-all}"
  local terminal=$(detect_terminal)
  local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  local system_info=$(get_system_info)

  echo "Terminal Benchmark Suite"
  echo "========================"
  echo "Terminal: $terminal"
  echo "Terminal size: $(get_terminal_size | tr ' ' 'x')"
  echo "Started: $timestamp"
  echo "Runs per test: $NUM_RUNS (reporting median with variance)"
  echo ""

  # Warm up
  echo "Warming up..."
  for i in {1..100}; do echo -n "."; done
  echo ""
  echo ""

  # Pre-generate throughput data
  if [[ "$test_name" == "all" || "$test_name" == "throughput" ]]; then
    prepare_throughput_data
  fi

  local results="{}"

  if [[ "$test_name" == "all" || "$test_name" == "throughput" ]]; then
    echo "Running throughput test (10 MiB)..."
    run_test_with_stats test_throughput "throughput"
    local throughput=$(cat "$RESULT_FILE")
    results=$(echo "$results" | jq --argjson t "$throughput" '. + {throughput: $t}')
    local var=$(echo "$throughput" | jq -r '.variance_pct')
    echo "  Result: $(echo "$throughput" | jq -c '{mib_per_sec, duration_ms, variance_pct}')"
    echo ""
  fi

  if [[ "$test_name" == "all" || "$test_name" == "scrollback" ]]; then
    echo "Running scrollback test (5 seconds)..."
    run_test_with_stats test_scrollback "scrollback"
    local scrollback=$(cat "$RESULT_FILE")
    results=$(echo "$results" | jq --argjson s "$scrollback" '. + {scrollback: $s}')
    echo "  Result: $(echo "$scrollback" | jq -c '{lines_rendered, lines_per_sec, variance_pct}')"
    echo ""
  fi

  if [[ "$test_name" == "all" || "$test_name" == "colors" ]]; then
    echo "Running colors test (1000 lines)..."
    run_test_with_stats test_colors "colors"
    local colors=$(cat "$RESULT_FILE")
    results=$(echo "$results" | jq --argjson c "$colors" '. + {colors: $c}')
    echo "  Result: $(echo "$colors" | jq -c '{duration_ms, variance_pct}')"
    echo ""
  fi

  if [[ "$test_name" == "all" || "$test_name" == "unicode" ]]; then
    echo "Running unicode test..."
    run_test_with_stats test_unicode "unicode"
    local unicode=$(cat "$RESULT_FILE")
    results=$(echo "$results" | jq --argjson u "$unicode" '. + {unicode: $u}')
    echo "  Result: $(echo "$unicode" | jq -c '{duration_ms, variance_pct}')"
    echo ""
  fi

  if [[ "$test_name" == "all" || "$test_name" == "cursor" ]]; then
    echo "Running cursor test..."
    run_test_with_stats test_cursor "cursor"
    local cursor=$(cat "$RESULT_FILE")
    results=$(echo "$results" | jq --argjson c "$cursor" '. + {cursor: $c}')
    echo "  Result: $(echo "$cursor" | jq -c '{duration_ms, grid_rows, grid_cols, variance_pct}')"
    echo ""
  fi

  # Build final JSON
  local output_file="$RESULTS_DIR/${terminal}-$(date +%Y%m%d-%H%M%S).json"

  jq -n \
    --arg terminal "$terminal" \
    --arg timestamp "$timestamp" \
    --argjson system "$system_info" \
    --argjson results "$results" \
    '{terminal: $terminal, timestamp: $timestamp, system: $system, results: $results}' \
    > "$output_file"

  echo "========================"
  echo "Results saved to: $output_file"
  echo ""
  cat "$output_file"
}

# Main
check_dependencies
mkdir -p "$RESULTS_DIR"
run_benchmarks "$1"
