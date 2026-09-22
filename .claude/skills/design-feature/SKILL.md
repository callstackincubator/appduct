---
name: design-feature
description: Design a feature that is too big for one PR - verify the issue's claims against the code, choose the shape (modules, public API, calls vs events, ports), cut it into ordered slices each with its own acceptance criteria, and after a human approves, file one child issue per slice. Use on issues labelled status:needs-design, or when asked to design, shape or break down a feature.
---

# Design a feature

The bug counterpart of this skill is `triage-issue`. This one takes a feature request whose
outcome is clear but whose shape is not, and produces a design a human can approve in five
minutes and agents can implement slice by slice without talking to each other.

Load the `architecture` skill first. Read the `design-feature` section of
`.agents/memory/LESSONS.md`, plus General.

```bash
gh issue view <N> --comments --json title,body,labels,comments
```

## 1. Check the premise

Issues go stale. Check every claim the issue makes about what exists, what is missing and
what it depends on against `origin/main`, and list what changed. If the change removes the
need for the feature, say so and stop; the human closes the issue.

## 2. Decide whether it needs a design at all

If the outcome fits one PR after all (one package, no new public surface beyond what the
criteria name, no wire change), do not design it. Confirm the criteria are testable, fix
their wording if needed, move the issue to `status:ready`, and report.

## 3. Shape it

Read the code the feature touches. Then decide, and write down in this order:

- **Goal**: one sentence, the observable outcome.
- **Shape**: which modules change or appear; each new public API as a signature; for each
  cross-module interaction, whether it is a call (caller needs the result) or an event
  (side effect); each new port and its fake. Prefer the shape that touches the fewest
  modules and reuses what exists. Run the simplification checklist on your own design.
- **Not in scope**: what the issue asked for that this design leaves out, and why.
- **Slices**: an ordered list, each independently shippable and leaving `main` working,
  each with its own numbered acceptance criteria a test can observe. The first slice is the
  thinnest vertical cut that proves the shape end to end. A slice that cannot be tested on
  its own is two slices cut in the wrong place.
- **Risks and open questions**: what could invalidate the design; what needs a decision.

Keep it under 500 words. A signature is worth a paragraph.

## 4. Post it and wait

Post the design as one issue comment headed `## Design`. Move the issue to
`status:blocked` with the first line "Question: approve this design?". Stop. Do not file
slices yet.

## 5. After approval

A human moves the parent to `status:ready` (or replies "approved"). Then, and only then:

- File one child issue per slice with the `file-issue` skill: `type:feature`,
  `status:ready`, title from the slice, body with the slice's criteria, first line
  "Part of #<parent>". No interview; the design already answered it.
- Edit the parent body to add a task list linking every child in order.
- The parent keeps `status:ready` and closes when the last child closes.

`work-issue` on the parent means: work the children in order.

## Report

```
Issue: #N  Outcome: ready (small) | design posted, blocked on approval | slices filed: #a #b #c
Shape: <modules, one line>
Slices: <count, first one named>
Open: <question for a human, or "none">
```
