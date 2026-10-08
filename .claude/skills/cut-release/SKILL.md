---
name: cut-release
description: Cut a release of the three npm packages and the Flutter package - propose the version from the Unreleased changelog, bump versions in lockstep, open the release PR, and after it merges create the GitHub release that triggers publishing, only on an explicit yes. Use when asked to release, cut a version, tag or publish.
model: sonnet
effort: low
---

# Cut a release

The three npm packages (`@appduct/shared`, `appduct`, `@appduct/react-native`) and the Flutter
package (`appduct` on pub.dev) share one version. Podspecs and Gradle read it from `package.json`,
and the Flutter package carries it in `pubspec.yaml`, `darwin/appduct.podspec` and
`android/build.gradle.kts`, so the version lives in exactly six files. Publishing is
`.github/workflows/deploy.yaml`, triggered by a published GitHub release whose tag is
`v<version>`; it refuses to run if the six files disagree
(`node scripts/release-version.mjs`).

Two phases. Never run phase 2 inside a `work-issue` loop or without the explicit yes.

Read the `cut-release` section of `.agents/memory/LESSONS.md` before starting, plus General.

## Phase 1: release PR

1. Preconditions, all must hold:

   ```bash
   git fetch origin && git switch -c tmp origin/main
   gh run list --branch main --limit 3 --json conclusion,name   # latest lint and test green
   git status --porcelain                                         # empty
   sed -n '/^## Unreleased/,/^## /p' CHANGELOG.md                 # not empty
   ```

2. Propose the bump from the `Unreleased` entries. While the major is 0: any entry marked
   breaking or any `New:` entry means minor, otherwise patch. Print the proposed version and
   the entries, and wait for confirmation of the version before touching files.

3. Apply:

   ```bash
   v=<version>
   for p in shared appduct react-native; do
     node -e "const f='packages/$p/package.json';const fs=require('fs');const j=JSON.parse(fs.readFileSync(f));j.version='$v';fs.writeFileSync(f,JSON.stringify(j,null,2)+'\n')"
   done
   ```

   Then the Flutter package, whose version also goes in `packages/flutter/CHANGELOG.md` as a new
   `## $v` heading above the previous one with a line of notes (pub.dev warns, and the publish
   dry run fails, when that file does not name the version):

   ```bash
   sed -i.bak -E "s/^version: .*/version: $v/" packages/flutter/pubspec.yaml
   sed -i.bak -E "s/(s\.version +=) '[^']*'/\1 '$v'/" packages/flutter/darwin/appduct.podspec
   sed -i.bak -E "s/^version = \"[^\"]*\"/version = \"$v\"/" packages/flutter/android/build.gradle.kts
   rm packages/flutter/pubspec.yaml.bak packages/flutter/darwin/appduct.podspec.bak packages/flutter/android/build.gradle.kts.bak
   node scripts/release-version.mjs   # prints $v when all six files agree
   (cd packages/flutter && dart pub publish --dry-run)
   ```

   In `CHANGELOG.md`, rename `## Unreleased` to `## <version> (<YYYY-MM-DD>)` and insert a
   new empty `## Unreleased` above it. Run `pnpm install --frozen-lockfile` to confirm the
   lockfile is unchanged, then `pnpm build && pnpm test`.

4. Open the PR:

   ```bash
   git switch -c "release/v$v" && git add -A && git commit -m "release: v$v"
   git push -u origin "release/v$v"
   gh pr create --title "release: v$v" --body "$(sed -n "/^## $v/,/^## /p" CHANGELOG.md | sed '$d')"
   ```

Stop. Report the PR number, the version and the changelog section.

## Phase 2: publish

Only after the release PR is merged and only after the person says, in chat, that this
version should be published. Quote the version back before running:

```bash
v=<version>
git fetch origin && git switch --detach origin/main
grep -q "\"version\": \"$v\"" packages/appduct/package.json   # the bump is on main
gh release create "v$v" --target main --title "v$v" \
  --notes "$(sed -n "/^## $v/,/^## /p" CHANGELOG.md | sed '$d')"
gh run list --workflow deploy.yaml --limit 1                   # publishing started
```

The `publish-pub` job needs the package claimed on pub.dev with automated publishing enabled
for this repository (tag pattern `v{{version}}`, environment `pub.dev`). If the first release
has not had that done by a maintainer, say so before creating the release: the npm packages
publish either way, and the pub job fails.

Report the release URL and the deploy run. Do not retry a failed publish; report it.
