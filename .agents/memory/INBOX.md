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

- 2026-09-24 #108 skill: implement-issue
  What went wrong: the new no-tls-bypass lint rule's red tests covered only the literal spellings in the issue, so `vi.stubEnv(...)` and `globalAgent.options.rejectUnauthorized = false` got through.
  Would have prevented it: when an issue asks a lint rule to catch "equivalent" forms, write a red test for each way the pattern can be spelled (assignment, call argument, member assignment, object property) before implementing.
  Cost: review round
  Seen: 2026-09-28
- 2026-09-25 #118 skill: implement-issue
  What went wrong: the `app.events()` overloads put the uncapped signature first, so options with `payloadMaxBytes` passed through a variable (no excess-property check) resolved to it and `e.payload` compiled unnarrowed.
  Would have prevented it: when an optional field switches a return type, make the other overload forbid it (`field?: undefined`) and add a `@ts-expect-error` test that passes the options through a variable.
  Cost: review round
  Seen: 2026-09-28
- 2026-09-25 #119 skill: implement-issue
  What went wrong: the implementer left out `payloadMaxBytes` on `waitForEvent`, which the issue explicitly asks for. Moving each wait onto its own stream then broke `close()` three times over: pending waits were not closed, a wait whose stream was still opening escaped `close()`, and a failed open rejected with a raw socket error instead of `connection_error`.
  Would have prevented it: tick off every bullet of the issue's Expected outcome, not just the numbered criteria. When a call moves off a shared resource onto its own, list what the shared resource did for free (close on shutdown, error typing) and test each against the new resource, including `close()` with no tick before it and an open that rejects.
  Cost: three review rounds, fix-loop limit hit, issue blocked with one should-fix open
  Seen: 2026-09-28
- 2026-09-29 #140 skill: implement-issue
  What went wrong: the app closing its own socket for the background went through `onSocketLost`, which emits an `error` event for any close other than 1000, so every app switch fired the app's error listener.
  Would have prevented it: when adding a deliberate close or disconnect, list every event the existing loss path emits and write a red test for each one that must not fire.
  Cost: review round

- 2026-10-01 (#142) implement-issue: second review round
  Happened: round 1 found UIKit background time ended after a 2 s delay in the expiry handler and before the close frame on disconnect()/destroy(), plus README quoting `sessions ls` output that the CLI does not print.
  Rule: when wrapping an OS lifetime grant, end it inside the OS callback and only after any pending close frame is sent; quote CLI output from the label table, not from the wire value.
  Evidence: 4 should-fix findings on #142 round 1, all fixed in round 2.
