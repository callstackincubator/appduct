---
name: steward-pr
description: Keep every open, non-draft agent PR mergeable, green and answered until a human merges it - update the branch when main moves, merge main in when it conflicts, delegate failing checks and human review comments to implement-issue, reply on every thread, record a Steward entry in the ledger. Use on a schedule, when asked to watch, babysit or sweep PRs, or with one PR number to handle that PR alone.
---

# Steward ready PRs

`work-issue` stops when a PR is ready for review. From then on main moves, checks go stale
and humans leave comments nobody reads. You pick that up: one sweep over the ready agent PRs,
each brought back to mergeable and every human comment answered, then a report. A sweep with
nothing to do posts nothing, pushes nothing and edits nothing.

Like `work-issue`, you never edit files, run builds or post review comments yourself. You run
`gh` and `git`, delegate anything that changes a file to a subagent with the matching skill,
and reason over its report. Subagents: in Claude Code the Agent tool with a fresh
general-purpose agent per step, in OpenCode the task tool; the prompt names the PR, the
branch, the worktree, the one thing to do, "load the `<skill>` skill and follow it" and "end
with that skill's report and nothing else".

Never `gh pr merge`, never rebase, never force push, never resolve a review thread. The
history of a branch only grows: `gh pr update-branch` and `git merge origin/main` add merge
commits, and the squash merge a human performs makes them disappear.

Read the `steward-pr` section of `.agents/memory/LESSONS.md` before starting, plus General.

## 1. Select

Without an argument, every open PR that is not a draft and whose body carries the
`work-issue` ledger:

```bash
gh pr list --state open --json number,isDraft,body \
  -q '.[] | select(.isDraft | not) | select(.body | contains("### Status")) | .number'
```

With a PR number, that PR alone; when it does not qualify, report `skipped: <reason>`
(`not open`, `draft`, `no ledger`) and stop. A draft belongs to its orchestrator: a stale
draft is an unfinished `work-issue` run, resumed by running `work-issue` on its issue. A PR
without the ledger (a human's, dependabot's) is never touched.

Handle the selected PRs one at a time, in ascending number order, steps 2 to 7 each.

## 2. Take stock

```bash
gh pr view <N> --json headRefName,headRefOid,mergeStateStatus,closingIssuesReferences
gh pr checks <N>
```

Note `headRefOid`; the report and the E2E decision compare against it. `mergeStateStatus`
is `BEHIND` (main moved, no conflict), `DIRTY` (conflict), `CLEAN`, `UNSTABLE` (mergeable,
a non-required check failing), `BLOCKED` (a required check or review is missing) or
`UNKNOWN` (GitHub has not computed it yet; re-read once after a few seconds).

Read every piece of review activity through REST, never GraphQL; cloud sessions allow only a
pinned set of GraphQL operations:

```bash
gh api repos/{owner}/{repo}/pulls/<N>/comments --paginate   # review threads: id, in_reply_to_id, path, line, body, created_at
gh api repos/{owner}/{repo}/pulls/<N>/reviews --paginate    # id, state, body, submitted_at
gh api repos/{owner}/{repo}/issues/<N>/comments --paginate  # id, body, created_at
```

A comment, review or body is **agent** activity when one of its lines is `-- agent: <skill>`;
everything else is **human**, whatever login posted it. Group review comments into threads
by `in_reply_to_id`. Needing an answer:

- a thread whose last comment is human;
- a human review whose state is `CHANGES_REQUESTED` or whose body is not empty, with no
  agent issue comment posted after it;
- a human issue comment with no agent issue comment posted after it.

An approval with an empty body needs nothing. Nothing to do when the status is `CLEAN`, the
checks are green and nothing needs an answer: report `nothing to do` and go to the next PR.
Do not touch the ledger for a PR you did nothing to.

Otherwise get a workspace. The worktree may already exist from the `work-issue` run:

```bash
branch=<headRefName>
dir=.worktrees/$branch; [ -d "$dir" ] || dir=$(.agents/scripts/worktree.sh "$branch")
cd "$dir" && git fetch origin && git merge "origin/$branch" --ff-only
```

