# Lessons inbox

Raw notes from finished work. Append only; never read this file before a task. The
`review-memory` skill reads it weekly, promotes what repeats into [LESSONS.md](LESSONS.md),
keeps a lone note for one more review (marked `Seen:`), and drops the rest.

One note per PR that hit friction, four lines:

```
- YYYY-MM-DD #PR skill: <which skill was running>
  What went wrong: <one sentence>
  Would have prevented it: <the rule, one sentence>
  Cost: <review round, e2e rerun, blocked, wrong merge>
```

- 2026-10-02 #147 skill: implement-issue
  What went wrong: the shipped skill's writing-tools.md and docs/TOOLS.md described declaring events for React Native only, and claimed dev warnings that only the React Native SDK gives.
  Would have prevented it: when a feature ships in several SDKs, write the user docs with one snippet per SDK and scope each behaviour claim to the SDKs that have it.
  Cost: review round
  Seen: 2026-10-05
