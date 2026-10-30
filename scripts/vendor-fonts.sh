#!/usr/bin/env bash
# Re-vendor the dashboard's web fonts (latin subsets, woff2) into
# packages/dispatch/src/api/web/assets/fonts/ so the local-first dashboard makes NO
# third-party request on load (the CSP is font-src 'self'). The faces come from the
# Fontsource npm packages (all SIL OFL 1.1, see THIRD_PARTY_NOTICES.md); each licence
# is copied next to its font. The @font-face rules live in
# packages/dispatch/src/api/web/css/tokens.css — keep the file names in step.
#
#   bash scripts/vendor-fonts.sh            # uses the versions pinned below
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/../packages/dispatch/src/api/web/assets/fonts"
mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# package@version  file-in-package  licence-name
FONTS=(
  "@fontsource-variable/big-shoulders-display@5.3.0 big-shoulders-display-latin-wght-normal.woff2 big-shoulders-display"
  "@fontsource-variable/big-shoulders-stencil-display@5.3.0 big-shoulders-stencil-display-latin-wght-normal.woff2 big-shoulders-stencil-display"
  "@fontsource-variable/sofia-sans@5.3.0 sofia-sans-latin-wght-normal.woff2 sofia-sans"
  "@fontsource-variable/sofia-sans-condensed@5.3.0 sofia-sans-condensed-latin-wght-normal.woff2 sofia-sans-condensed"
  "@fontsource/fragment-mono@5.3.0 fragment-mono-latin-400-normal.woff2 fragment-mono"
)
for row in "${FONTS[@]}"; do
  read -r pkg file name <<<"$row"
  (cd "$TMP" && npm pack --silent "$pkg" >/dev/null)
  tgz="$(ls -t "$TMP"/*.tgz | head -1)"
  mkdir -p "$TMP/x" && tar -xzf "$tgz" -C "$TMP/x"
  cp "$TMP/x/package/files/$file" "$OUT/$file"
  cp "$TMP/x/package/LICENSE" "$OUT/LICENSE-$name.txt"
  rm -rf "$TMP/x" "$tgz"
  echo "vendored $file"
done
du -cb "$OUT"/*.woff2 | tail -1
