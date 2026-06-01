#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: jadx_decompile.sh <apk|dex> [output_dir] [with-res]" >&2
  exit 2
fi

input="$1"
out="${2:-}"
mode="${3:-no-res}"

if ! command -v jadx >/dev/null 2>&1; then
  echo "jadx is not installed or not in PATH. Install jadx, then rerun this tool; fallback to unzip + targeted DEX/native analysis meanwhile." >&2
  exit 127
fi

if [ ! -f "$input" ]; then
  echo "Input file not found: $input" >&2
  exit 2
fi

if [ -z "$out" ]; then
  base="$(basename "$input")"
  out="$(dirname "$input")/${base%.*}_jadx"
fi

mkdir -p "$out"
args=(--show-bad-code --no-debug-info --log-level error)
if [ "$mode" != "with-res" ] && [ "$mode" != "full" ]; then
  args+=(--no-res)
fi

jadx "${args[@]}" -d "$out" "$input" >/tmp/jadx_decompile.log 2>&1 || {
  status=$?
  java_count="$(find "$out" -type f -name '*.java' 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$java_count" -eq 0 ]; then
    sed -n '1,120p' /tmp/jadx_decompile.log >&2
    exit "$status"
  fi
  echo "[jadx_decompile] jadx exited with status $status but produced $java_count Java files; continuing with partial output." >&2
}

echo "jadx_output=$out"
echo "mode=$mode"
echo "Interesting files:"
find "$out" -type f \( -name '*MainActivity*.java' -o -name '*.java' \) | rg -n --color never '(/f/f/eazyflag/|MainActivity|Activity|flag|check|native|JNI|encrypt|decrypt)' | sed -n '1,160p'
