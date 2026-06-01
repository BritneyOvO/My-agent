#!/usr/bin/env bash
set -u

if [ "$#" -lt 2 ]; then
  echo "Usage: strings_grep.sh <file> <regex> [limit]" >&2
  exit 2
fi

file="$1"
pattern="$2"
limit="${3:-200}"

if ! [[ "$limit" =~ ^[0-9]+$ ]]; then
  limit=200
fi

if [ ! -f "$file" ]; then
  echo "File not found: $file" >&2
  exit 2
fi

output="$(strings -a "$file" | rg -n --color never -i -- "$pattern" | head -n "$limit" || true)"
if [ -z "$output" ]; then
  echo "No string matches for pattern: $pattern"
  exit 0
fi

printf '%s\n' "$output"
if [ "$limit" -gt 0 ]; then
  echo "[strings_grep] Showing at most $limit matching lines. Use a narrower regex before raising the limit."
fi
