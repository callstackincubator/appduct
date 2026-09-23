---
name: implement-issue
description: Implement a GitHub issue tests-first - take the acceptance criteria from the issue, write red tests against the public API, commit them, open a draft PR, then implement in checkpoint commits until green, with user-facing docs as one of the criteria. Use when asked to implement, build or fix something tracked as an issue, or when a work-issue orchestrator delegates implementation.
---

# Implement an issue

Load the `architecture` skill first. The issue is the spec; if it is not `status:ready`, say so
and stop unless the person asking says to proceed anyway.

Read the `implement-issue` section of `.agents/memory/LESSONS.md` before starting, plus General.

## 1. Branch and workspace

The branch name is derived from the issue, so any session can find it:

```bash
n=<issue number>
slug=$(gh issue view "$n" --json title -q .title | tr '[:upper:]' '[:lower:]' \
  | sed -E 's/[^a-z0-9]+/-/g; s/^-//; s/-$//' | cut -c1-40 | sed -E 's/-$//')
branch="issue-$n-$slug"
dir=$(.agents/scripts/worktree.sh "$branch")     # existing branch is resumed, new one starts from origin/main
cd "$dir" && pnpm build
```

If the branch already had a draft PR, read it (`gh pr view "$branch"`), run the tests, and
continue from the failing count you find.

## 2. Acceptance criteria

Read the issue and every comment (`gh issue view <N> --comments`). The criteria are already
there: the "How we know it is done" section, or the slice's criteria in an approved design,
or a triage comment's "Fix" line for a bug. Copy them. Only when the issue has none, derive
them, each as an observable outcome a test can assert through a public API, an emitted event,
a port fake's state or CLI output.

If a criterion cannot be phrased that way, post the list as an issue comment with the open
question under it, apply `status:blocked`, and stop. Do not guess.

Add one criterion of your own when the change is user-visible: the docs. Name the surfaces
from the `writing-user-docs` skill's table (README, `docs/`, website, the shipped skill, CLI
help, error text) and write them with that skill. The changelog entry is always required and
is written with the `writing-changelog` skill.

## 3. Red tests

One test per criterion, at the lowest tier that can observe it:

| Tier | Where | Observes |
| --- | --- | --- |
| unit (TS) | `*.test.ts` | one module through its `index.ts`, fakes at the ports |
| integration (TS) | `*.integration.test.ts` | several real modules in-process, fakes only at the ports |
| e2e (TS) | `*.e2e.test.ts` | the real CLI subprocess and the fake app client |
| unit (Swift) | `packages/native/ios/Tests`, `xcodebuild test -scheme AppductCore` | the public API of AppductCore with fakes behind its protocols |
| unit (Kotlin) | `packages/native/android`, `./gradlew :core:testDebugUnitTest` | the public API of the Android core with fakes behind its interfaces |
| conformance | `packages/native/fixtures` | a wire or descriptor shape all three SDKs must agree on; change the fixture first |
| device | `e2e-device` skill | the real app on a simulator; never in CI |

Tests assert on behaviour only. No `vi.mock`, no spying on internals, no importing a module's
non-index files. Test names read as the spec. Run them; they must fail for the right reason
(the missing behaviour, not a typo). A criterion that only a type can enforce is red when
typecheck fails and green when it passes; say so in the criteria table. Then:

```bash
git add -A && git commit -m "test: <issue title, imperative> (#$n)"
git push -u origin "$branch"
gh pr create --draft --title "<type>: <issue title> (#$n)" --body-file <scratch>/pr.md   # filled PR template, written outside the repo
```

The PR body follows `.github/PULL_REQUEST_TEMPLATE.md`: the criteria table with the test
that covers each, everything else marked pending.

## 4. Green in checkpoints

Implement the smallest change that turns the next test green. Each commit lowers the failing
count and says so:

```
feat(daemon): reject links older than five minutes (#12)

3 failing -> 1 failing
```

Run `pnpm lint && pnpm typecheck` and the test files you touched before each commit. Do not
refactor while red. When everything passes, one optional `refactor:` commit, then the full
`pnpm test` once.

A test that fails and then passes on one rerun of the same file, with no change in between,
is a flake. Never skip, quarantine or loosen it. Note it in the PR under "Out of scope" and
file it with `file-issue` as a `type:bug` if no issue exists.

Do not widen scope. Something you notice that is not a criterion becomes an issue via
`file-issue`, or a one-line note in the PR under "Out of scope".

## 5. Finish

- Add or amend the changelog entry under `## Unreleased` if the change is user-visible, with
  the `writing-changelog` skill loaded. If `Unreleased` is missing because a release was just
  cut, add the section.
- Run the `architecture` skill's "Before you open the PR" list against the diff.
- Fill the PR template fully. The E2E evidence section is filled by the `e2e-device` skill
  (a separate run or subagent); leave it marked pending and say so in your report.
- Leave the PR as a draft. Marking it ready is the orchestrator's or the human's call after
  review and E2E.

## Report

When you are done, or blocked, end with exactly this, nothing more:

```
Branch: issue-N-slug  PR: #M (draft)
Criteria: k of n green
Commits: <count> (test commit first)
Changed: <modules touched, one line>
Docs: <surfaces updated, or "not user-visible">   Changelog: added | amended | not user-visible
Open: <blockers, flakes, deviations from the issue, or "none">
```
