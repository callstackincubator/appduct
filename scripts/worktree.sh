#!/usr/bin/env sh
# Creates a git worktree for a branch and makes it buildable in seconds. Dependencies are
# hard-linked from the pnpm store that the main checkout already filled, so nothing is
# downloaded; measured at about seven seconds for this workspace.
#
#   scripts/worktree.sh <branch> [base]      base defaults to origin/main
#
# Prints the worktree path. An existing local or remote branch is checked out as is; a new one
# is created from base. Worktrees live under <main checkout>/.worktrees/<branch>, which is
# gitignored. Remove one with `git worktree remove .worktrees/<branch>`.
set -eu

branch=${1:?usage: scripts/worktree.sh <branch> [base]}
base=${2:-origin/main}

main_root=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
dir="$main_root/.worktrees/$branch"

if [ -e "$dir" ]; then
  echo "$dir already exists" >&2
  exit 1
fi

git -C "$main_root" fetch -q origin
if git -C "$main_root" show-ref --verify --quiet "refs/heads/$branch"; then
  git -C "$main_root" worktree add -q "$dir" "$branch"
elif git -C "$main_root" ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  git -C "$main_root" worktree add -q --track -b "$branch" "$dir" "origin/$branch"
else
  git -C "$main_root" worktree add -q -b "$branch" "$dir" "$base"
fi

# --offline: every package is already in the store from the main checkout's install. If this
# fails, the lockfile changed on the branch; run `pnpm install --frozen-lockfile` there once.
(cd "$dir" && pnpm install --frozen-lockfile --offline --ignore-scripts >/dev/null)

echo "$dir"
