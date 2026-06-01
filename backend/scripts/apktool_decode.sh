#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: apktool_decode.sh <apk> [output_dir] [full]" >&2
  exit 2
fi

apk="$1"
out="${2:-}"
mode="${3:-no-res}"

if ! command -v apktool >/dev/null 2>&1; then
  echo "apktool is not installed or not in PATH. Install apktool, or use unzip_list/unzip plus jadx_decompile if available." >&2
  exit 127
fi

if [ ! -f "$apk" ]; then
  echo "APK not found: $apk" >&2
  exit 2
fi

if [ -z "$out" ]; then
  base="$(basename "$apk")"
  out="$(dirname "$apk")/${base%.*}_apktool"
fi

args=(d -f -o "$out")
if [ "$mode" != "full" ] && [ "$mode" != "with-res" ]; then
  args+=(-r)
fi
apktool "${args[@]}" "$apk" >/tmp/apktool_decode.log 2>&1 || {
  status=$?
  sed -n '1,120p' /tmp/apktool_decode.log >&2
  exit "$status"
}

echo "apktool_output=$out"
echo "mode=$mode"
find "$out" -maxdepth 6 -type f | rg -n --color never '(AndroidManifest|/f/f/eazyflag/|MainActivity|libeazyflag|classes)' | sed -n '1,160p'
