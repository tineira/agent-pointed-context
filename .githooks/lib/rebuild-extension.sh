# Sourced by the hooks in .githooks (post-merge, post-checkout, post-rewrite). Plain POSIX sh, so Git for Windows
# runs it too. rebuild_extension <old> <new>: when the change from <old> to <new> touches what the browser
# extension is built from (scripts/extension-changed.mjs), rebuild apps/extension/dist, the folder a person loads
# unpacked, so a pull never leaves it silently old. It never fails: git is never blocked.
# Turn the hooks off with: git config --unset core.hooksPath

rebuild_extension() {
  command -v node > /dev/null 2>&1 || return 0
  top=$(git rev-parse --show-toplevel 2> /dev/null) || return 0
  plan=$(node "$top/scripts/extension-changed.mjs" "$1" "$2" 2> /dev/null) || return 0
  case "$plan" in
    rebuild|install-rebuild) ;;
    *) return 0 ;;
  esac
  if [ "$plan" = "install-rebuild" ]; then
    if ! (cd "$top" && pnpm install --frozen-lockfile > /dev/null 2>&1); then
      echo "warning: APC extension not rebuilt: pnpm install --frozen-lockfile failed. Run it, then: cd apps/extension && node build.mjs" >&2
      return 0
    fi
  fi
  if (cd "$top/apps/extension" && node build.mjs > /dev/null 2>&1); then
    echo "APC extension rebuilt into apps/extension/dist: reload it on chrome://extensions"
  else
    echo "warning: APC extension rebuild failed. Run it by hand: cd apps/extension && node build.mjs" >&2
  fi
  return 0
}
