---
name: triage-issue
description: Triage a GitHub issue - for a bug, rank hypotheses, verify the top three by static analysis, name the root cause and a module-level fix; for a feature, check every claim against the code and turn the outcome into acceptance criteria. Sets status labels. Use when asked to triage, investigate or check an issue, or when an issue carries status:needs-triage.
---

# Triage an issue

Output is one issue comment under 300 words and a label change. You do not fix anything,
build apps or run simulators. Load the `architecture` skill; the fix you propose must fit it.
If told not to post, print the comment and the label commands instead.

```bash
gh issue view <N> --comments --json title,body,labels,comments
gh label list --limit 100 | grep -c '^status:' || scripts/sync-labels.sh   # labels present?
```

An issue with no `type:` label: decide bug or feature from the body and add the label. A
previous triage comment: read it first; your comment confirms it in one line or corrects it.

Read the `triage-issue` section of `.agents/memory/LESSONS.md` before starting, plus General.

## When to block

`status:blocked` whenever a human has to decide something before work can start: missing
reproduction or expected state, a product choice between two designs, scope that depends on
an answer. State the question as the first line of the comment. Otherwise `status:ready`.

## Bugs

1. **Restate** the failure in one sentence: what happens, what should happen.
2. **Hypothesise.** List plausible causes with a rough probability and the evidence for each.
   Rank. Take the top three.
3. **Verify statically.** For each, trace the code path the reproduction takes, from the
   entry point (CLI command, MCP tool, SDK call) to where behaviour diverges. Confirmed means
   you can cite the `path:line` that produces the symptom; rejected means the path cannot.
4. **If reading cannot settle it**, write one failing unit test against the public API that
   the top hypothesis predicts must fail, run it, and paste it in the comment. Do not commit
   it. It becomes the implementer's first red test. Go no further.
5. **Propose the fix at module level**: which module, call or event, what the new test
   asserts, what must not change. The simplest option that breaks nothing else. No code.

```
## Triage
**Root cause:** confirmed | top candidate, unconfirmed (<what would confirm it>)
<one paragraph with path:line>
**Rejected:** <hypothesis: why>, one line each
**Fix:** <module; call or event; what the test asserts; what stays the same>
**Risks:** <what else touches this path>
```

## Features

1. **Check every claim** in the issue against the tree: what it says exists, what it says is
   missing, what other issues it depends on. Issues go stale. List what changed, one line each.
2. **Write acceptance criteria**, numbered, each observable by a test. If one cannot be, say
   which and block.
3. **Check the design** against the `architecture` skill. Proposing a simpler shape that
   delivers the same outcome is in scope, at module level: which module, call or event, what
   is reused. Flag knobs with one value, duplicated surfaces, speculative extension points.
4. **Split.** Independent pieces become separate issues (say where the cut is; do not file
   them). A dependent chain stays one issue with the order stated; the criteria cover the
   first slice only.

```
## Triage
**Since filed:** <what changed in the code, one line each, or "nothing">
**Criteria:** 1. ... 2. ...
**Shape:** <module; call or event; what is reused; what the issue proposed that is not needed>
**Split:** <cut points, or "none">
**Question:** <the decision a human must make, or "none">
```

## Labels

Label the issue as triaged, not as written: the `area:` and `platform:` of the shape you
propose. `platform:` only when the change is platform-specific.

```bash
gh issue edit <N> --remove-label status:needs-triage --add-label status:ready,area:mcp
```

## Report

```
Issue: #N  Status: ready | blocked
Root cause: <one line, or "n/a (feature)">
Fix: <module and shape, one line>
Open: <question for a human, or "none">
```
