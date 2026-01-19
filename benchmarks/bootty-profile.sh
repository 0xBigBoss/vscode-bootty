#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Scenario configuration (override via env vars)
IDLE_SECONDS="${IDLE_SECONDS:-5}"
SMALL_LINES="${SMALL_LINES:-500}"
SMALL_LINE_WIDTH="${SMALL_LINE_WIDTH:-120}"
STRESS_SECONDS="${STRESS_SECONDS:-5}"
STRESS_LINE_WIDTH="${STRESS_LINE_WIDTH:-200}"

usage() {
  echo "Usage: $0 <idle|small|stress|benchmark>"
  echo ""
  echo "Environment overrides:"
  echo "  IDLE_SECONDS (default: $IDLE_SECONDS)"
  echo "  SMALL_LINES (default: $SMALL_LINES)"
  echo "  SMALL_LINE_WIDTH (default: $SMALL_LINE_WIDTH)"
  echo "  STRESS_SECONDS (default: $STRESS_SECONDS)"
  echo "  STRESS_LINE_WIDTH (default: $STRESS_LINE_WIDTH)"
}

get_timeout_cmd() {
  if command -v gtimeout &>/dev/null; then
    echo "gtimeout"
    return
  fi
  if command -v timeout &>/dev/null; then
    echo "timeout"
    return
  fi
  echo ""
}

prompt_start() {
  echo ""
  echo ">> Toggle BooTTY profiling ON, focus the BooTTY tab, then press Enter to start."
  read -r _
}

prompt_stop() {
  echo ""
  echo ">> Scenario complete. Toggle BooTTY profiling OFF, then press Enter to finish."
  read -r _
}

run_idle() {
  prompt_start
  sleep "$IDLE_SECONDS"
  prompt_stop
}

run_small() {
  prompt_start
  local line
  line="$(printf '%*s' "$SMALL_LINE_WIDTH" '' | tr ' ' 'x')"
  local i=1
  while [[ $i -le $SMALL_LINES ]]; do
    printf '%s\n' "$line"
    i=$((i + 1))
  done
  prompt_stop
}

run_stress() {
  local timeout_cmd
  timeout_cmd="$(get_timeout_cmd)"
  if [[ -z "$timeout_cmd" ]]; then
    echo "ERROR: timeout command not found (install coreutils for gtimeout/timeout)."
    exit 1
  fi

  prompt_start
  local line
  line="$(printf '%*s' "$STRESS_LINE_WIDTH" '' | tr ' ' 'x')"
  "$timeout_cmd" "$STRESS_SECONDS" yes "$line"
  prompt_stop
}

run_benchmark() {
  prompt_start
  "$SCRIPT_DIR/run.sh" all
  prompt_stop
}

main() {
  if [[ $# -ne 1 ]]; then
    usage
    exit 1
  fi

  case "$1" in
    idle) run_idle ;;
    small) run_small ;;
    stress) run_stress ;;
    benchmark) run_benchmark ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
