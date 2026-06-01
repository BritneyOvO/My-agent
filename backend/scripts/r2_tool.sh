#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: r2_tool.sh <file> [r2-command ...]" >&2
  echo "example: r2_tool.sh ./a.out iI afl 'pdf @ main'" >&2
  exit 2
fi

file="$1"
shift || true

if [ ! -e "$file" ]; then
  echo "file not found: $file" >&2
  exit 2
fi

args=("-q" "-e" "scr.color=false" "-e" "scr.utf8=false")

# 默认轻量分析 + 常用信息。需要更深入时在工具 args 中传 r2 命令，如：aaa, afl, pdf @ main, izz, iI, axt @ sym.xxx
if [ "$#" -eq 0 ]; then
  args+=("-A" "-c" "iI" "-c" "afl" "-c" "izz" "-c" "q")
else
  for cmd in "$@"; do
    args+=("-c" "$cmd")
  done
  args+=("-c" "q")
fi

exec r2 "${args[@]}" "$file"
