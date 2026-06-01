#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: aapt_dump.sh <apk> [badging|permissions|resources|xmltree:<file>]" >&2
  exit 2
fi

apk="$1"
mode="${2:-badging}"

if ! command -v aapt >/dev/null 2>&1; then
  echo "aapt is not installed or not in PATH. Install Android build-tools, or use apktool_decode/jadx_decompile if available." >&2
  exit 127
fi

if [ ! -f "$apk" ]; then
  echo "APK not found: $apk" >&2
  exit 2
fi

case "$mode" in
  badging|permissions|resources)
    aapt dump "$mode" "$apk"
    ;;
  xmltree:*)
    file="${mode#xmltree:}"
    aapt dump xmltree "$apk" "$file"
    ;;
  *)
    echo "Unsupported aapt dump mode: $mode" >&2
    echo "Use badging, permissions, resources, or xmltree:<file>." >&2
    exit 2
    ;;
esac
