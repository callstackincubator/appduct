#!/usr/bin/env sh
# Removes a worktree made by worktree.sh. The branch is kept: a subagent's work lives on it
# and may already be pushed; deleting branches is a human's call.
#
#   .agents/scripts/worktree-remove.sh <path>
#   echo '{"worktree_path":"<path>"}' | .agents/scripts/worktree-remove.sh
#
# The second form is Claude Code's WorktreeRemove hook (see .claude/settings.json).
set -eu

if [ $# -eq 0 ]; then
  path=$(python3 -c 'import json, sys; print(json.load(sys.stdin)["worktree_path"])')
else
  path=$1
fi

main_root=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
case "$path" in
  "$main_root"/.worktrees/*) ;;
  *) echo "refusing to remove $path: not under $main_root/.worktrees" >&2; exit 1 ;;
esac

# --force: the worktree holds cloned node_modules and build output, which git counts as
# untracked-but-ignored and would otherwise refuse to remove.
git -C "$main_root" worktree remove --force "$path"