## 3. Bring the branch up to date

- `BEHIND`: `gh pr update-branch <N>`, then in the worktree `git fetch origin && git merge
  "origin/$branch" --ff-only` so the local branch has the merge commit.
- `DIRTY`: in the worktree `git merge origin/main --no-edit`. When it stops on conflicts,
  delegate to `implement-issue`: the worktree, the conflicting files from `git status`,
  "resolve the merge in progress keeping both sides' intent, run `pnpm build && pnpm test`,
  commit the merge as it is, push; do not rebase, do not widen scope". A clean merge you
  push yourself: `git push origin "$branch"`.

Then `gh pr checks <N> --watch` and re-read the status. It must now be `CLEAN` or
`UNSTABLE`; `BEHIND` or `DIRTY` again means main moved while you worked, so go round once
more.

## 4. Get the checks green

For each failing check, the log excerpt is what the fixer needs:

```bash
gh pr checks <N> --json name,state,link      # the link ends in /job/<job id>
gh run view --job <job id> --log-failed | tail -n 80
```

Delegate to `implement-issue`: the worktree, the check name, the excerpt, "make this check
pass on the branch, tests-first for any behaviour you change, push, do not widen scope".
Then `gh pr checks <N> --watch` again.

## 5. Answer the humans

Delegate one `implement-issue` round with every item from step 2 pasted verbatim: the
thread's top comment id, `path`, `line` and body, or the review or comment id and body.
Ask for "address each item; when an item is wrong, change nothing for it and say why in the
report; push". Then reply on each item, whether it was fixed or declined:

```bash
# a review thread: reply under its top comment
gh api repos/{owner}/{repo}/pulls/<N>/comments/<top comment id>/replies -f body='<what changed, in <sha>>

-- agent: steward-pr'
# a review body or an issue comment: one PR comment naming it
gh pr comment <N> --body '<what changed, in <sha>, answering <login>'"'"'s review of <date>>

-- agent: steward-pr'
```

One sentence on what changed and the commit, or one sentence on why not. The thread stays
open; the human who opened it resolves it, and their next reply makes the thread human
again for the next sweep.

## 6. Review and E2E what the sweep pushed

When `implement-issue` produced commits in this sweep, delegate one `review-pr` round on the
PR. Findings above nit go back to `implement-issue` as a further round (step 7 counts it),
then replies for anything a human raised go out as in step 5.

When `git diff --name-only <headRefOid from step 2>..HEAD` in the worktree touches
`packages/native`, `packages/react-native`, `playground` or `playground-native`, delegate
`e2e-device` on the PR. A failure is one more `implement-issue` round, then E2E once more.

## 7. Loop limit and the ledger

At most two `implement-issue` rounds per PR per sweep, whatever the reason (conflicts,
checks, review items, review findings, E2E). Past that, or when a subagent reports blocked:
one comment on the linked issue with what is stuck, what was tried and the decision needed,
ending with `-- agent: steward-pr`; `gh issue edit <I> --add-label status:blocked`; leave the
PR as it is and move to the next one.

After every PR you did something to, update its ledger. Replace the previous `Steward:`
entry if there is one, keep the body's trailer as its last line:

```bash
gh pr view <N> --json body -q .body > <scratch>/body.md     # edit the ### Status line
gh pr edit <N> --body-file <scratch>/body.md
```

```
Implement: done (5/5 green)  Review: round 2, approve  E2E: pass (iOS)  Ready: yes  Steward: 2026-09-24 merged main (2 conflicts), answered 3 threads, checks green
```

## Report

End with exactly this, one line per selected PR:

```
Steward sweep: <date>  PRs: <selected> of <open>
#N: updated from main | merged main (<k> conflicts) | checks green (round <r>) | answered <k> items | e2e pass | blocked: <why> | nothing to do | skipped: <reason>
Posted: <comments and replies>  Pushed: <PRs>
```
