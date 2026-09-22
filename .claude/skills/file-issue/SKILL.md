---
name: file-issue
description: Write a bug report or feature request as a GitHub issue in this repo's format, after checking for duplicates. Use when you hit a bug you should not fix in the current change, when asked to write up a feature, or when asked to file, open or create an issue.
---

# File an issue

Never file an issue for something you can fix inside the change you are already making.
Note it in the PR instead. If told not to create the issue, print the title, labels and body
in the format below instead of running `gh issue create`.

## 1. Check for a duplicate

Two searches: distinctive words from the symptom, then the literal identifier involved (a
file name, command, error type).

```bash
gh issue list --limit 1                                   # non-empty, so gh works
gh issue list --state all --search "<three or four words>" --limit 10
gh issue list --state all --search "<literal identifier>" --limit 10
```

If one exists, comment on it with what you have rather than opening a new one, and report
its number.

## 2. Write it

The body mirrors the issue form in `.github/ISSUE_TEMPLATE/` field for field, as `###`
headings with the form's labels, in the form's order. Humans and agents then produce one
shape. Style from `AGENTS.md`: outcome first, plain English, nothing that does not help
someone act on it.

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
### Expected outcome          observable behaviour once it exists, phrased so a test could check it
### Constraints and non-goals what must not change; security or compatibility limits; out of scope
### Alternatives considered   one line each, or "none"
```

Write the body to the session scratch directory, not into the repo.

## 3. Create it

```bash
gh issue create --title "<under 70 chars>" \
  --label type:bug,status:needs-triage,platform:ios,area:cli \
  --body-file <scratch>/issue.md
```

Labels, from `.github/labels.yml`: exactly one `type:`, `status:needs-triage` always,
`platform:` only when platform-specific, `area:` when one fits (`area:tooling` covers repo
scripts, CI and workspace config). If `gh label list` shows the namespaced labels are
missing, run `scripts/sync-labels.sh` first.

## Report

```
Issue: #N (new) | #N (existing, commented) | not created (dry run)
Type: bug | feature
```
