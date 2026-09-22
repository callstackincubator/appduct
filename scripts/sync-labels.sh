#!/usr/bin/env sh
# Makes the repository's labels match .github/labels.yml: creates missing ones, updates colour
# and description of existing ones, and deletes labels not in the file. Needs gh (authenticated)
# and node. Pass --dry-run to print what would change without touching GitHub.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
labels_file="$script_dir/../.github/labels.yml"
dry_run=0
[ "${1-}" = "--dry-run" ] && dry_run=1

# The file is a flat YAML list with three scalar keys per entry, so a line parser is enough;
# a YAML dependency for this would be one more thing to install.
wanted=$(node -e '
  const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n");
  const out = []; let cur = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, "");
    let m;
    if ((m = line.match(/^- name:\s*(.+)$/))) { cur = { name: m[1].trim().replace(/^"|"$/g, "") }; out.push(cur); }
    else if (cur && (m = line.match(/^\s+color:\s*(.+)$/))) cur.color = m[1].trim().replace(/^"|"$/g, "");
    else if (cur && (m = line.match(/^\s+description:\s*(.+)$/))) cur.description = m[1].trim().replace(/^"|"$/g, "");
  }
  for (const l of out) console.log([l.name, l.color, l.description ?? ""].join("\t"));
' "$labels_file")

existing=$(gh label list --limit 200 --json name -q '.[].name')

printf '%s\n' "$wanted" | while IFS="$(printf '\t')" read -r name color description; do
  if printf '%s\n' "$existing" | grep -qxF "$name"; then
    echo "update  $name"
    [ "$dry_run" = 1 ] || gh label edit "$name" --color "$color" --description "$description" >/dev/null
  else
    echo "create  $name"
    [ "$dry_run" = 1 ] || gh label create "$name" --color "$color" --description "$description" >/dev/null
  fi
done

printf '%s\n' "$existing" | while read -r name; do
  [ -z "$name" ] && continue
  if ! printf '%s\n' "$wanted" | cut -f1 | grep -qxF "$name"; then
    echo "delete  $name"
    [ "$dry_run" = 1 ] || gh label delete "$name" --yes >/dev/null
  fi
done
