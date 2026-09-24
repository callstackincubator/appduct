---
name: steward-pr
description: Keep every open, non-draft agent PR mergeable, green and answered until a human merges it - update the branch when main moves, merge main in when it conflicts, delegate failing checks and human review comments to implement-issue, reply on every thread, record a Steward entry in the ledger. Use on a schedule, when asked to watch, babysit or sweep PRs, or with one PR number to handle that PR alone.
---

# Steward ready PRs

`work-issue` stops when a PR is ready for review. From then on main moves, checks go stale
and humans leave comments nobody reads. You pick that up: one sweep over the ready agent PRs,
each brought back to mergeable with every human comment answered, then a report. A sweep with
nothing to do posts nothing, pushes nothing and edits nothing.

Like `work-issue`, you never edit files, run builds or post review comments yourself. You run
`gh` and `git`, delegate anything that changes a file to a subagent with the matching skill
(Agent tool in Claude Code, task tool in OpenCode; the prompt names the PR, the branch, the
worktree, the one thing to do, "load the `<skill>` skill and follow it" and "end with that
skill's report and nothing else"), and reason over the report.

Never `gh pr merge`, never rebase, never force push, never resolve a review thread. A branch's
history only grows: `gh pr update-branch` and `git merge origin/main` add merge commits, and
the squash merge a human performs makes them disappear.

Read the `steward-pr` section of `.agents/memory/LESSONS.md` before starting, plus General.

## 1. Select

Without an argument, every open PR that is not a draft and whose ledger says `Ready: yes`.
The PR template ships the `### Status` heading with `Ready: no`, so the heading alone would
select every human PR opened from the template; `Ready: yes` is written only by
`work-issue` step 5 or by a human handing a PR over.

```bash
gh pr list --state open --limit 100 --json number,isDraft,body \
  -q '.[] | select(.isDraft | not) | select(.body | contains("### Status")) | select(.body | contains("Ready: yes")) | .number'
```

With a PR number, that PR alone; when it does not qualify, report `skipped: <reason>`
(`not open`, `draft`, `no ledger`, `not ready`) and stop. A draft belongs to its orchestrator: a stale
draft is an unfinished `work-issue` run, resumed by running `work-issue` on its issue. A PR
without the ledger (a human's, dependabot's) is never touched.

Handle the selected PRs one at a time, ascending, steps 2 to 7 each.

## 2. Take stock

```bash
gh pr view <N> --json headRefName,headRefOid,mergeStateStatus,closingIssuesReferences
gh pr checks <N>
```

Note `headRefOid`; step 6 compares against it. `mergeStateStatus` is `BEHIND` (main moved,
no conflict), `DIRTY` (conflict), `CLEAN`, `UNSTABLE` (mergeable, a non-required check
failing), `BLOCKED` (a required check or review is missing) or `UNKNOWN` (not computed yet;
re-read once after a few seconds).

Read review activity through REST, never GraphQL; cloud sessions allow only a pinned set of
GraphQL operations. Flags go after the path so the permission allowlist matches:

```bash
gh api repos/{owner}/{repo}/pulls/<N>/comments --paginate   # review threads: id, in_reply_to_id, path, line, body; {owner}/{repo} literally, gh fills them
gh api repos/{owner}/{repo}/pulls/<N>/reviews --paginate    # id, state, body, submitted_at
gh api repos/{owner}/{repo}/issues/<N>/comments --paginate  # id, body, created_at
```

A comment, review or body is **agent** activity when one of its lines is `-- agent: <skill>`;
everything else is **human**, whatever login posted it. Group review comments into threads by
`in_reply_to_id`. Needing an answer: a thread whose last comment is human; a human review
with state `CHANGES_REQUESTED` or a non-empty body, with no agent issue comment after it; a
human issue comment with no agent issue comment after it. An approval with an empty body
needs nothing.

`CLEAN`, checks green, nothing to answer: report `nothing to do`, do not touch the ledger,
next PR. Otherwise get a workspace; the worktree may still exist from the `work-issue` run:

```bash
branch=<headRefName>
dir=.worktrees/$branch; [ -d "$dir" ] || dir=$(.agents/scripts/worktree.sh "$branch")
cd "$dir" && git fetch origin && git merge origin/$branch --ff-only     # unquoted: the allowlist matches command text
```

## 3. Bring the branch up to date

- `BEHIND`: `gh pr update-branch <N>`, then in the worktree `git fetch origin && git merge
  origin/$branch --ff-only` so the local branch has the merge commit.
- `DIRTY`: in the worktree `git merge origin/main --no-edit`. A clean merge you push yourself
  with `git push origin "$branch"`. On conflicts, delegate to `implement-issue`: the worktree,
  the conflicting files from `git status`, "resolve the merge in progress keeping both sides'
  intent, run `pnpm build && pnpm test`, commit the merge as it is, push; do not rebase, do
  not widen scope".

Then `gh pr checks <N> --watch` and re-read the status. It must now be `CLEAN` or
`UNSTABLE`; `BEHIND` or `DIRTY` again means main moved meanwhile, so go round once more.

## 4. Get the checks green

```bash
gh pr checks <N> --json name,state,link           # the link ends in /job/<job id>
gh run view --job <job id> --log-failed | tail -n 80
```

Delegate to `implement-issue`: the worktree, the check name, the excerpt, "make this check
pass on the branch, tests-first for any behaviour you change, push, do not widen scope".
Then `gh pr checks <N> --watch` again.

## 5. Answer the humans

One `implement-issue` round with every item from step 2 pasted verbatim: the thread's top
comment id, `path`, `line` and body, or the review or comment id and body; "address each
item; when an item is wrong, change nothing for it and say why in the report; push". Then
reply on each item, fixed or declined, one sentence plus the commit:

```bash
gh api repos/{owner}/{repo}/pulls/<N>/comments/<top comment id>/replies -f body='<what changed, in <sha>>

-- agent: steward-pr'                                              # a review thread
gh pr comment <N> --body '<what changed, in <sha>, answering <login>'"'"'s review of <date>>

-- agent: steward-pr'                                              # a review body or issue comment
```

The thread stays open. The human who opened it resolves it, and their next reply makes it
human again for the next sweep.

## 6. Review and E2E what the sweep pushed

When `implement-issue` produced commits, delegate one `review-pr` round on the PR. Findings
above nit go back to `implement-issue` as one more round, with replies as in step 5 for
anything a human raised.

When `git diff --name-only <headRefOid>..HEAD` in the worktree touches `packages/native`,
`packages/react-native`, `playground` or `playground-native`, delegate `e2e-device` on the
PR. A failure is one more `implement-issue` round, then E2E once more.

## 7. Loop limit and the ledger

At most two `implement-issue` rounds per PR per sweep, whatever the reason. Past that, or when
a subagent reports blocked: one comment on the linked issue with what is stuck, what was tried
and the decision needed, ending with `-- agent: steward-pr`; `gh issue edit <I> --add-label
status:blocked`; leave the PR as it is, next PR.

After every PR you did something to, update its ledger: replace the previous `Steward:` entry
if there is one, keep the body's trailer as its last line.

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
