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

- 2026-09-22 #89 skill: review-pr
  What went wrong: the round-2 reviewer could not post an APPROVE review because the gh account also authored the PR; GitHub rejects self-approval, so the verdict landed as a comment review.
  Would have prevented it: review-pr should check whether the PR author is the current gh user and, if so, post the verdict as a comment review saying "approve" instead of trying the approve event.
  Cost: review round
- 2026-09-24 #99 skill: implement-issue
  What went wrong: the new integration test set NODE_TLS_REJECT_UNAUTHORIZED=0 and rejectUnauthorized: false, copied from older tests, which raised two high CodeQL alerts and a second review round.
  Would have prevented it: a daemon integration test trusts the daemon's certificate via `ca: daemon.tls.current().certPem` and never disables TLS verification.
  Cost: review round
- 2026-09-24 #100 skill: work-issue
  What went wrong: device E2E could not run in the cloud session because the Linux container has no iOS simulator, so both slices waited for a human to run it locally.
  Would have prevented it: at the start, check for a simulator (xcrun, or an Android emulator with KVM) and, if there is none, ask the human up front to run e2e-device locally.
  Cost: blocked
