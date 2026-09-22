---
name: file-issue
description: Turn a request or a discovered bug into a GitHub issue in this repo's format - interview the person until the intent is well defined, check for duplicates, then file. Use when asked to file, open, create or write up an issue, when someone describes a feature they want, or when you hit a bug you should not fix in the current change.
---

# File an issue

Never file an issue for something you can fix inside the change you are already making.
Note it in the PR instead. If told not to create the issue, print the title, labels and body
in the format below instead of running `gh issue create`.

Read the `file-issue` section of `.agents/memory/LESSONS.md` before starting, plus General.

## 1. Pin the intent down

An issue is the spec that tests get written from, so a vague issue produces the wrong
feature. Before writing anything, check whether you can fill every field below from what you
have. For each one you cannot, ask the person one question at a time, with your best guess
as the suggested answer, and wait. Stop asking when the fields are filled or after five
questions; then write what you have and mark the rest "open".

- **Feature.** Why (the cost today, who pays it, when), expected outcome (what you can observe
  once it exists), constraints and non-goals, and how we will know it is done (criteria a
  test can check). Ask about the edge the person has not mentioned: the unhappy path, other
  platforms, what happens to existing users.
- **Bug.** Reproduction from a clean state, expected state, platform and version. If you
  found the bug yourself, you have these; do not interview yourself.

Skip the interview when the request came from an agent report, a triage comment or an
approved design that already answers everything.

## 2. Check for a duplicate

Two searches: distinctive words from the symptom or outcome, then the literal identifier
involved (a file name, command, error type).

```bash
gh issue list --limit 1                                   # non-empty, so gh works
gh issue list --state all --search "<three or four words>" --limit 10
gh issue list --state all --search "<literal identifier>" --limit 10
```

If one exists, comment on it with what you have and report its number.

## 3. Write it

The body mirrors the issue form in `.github/ISSUE_TEMPLATE/` field for field, as `###`
headings with the form's labels, in the form's order. Style from `AGENTS.md`: outcome first,
plain English, nothing that does not help someone act on it.

**Bug**, title describes the symptom, not the fix (`pnpm showcase fails: script file
missing`):

```
### What happens
### What should happen
### Reproduction          exact commands from a clean state and their output; how often if intermittent
### Appduct version       the installed version, or the commit sha when running from this repo
### Platform              iOS, Android, React Native, or None (daemon, CLI, MCP, repo tooling)
### Environment           OS, Xcode or Android SDK, simulator or device, Node
### Root cause            only what you traced in code, with path:line; otherwise "not investigated"
```

**Feature**, title is imperative (`Let apps declare read-only resources`):

```
### Why                       the problem or cost today; who hits it and when
### Expected outcome          observable behaviour once it exists
### Constraints and non-goals what must not change; security or compatibility limits; out of scope
### How we know it is done    numbered acceptance criteria, each observable by a test
### Alternatives considered   one line each, or "none"
```

Write the body to the session scratch directory, not into the repo.

## 4. Size it and create it

A bug is always `status:needs-triage`; the `triage-issue` skill finds the root cause.

A feature is `status:ready` when it fits one PR: one package, no new public API beyond what
the criteria name, no wire or protocol change. Otherwise it is `status:needs-design`, and
the `design-feature` skill turns it into slices. When unsure, `needs-design`; a design pass
on a small feature costs minutes, skipping it on a big one costs a rewritten PR.

```bash
gh issue create --title "<under 70 chars>" \
  --label type:feature,status:ready,area:mcp \
  --body-file <scratch>/issue.md
```

Labels, from `.github/labels.yml`: exactly one `type:`, exactly one `status:`, `platform:`
only when platform-specific, `area:` when one fits (`area:tooling` covers repo scripts, CI
and workspace config).

## Report

```
Issue: #N (new) | #N (existing, commented) | not created (dry run)
Type: bug | feature   Status: needs-triage | ready | needs-design
Open: <fields left open after the interview, or "none">
```
