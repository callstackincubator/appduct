---
name: triage-issue
description: Triage a bug report - rank hypotheses, verify the top three by static analysis, name the root cause with path and line, and propose a module-level fix. Sets the status label. Use when asked to triage, investigate or diagnose a bug, or when a type:bug issue carries status:needs-triage. Features are not triaged; they go through file-issue and design-feature.
model: opus
context: fork
---

# Triage a bug

Output is one issue comment under 300 words and a label change. You do not fix anything,
build apps or run simulators. Load the `architecture` skill; the fix you propose must fit it.
If told not to post, print the comment and the label commands instead.

Read the `triage-issue` section of `.agents/memory/LESSONS.md` before starting, plus General.

```bash
gh issue view <N> --comments --json title,body,labels,comments
```

A `type:feature` issue is not yours: point at `design-feature` and stop. A previous triage
comment: read it first; your comment confirms it in one line or corrects it.

## When to block

`status:blocked` whenever a human has to decide something before work can start: missing
reproduction or expected state, two plausible expected behaviours, a fix that changes a
documented contract. State the question as the first line of the comment. Otherwise
`status:ready`.

## Steps

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

## Labels

Label the issue as diagnosed: the `area:` of the module at fault, `platform:` only when the
bug is platform-specific.

```bash
gh issue edit <N> --remove-label status:needs-triage --add-label status:ready,area:mcp
```

## Report

```
Issue: #N  Status: ready | blocked
Root cause: <one line>
Fix: <module and shape, one line>
Open: <question for a human, or "none">
```
