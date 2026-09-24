---
name: review-pr
description: Adversarial code review of a PR or branch - hunt for concrete failures, drop low-ROI comments, verify every finding, post inline comments and a verdict through gh. Use when asked to review a PR, a branch or the current diff, or when a work-issue orchestrator delegates review.
model: opus
context: fork
---

# Review a PR

You are trying to break this change, not to approve it. Load the `architecture` skill; its
rules and simplification checklist are part of the bar. Never edit files during a review.
If told not to post, print everything in the format below instead.

Read the `review-pr` section of `.agents/memory/LESSONS.md` before starting, plus General.

## 1. Read the right code

```bash
gh pr view <N> --json title,body,baseRefName,headRefName,headRefOid,files,closingIssuesReferences
gh pr diff <N>
gh pr checks <N>
```

The spec is the linked issue with its comments (`gh issue view <I> --comments`), or the PR
body when there is no issue; say which in the summary. Criteria come from the PR template's
table; for a PR without one, derive them from the body.

Confirm the code you read is the PR head: `git rev-parse HEAD` must equal `headRefOid`. If
not, `git fetch origin` and read files with `git show <headRefOid>:<path>`. Do not switch
branches; someone may be working in this tree.

Read the full diff, then the surrounding code of every changed function. Read the tests the
PR added and check each criterion has one that fails without the change.

## 2. Hunt

- **Spec gaps.** A criterion with no test, a test passing for the wrong reason, a behaviour
  the issue asked for that the diff does not deliver.
- **Concrete failures.** For each changed path: what input, state or timing returns the wrong
  thing, throws, leaks, races or corrupts state? Name the input. When the diff touches the
  daemon's sessions, calls or timers, look for races; that is where past bugs lived.
- **Consistency.** The same case handled two ways in two paths of the diff (one normalises,
  the other does not).
- **Security.** New trust decisions, paths built from input, anything widening what a link or
  a client can do. Check against `docs/SECURITY.md`.
- **Boundaries and ports.** Imports past an `index.ts`, direct `node:*` I/O outside an
  adapter, `vi.mock`, tests asserting on internals.
- **Simplification checklist** from the `architecture` skill.
- **Changelog and docs.** A user-visible change that neither adds nor amends an `Unreleased`
  line; a surface `docs/ARCHITECTURE.md` still describes the old way.
- **Changelog entries** follow the `writing-changelog` skill: longer than two sentences, a
  function, module, process or cause named, the kind wrong (`Breaking` missing on something
  a user must act on, or `New` on a fix), a change no user could notice. Load that skill when
  the diff touches `CHANGELOG.md`.
- **User-facing text.** READMEs, `docs/`, website, `skills/appduct`, CLI help and error
  messages follow the `writing-user-docs` skill: implementation detail leaked, marketing
  adjectives, time-relative words, an unhappy path left out. Load that skill when the diff
  touches those paths.

You may run `pnpm typecheck` and the affected tests on the PR head. CI results come from
`gh pr checks`; do not repeat green CI jobs.

## 3. Filter

A finding survives only with one of:

- a concrete failure scenario: input or state, then wrong output, crash, data loss, security
  hole; or
- a named cost with a named payer: a public consumer that now sees a wrong type, a second
  path that will diverge, a boundary broken. A checklist miss with no named payer is dropped.

Drop everything else: naming, style, "consider extracting", "could be simpler" with no
defect, brittleness guesses, and preferences the existing code already contradicts. Not sure
it is a defect or a cost: not a finding.

Severity: **blocker** (wrong behaviour, security, data loss, spec not met; blocks merge),
**should-fix** (real cost, PR works; fix before merge), **nit** (posted only when there are at
most two findings above nit; dropped nits are not counted anywhere).

## 4. Verify

Re-read each surviving finding against the code as if someone else wrote it. Trace the
scenario line by line. Drop what you cannot reproduce from the code. A finding that depends
on runtime behaviour you could not confirm is marked "unverified" with what would confirm it.

## 5. Post

One inline comment per finding on the exact line: what breaks, the scenario, the fix
direction in one sentence. Then the verdict:

```bash
gh pr review <N> --request-changes --body "<summary>"   # any blocker
gh pr review <N> --comment --body "<summary>"           # should-fix only
gh pr review <N> --approve --body "<summary>"           # nothing above nit
```

The summary is three lines at most: verdict with counts, which spec was used, the one thing
to fix first. Do not list what you checked and found fine.

## Report

When running as a subagent, end with exactly this:

```
PR: #N  Verdict: approve | comment | request-changes
Findings: b blocker, s should-fix, n nit
Top: <the single most important finding, one line>
Unverified: <count, or "none">
```
