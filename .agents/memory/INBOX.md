# Lessons inbox

Raw notes from finished work. Append only; never read this file before a task. The
`review-memory` skill reads it, promotes what repeats into [LESSONS.md](LESSONS.md), drops the
rest, and empties it.

One note per PR that hit friction, four lines:

```
- YYYY-MM-DD #PR skill: <which skill was running>
  What went wrong: <one sentence>
  Would have prevented it: <the rule, one sentence>
  Cost: <review round, e2e rerun, blocked, wrong merge>
```

- 2026-09-22 #89 skill: review-pr
  What went wrong: the round-2 reviewer could not post an APPROVE review because the gh account also authored the PR; GitHub rejects self-approval, so the verdict landed as a comment review.
  Would have prevented it: review-pr should check whether the PR author is the current gh user and, if so, post the verdict as a comment review saying "approve" instead of trying the approve event.
  Cost: review round
