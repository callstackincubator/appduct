#!/usr/bin/env sh
# Creates a git worktree for a branch and makes it buildable in seconds.
#
#   .agents/scripts/worktree.sh <branch> [base]      base defaults to origin/main
#
# Every node_modules tree of the main checkout is cloned into the worktree with APFS
# clonefile(2): one call per tree, no data copied, blocks shared copy-on-write. pnpm then
# relinks the workspace offline, which takes about a second because everything is already in
# place. On a filesystem without clonefile (Linux) the clone is skipped and pnpm links the
# tree from its store offline instead; nothing is downloaded either way.
#
# Prints the worktree path. An existing local or remote branch is checked out as is; a new one
# is created from base. Worktrees live under <main checkout>/.worktrees/<branch>, which is
# gitignored. Remove one with `git worktree remove .worktrees/<branch>`.
set -eu

branch=${1:?usage: .agents/scripts/worktree.sh <branch> [base]}
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

if [ "$(uname)" = Darwin ]; then
  python3 - "$main_root" "$dir" <<'EOF'
import ctypes, os, sys
src_root, dst_root = sys.argv[1], sys.argv[2]
libc = ctypes.CDLL("libSystem.dylib", use_errno=True)
for parent, names, _ in os.walk(src_root):
    rel = os.path.relpath(parent, src_root)
    # Do not descend into other worktrees, git internals, or into a node_modules once cloned.
    names[:] = [n for n in names if n not in (".worktrees", ".claude", ".git")]
    if "node_modules" in names:
        names.remove("node_modules")
        src = os.path.join(parent, "node_modules")
        dst = os.path.join(dst_root, rel, "node_modules") if rel != "." else os.path.join(dst_root, "node_modules")
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if libc.clonefile(src.encode(), dst.encode(), 0) != 0:
            err = ctypes.get_errno()
            sys.exit(f"clonefile {src}: {os.strerror(err)}")
EOF
fi

# --offline: every package is already in place (Darwin) or in the store (elsewhere). If this
# fails, the lockfile changed on the branch; run `pnpm install --frozen-lockfile` there once.
(cd "$dir" && pnpm install --frozen-lockfile --offline --ignore-scripts >/dev/null)

echo "$dir"
