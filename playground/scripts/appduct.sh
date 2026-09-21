#!/usr/bin/env sh
set -eu

# Runs this repository's own CLI build from the playground's app root, so the CLI finds
# .appduct/config.json (scheme and app ids) by its usual walk-up. The daemon is the shared one in
# ~/.appduct (or APPDUCT_STATE_DIR), exactly as for any other app.

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
playground_dir=$(dirname "$script_dir")
repository_dir=$(dirname "$playground_dir")

if [ "${1-}" = "--" ]; then
  shift
fi

if [ ! -f "$repository_dir/packages/appduct/dist/bin.js" ]; then
  pnpm --dir "$repository_dir" --filter appduct build
fi

cd "$playground_dir"

exec node "$repository_dir/packages/appduct/bin.js" "$@"
