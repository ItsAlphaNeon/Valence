#!/usr/bin/env bash
# CI check for a packaged Valence.app: its ad-hoc signature verifies, and every executable and native
# module in it runs on the given CPU (universal binaries count).
# usage: scripts/ci-mac-check.sh <path/to/Valence.app> <arm64|x86_64>
set -euo pipefail
app=$1
arch=$2

codesign --verify --deep --strict --verbose=2 "$app"
codesign -dv "$app" 2>&1 | grep -E 'Signature|Identifier|Format'

# Only the file type is checked: the app's own path can contain "arm64". better-sqlite3 ships a binary
# for each platform and loads the one for the CPU it runs on, so the other Mac's copy is skipped.
other=$([ "$arch" = arm64 ] && echo x64 || echo arm64)
list=$(mktemp)
find "$app" -type f -print0 | xargs -0 file -F $'\t' | awk -F'\t' '$2 ~ /Mach-O/' > "$list"
wrong=$(awk -F'\t' -v arch="$arch" -v skip="/prebuilds/darwin-$other.node" \
  'index($2, arch) == 0 && substr($1, length($1) - length(skip) + 1) != skip' "$list")
if [ -n "$wrong" ]; then
  echo "::error::Binaries in $app that aren't $arch:"
  echo "$wrong"
  exit 1
fi
echo "$(wc -l < "$list" | tr -d ' ') Mach-O files in $app, all $arch (apart from better-sqlite3's unused darwin-$other.node)"
