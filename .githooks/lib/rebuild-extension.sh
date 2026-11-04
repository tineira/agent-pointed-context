# Sourced by the hooks in .githooks (post-merge, post-checkout, post-rewrite). Plain POSIX sh, so Git for Windows
# runs it too. rebuild_extension <old> <new>: when the change from <old> to <new> touches what the browser
# extension is built from (scripts/extension-changed.mjs), rebuild apps/extension/dist, the folder a person loads
# unpacked, so a pull never leaves it silently old. It never fails and never waits for input: git is never blocked.
# Only in the main worktree (a linked worktree, an agent's say, is not the folder anyone loads); set
# APC_HOOKS_IN_WORKTREES=1 to run it in a linked worktree too.
# Turn the hooks off with: git config --unset core.hooksPath

rebuild_extension() {
  command -v node > /dev/null 2>&1 || return 0
  top=$(git rev-parse --show-toplevel 2> /dev/null) || return 0
  if [ "${APC_HOOKS_IN_WORKTREES:-}" != "1" ]; then
    git_dir=$(git rev-parse --path-format=absolute --git-dir 2> /dev/null) || return 0
    common_dir=$(git rev-parse --path-format=absolute --git-common-dir 2> /dev/null) || return 0
    [ "$git_dir" = "$common_dir" ] || return 0
  fi
  plan=$(node "$top/scripts/extension-changed.mjs" "$1" "$2" < /dev/null 2> /dev/null) || return 0
  case "$plan" in
    rebuild|install-rebuild) ;;
    *) return 0 ;;
  esac
  if [ "$plan" = "install-rebuild" ]; then
    # CI=true and no stdin: pnpm never stops to ask (it would wait unseen behind git); it fails into the warning.
    if ! (cd "$top" && CI=true pnpm install --frozen-lockfile < /dev/null > /dev/null 2>&1); then
      echo "warning: APC extension not rebuilt: pnpm install --frozen-lockfile failed. Run it, then: node apps/extension/build.mjs" >&2
      return 0
    fi
  fi
  # build.mjs swaps the new build in only when it all succeeded: status 1 leaves the previous dist loadable. Status 2:
  # dist was held open and could only be partly overwritten.
  (cd "$top" && node apps/extension/build.mjs < /dev/null > /dev/null 2>&1)
  status=$?
  if [ "$status" = "0" ]; then
    echo "APC extension rebuilt into apps/extension/dist: reload it on chrome://extensions"
  elif [ "$status" = "2" ]; then
    echo "warning: apps/extension/dist was only partly updated: close what holds it and run node apps/extension/build.mjs again" >&2
  else
    echo "warning: APC extension rebuild failed (apps/extension/dist is unchanged). Run it by hand: node apps/extension/build.mjs" >&2
  fi
  return 0
}
