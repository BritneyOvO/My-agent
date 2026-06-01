#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: readelf_symbols.sh <elf|so> [regex] [limit]" >&2
  exit 2
fi

file="$1"
pattern="${2:-JNI|Java_|RegisterNatives|JNI_OnLoad|flag|ctf|check|encrypt|decrypt|main|FUNC|OBJECT}"
limit="${3:-240}"

if ! [[ "$limit" =~ ^[0-9]+$ ]]; then
  limit=240
fi

if [ ! -f "$file" ]; then
  echo "ELF file not found: $file" >&2
  exit 2
fi

if ! command -v readelf >/dev/null 2>&1; then
  echo "readelf is not installed or not in PATH." >&2
  exit 127
fi

echo "[readelf_symbols] command: readelf -Ws '$file' | rg -i '$pattern' | head -n $limit"
matches="$(readelf -Ws "$file" | rg -n --color never -i -- "$pattern" | head -n "$limit" || true)"
if [ -n "$matches" ]; then
  printf '%s\n' "$matches"
  echo "[readelf_symbols] Showing at most $limit matching symbol lines. Pass a narrower regex before raising the limit."
  exit 0
fi

echo "[readelf_symbols] No symbols matched regex: $pattern"
echo "[readelf_symbols] Showing the first 120 symbol lines as a fallback; use args=[regex, limit] to filter."
readelf -Ws "$file" | sed -n '1,120p'
