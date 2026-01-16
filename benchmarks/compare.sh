#!/bin/bash
# Compare benchmark results across terminals

set -e

# Check for jq dependency
if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required but not installed."
  echo "  Install via: brew install jq / apt install jq"
  exit 1
fi

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <result1.json> <result2.json> [result3.json ...]"
  echo ""
  echo "Example: $0 results/ghostty-*.json results/vscode-*.json"
  exit 1
fi

echo "Terminal Benchmark Comparison"
echo "=============================="
echo ""

# Header
printf "%-20s %12s %12s %12s %12s %12s %8s %12s\n" \
  "Terminal" "Throughput" "Scrollback" "Colors" "Unicode" "Cursor" "Var%" "Date"
printf "%-20s %12s %12s %12s %12s %12s %8s %12s\n" \
  "" "(MiB/s)" "(lines/sec)" "(ms)" "(ms)" "(ms)" "(max)" ""
echo "--------------------------------------------------------------------------------------------------------"

# Process each result file
for file in "$@"; do
  if [[ ! -f "$file" ]]; then
    echo "Warning: $file not found, skipping"
    continue
  fi

  terminal=$(jq -r '.terminal // "unknown"' "$file" | cut -c1-18)
  throughput=$(jq -r '.results.throughput.mib_per_sec // "-"' "$file")
  # Use lines_per_sec if available, fall back to estimated_fps for old results
  scrollback=$(jq -r '.results.scrollback.lines_per_sec // .results.scrollback.estimated_fps // "-"' "$file")
  colors=$(jq -r '.results.colors.duration_ms // "-"' "$file")
  unicode=$(jq -r '.results.unicode.duration_ms // "-"' "$file")
  cursor=$(jq -r '.results.cursor.duration_ms // "-"' "$file")

  # Get max variance across all tests
  max_var=$(jq -r '[
    .results.throughput.variance_pct // 0,
    .results.scrollback.variance_pct // 0,
    .results.colors.variance_pct // 0,
    .results.unicode.variance_pct // 0,
    .results.cursor.variance_pct // 0
  ] | max | . * 10 | floor / 10' "$file" 2>/dev/null || echo "-")

  # Extract date from timestamp (format: YYYY-MM-DD)
  bench_date=$(jq -r '.timestamp // "" | split("T")[0] // "-"' "$file" 2>/dev/null || echo "-")

  printf "%-20s %12s %12s %12s %12s %12s %8s %12s\n" \
    "$terminal" "$throughput" "$scrollback" "$colors" "$unicode" "$cursor" "$max_var" "$bench_date"
done

echo ""
echo "Notes:"
echo "  - Higher is better for Throughput and Scrollback (lines/sec)"
echo "  - Lower is better for timed tests (Colors, Unicode, Cursor)"
echo "  - Var% shows max variance across tests; >10% indicates noisy results"
