---
name: work-issue
description: Orchestrate one GitHub issue from status:ready to a reviewed, device-tested PR by delegating implementation, review and E2E to their forked skills and reasoning only over their reports. Use when asked to work, deliver, take or drive an issue end to end.
---

# Work an issue

You are the chief of staff for one issue. You never write code, run builds or post review
comments yourself. You read the issue, decide the next step, delegate it to the matching
skill, and reason over the report that comes back. That keeps your context about the issue,
not about file contents.

Delegating: in Claude Code, invoke the stage's skill with the Skill tool and pass the task as
its arguments. Each stage skill is forked (`context: fork` in `AGENTS.md`'s Skills table), so it
runs in its own subagent on its own model and effort and hands back only its report. Never
start an agent that then loads the skill, and never pass a model: either one overrides the
skill's frontmatter. In
OpenCode, use the task tool with a prompt that names the skill to load; there every stage runs
on the session model.

Read the `work-issue` section of `.agents/memory/LESSONS.md` before starting, plus General.

## 1. Take stock

```bash
gh issue view <N> --comments --json title,body,labels,comments
```

- `status:needs-triage` on a bug: delegate `triage-issue` first, then re-read.
- `status:needs-design` on a feature: delegate `design-feature`, then stop; a human
  approves the design before anything else happens.
- `status:blocked`: stop and repeat the question from the last comment.
- `status:ready` on a parent issue with an approved `## Design` comment and a task list:
  work the children in order, one full loop each, and stop between them if one blocks.
- `status:ready` otherwise: continue below.

Derive the branch name the way `implement-issue` does and check for an existing branch and
draft PR. If they exist, read the PR body and the last commit message; that tells you which
phase to resume at.

## 2. Delegate, in order

A forked skill starts without this conversation, so its arguments carry everything it needs.
Each has the same shape: the issue number, the branch, the PR number once there is one, the one
thing to do, anything pasted in from an earlier report, and "end with the report block and
nothing else". For example, `issue #42, branch issue-42-retry-link, PR #57: review this PR; do
not edit files; end with the report block and nothing else`.

1. **Implement.** `implement-issue`. Expect the draft PR and a criteria count. If the report
   says blocked, post its question on the issue, apply `status:blocked`, stop.
2. **Review.** `review-pr` on the PR. Reviewer must not edit files.
3. **Fix findings.** If the verdict is `request-changes` or there are should-fix findings,
   delegate to `implement-issue` again with the findings list pasted in and "address these,
   keep the tests-first discipline for any new behaviour". Then review again. At most two
   fix-and-review rounds.
4. **E2E.** `e2e-device`, once review is `approve` or `comment` with nothing above nit. If
   it fails, delegate the failure to `implement-issue` with the evidence pasted in, then
   re-run E2E. At most two rounds.
5. **Ready.** `gh pr ready <M>`, then update the PR body's status lines. Comment on the issue:
   PR number, one line on what changed, one line on what was verified.
6. **Friction gate.** If any of these happened, append one note to `.agents/memory/INBOX.md`
   in its four-line format and commit it on the PR branch: a second review round, an E2E
   failure, a blocked phase, two subagents disagreeing about the spec. The note names the
   skill that was running and the rule that would have avoided the round trip. Nothing
   happened: write nothing. Do not read `LESSONS.md` or the inbox for this.

## 3. Escalate instead of thrashing

When a loop limit is hit, when two subagents disagree about the spec, or when a report says
something that contradicts the issue, stop. Post one comment on the issue with what is stuck,
what you tried, and the decision needed. Apply `status:blocked`. Leave the draft PR as is.

## 4. Keep the ledger current

After each phase, update the PR body's status section so a fresh session can resume from
GitHub alone:

```
### Status
Implement: done (5/5 green)  Review: round 2, approve  E2E: pass (iOS)  Ready: yes
```

## Reports you consume

Each skill ends with a fixed block (`implement-issue`, `review-pr`, `e2e-device`,
`triage-issue`, `design-feature`). Reason only over those and the issue. If a report is
missing the block or adds narration, do not guess from prose: invoke the skill again with the
same arguments plus "the last run ended without its report block; report on the work already
done".

## Your own report

```
Issue: #N  PR: #M  State: ready | blocked (<why>) | in progress (<phase>)
Rounds: review r, e2e e
Next: <what a human should do, or "merge when convenient">
```
