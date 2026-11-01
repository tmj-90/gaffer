# shellcheck shell=bash
# =====================================================================
# playwright-core (no browser download) + axe-core (the a11y audit) for the browser
# harnesses. setup.sh calls ui_pw_install for every world; run-suites.sh -j N calls
# it once before it starts N worlds at a time, so they never run two `npm install`s
# into the same cache dir.
#
#   ui_pw_install <dir>   install into <dir> unless node already resolves both or
#                         <dir> has them; exports PW_CORE_ROOT=<dir> when it is used
#                         (regress.mjs resolves both from there: ESM ignores NODE_PATH)
# =====================================================================
ui_pw_install() {
  node -e 'require.resolve("playwright-core"); require.resolve("axe-core")' >/dev/null 2>&1 && return 0
  local _pw="$1"; mkdir -p "$_pw"
  if [ ! -d "$_pw/node_modules/playwright-core" ] || [ ! -d "$_pw/node_modules/axe-core" ]; then
    # Pinned: CI installs the matching Chromium with `npx playwright@<same version> install`.
    ( cd "$_pw" && npm init -y >/dev/null 2>&1 && npm install --silent playwright-core@1.63.0 axe-core@4.13.0 >/dev/null 2>&1 ) \
      || { echo "could not install playwright-core / axe-core (npm)"; return 2; }
  fi
  export PW_CORE_ROOT="$_pw"
}
