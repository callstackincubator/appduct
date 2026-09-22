---
name: implement-issue
description: Implement a GitHub issue tests-first - derive acceptance criteria, write red tests against the public API, commit them, open a draft PR, then implement in checkpoint commits until green. Use when asked to implement, build or fix something tracked as an issue, or when a work-issue orchestrator delegates implementation.
---

# Implement an issue

Load the `architecture` skill first. The issue is the spec; if it is not `status:ready`, say so
and stop unless the person asking says to proceed anyway.

Read the `implement-issue` section of `.agents/memory/LESSONS.md` before starting, plus General.

## 1. Acceptance criteria

Read the issue and every comment (`gh issue view <N> --comments`). A triage comment, if there
is one, names the root cause or the acceptance criteria. Write a numbered list of criteria,
each an observable outcome: something a test can assert through a public API, an emitted
event, a port fake's state or CLI output.

If any criterion cannot be phrased that way, post the list as an issue comment with the open
question under it, apply `status:blocked`, and stop. Do not guess.

## 2. Branch and resume

The branch name is derived from the issue, so any session can find it:

```bash
n=<issue number>
slug=$(gh issue view "$n" --json title -q .title | tr '[:upper:]' '[:lower:]' \
  | sed -E 's/[^a-z0-9]+/-/g; s/^-//; s/-$//' | cut -c1-40 | sed -E 's/-$//')
branch="issue-$n-$slug"
```

Check before creating: `git fetch origin && git branch -r --list "origin/$branch"`. If it
exists, check it out, read the draft PR (`gh pr view "$branch"`), run the tests, and continue
from the failing count you find. Otherwise branch from `origin/main`.

## 3. Red tests

One test per criterion, at the lowest tier that can observe it:

| Tier | File name | Observes |
| --- | --- | --- |
| unit | `*.test.ts` | one module through its `index.ts`, fakes at the ports |
| integration | `*.integration.test.ts` | several real modules in-process, fakes only at the ports |
| e2e | `*.e2e.test.ts` | the real CLI subprocess and the fake app client |
| device | `e2e-device` skill | the real app on a simulator; never in CI |

Tests assert on behaviour only. No `vi.mock`, no spying on internals, no importing a module's
non-index files. Test names read as the spec. Run them; they must fail for the right reason
(the missing behaviour, not a typo). Then:

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

Run `pnpm lint && pnpm typecheck` before each commit, and the package's tests. Do not
refactor while red. When everything passes, one optional `refactor:` commit, then run the
full `pnpm test`.

Do not widen scope. Something you notice that is not a criterion becomes an issue via
`file-issue`, or a one-line note in the PR under "Out of scope".

## 5. Finish

- Add the changelog line under `## Unreleased` if the change is user-visible.
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
Changelog: added | not user-visible
Open: <blockers or questions, or "none">
```
