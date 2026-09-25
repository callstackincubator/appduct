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
  Seen: 2026-09-24
- 2026-09-24 #100 skill: work-issue
  What went wrong: device E2E could not run in the cloud session because the Linux container has no iOS simulator, so both slices waited for a human to run it locally.
  Would have prevented it: at the start, check for a simulator (xcrun, or an Android emulator with KVM) and, if there is none, ask the human up front to run e2e-device locally.
  Cost: blocked
  Seen: 2026-09-24
- 2026-09-24 #108 skill: implement-issue
  What went wrong: the new no-tls-bypass lint rule's red tests covered only the literal spellings in the issue, so `vi.stubEnv(...)` and `globalAgent.options.rejectUnauthorized = false` got through.
  Would have prevented it: when an issue asks a lint rule to catch "equivalent" forms, write a red test for each way the pattern can be spelled (assignment, call argument, member assignment, object property) before implementing.
  Cost: review round

- 2026-09-25 #111 skill: implement-issue
  What went wrong: sweeps for removed CLI forms grepped whole command patterns (`appduct <word>`) and missed `playground:appduct -- link`, a command wrapped across a line break, and a removed flag named inside an output hint.
  Would have prevented it: when renaming a CLI surface, grep the bare old words (`invoke`, `--since`) across the whole repo, multiline too, and check every hit by hand before the first review.
  Cost: review rounds 2-4, blocked at the fix-round limit; E2E also blocked (no simulator in the cloud container)
- 2026-09-25 #117 skill: implement-issue
  What went wrong: the event-name glob was compiled to a regex with `.*` per `*`, which backtracks exponentially on many-star patterns and would block the single-threaded daemon; review caught it and a second round replaced it with a hand-written matcher.
  Would have prevented it: match user-supplied wildcard patterns in the daemon without building a regex (split on `*` and `indexOf` each piece), and add a many-star timing test with the red tests.
  Cost: review round; E2E also blocked (no simulator in the cloud container)
- 2026-09-25 #118 skill: implement-issue
  What went wrong: the `app.events()` overloads put the uncapped signature first, so options with `payloadMaxBytes` passed through a variable (no excess-property check) resolved to it and `e.payload` compiled unnarrowed; a second round then fixed `dropped` docs that described the evicted events as before `since` instead of after it.
  Would have prevented it: when an optional field switches a return type, make the other overload forbid it (`field?: undefined`) and add a `@ts-expect-error` test that passes the options through a variable; check each doc comment on a derived count against its formula with a worked example.
  Cost: two review rounds; E2E blocked (no simulator in the cloud container)
