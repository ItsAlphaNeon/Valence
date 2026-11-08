#!/bin/bash
# Puts the TV page on GitHub Pages, so Google Cast has an https address to open. It goes in a small
# public repo of its own, and only the page's own files go up. Run it again to publish a later change.
set -euo pipefail

REPO=ItsAlphaNeon/valence-cast
URL=https://itsalphaneon.github.io/valence-cast/
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

NEW=1
if gh repo view "$REPO" >/dev/null 2>&1; then
  NEW=0
  git clone -q "https://github.com/$REPO.git" "$WORK"
else
  git -C "$WORK" init -q -b main
fi

cp "$HERE/index.html" "$HERE/style.css" "$HERE/note.svg" "$HERE/receiver.js" "$HERE/README.md" "$WORK/"
touch "$WORK/.nojekyll" # serve the files as they are
cd "$WORK"

# GitHub's no-reply address: a public history shouldn't carry a personal one.
git config user.name ItsAlphaNeon
git config user.email 102443376+ItsAlphaNeon@users.noreply.github.com
git add -A
if git diff --cached --quiet; then
  echo "The page hasn't changed. It's at $URL"
  exit 0
fi
git commit -q -F - <<'EOF'
Valence TV screen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF

if [ "$NEW" = 1 ]; then
  gh repo create "$REPO" --public --description "The TV screen for Valence's Google Cast support" --source . --remote origin --push
  gh api -X POST "repos/$REPO/pages" -f 'source[branch]=main' -f 'source[path]=/' >/dev/null
else
  git push -q origin main
fi

echo
echo "Published. GitHub takes a minute or two to serve it. Give the Cast console this address:"
echo "$URL"
