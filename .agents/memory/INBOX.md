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
- 2026-10-02 #143 skill: implement-issue
  What went wrong: the new event-descriptors.json conformance fixture left out the non-object and description-non-string vectors that tool-descriptors.json has, and had no non-ASCII name to pin the 4096 limit in UTF-16 code units.
  Would have prevented it: when adding a descriptor fixture, start from every vector class in the nearest existing fixture and add one boundary vector in non-BMP characters for any length limit.
  Cost: review round
- 2026-10-02 #145 skill: implement-issue
  What went wrong: the Swift event registry sent the post-ack snapshot from an unstructured Task, so later deltas could overtake it, and the shared frames fixture pinned an order the SDK did not guarantee (test flaked 9 in 25).
  Would have prevented it: when a fixture pins frame order across an async boundary, route those frames through one ordered queue and run the fixture test 25 times before committing.
  Cost: review round
- 2026-10-02 #146 skill: implement-issue
  What went wrong: in Kotlin, a registerEvent called from a session-change listener during ack handling sent its delta before the ack's snapshot, which then erased it on the daemon.
  Would have prevented it: when an SDK sends a snapshot on ack, test a declaration made from a listener and from another thread during ack handling, not just before and after it.
  Cost: review round
- 2026-10-02 #147 skill: implement-issue
  What went wrong: the shipped skill's writing-tools.md and docs/TOOLS.md described declaring events for React Native only, and claimed dev warnings that only the React Native SDK gives.
  Would have prevented it: when a feature ships in several SDKs, write the user docs with one snippet per SDK and scope each behaviour claim to the SDKs that have it.
  Cost: review round
- 2026-10-02 #143 skill: implement-issue
  What went wrong: adding --limit/--offset to `events ls` "mirroring tools ls" copied the flags but not tools' empty-page message or footer rule, so a page past the end printed "No events declared." for a session that had events.
  Would have prevented it: when mirroring another command's paging, port its renderer cases too (empty page with total > 0, last page footer) and test each against the original's output.
  Cost: review round
- 2026-10-06 #170 skill: implement-issue
  What went wrong: the web core closed sockets with 1008 and 1011, which a browser WebSocket.close() rejects with InvalidAccessError; only codes 1000 and 3000 to 4999 are allowed.
  Would have prevented it: when porting a core to a new runtime, type the transport port's close codes to what that runtime's real API accepts, and make the fake throw on the rest.
  Cost: review round
- 2026-10-06 #168 skill: implement-issue
  What went wrong: a session's resume path wasn't checked against the listener it was claimed on, so a loopback-only web session could be resumed through the all-interfaces TLS listener; found only in review round 2, along with a missed PROTOCOL.md update.
  Would have prevented it: when a feature adds a second listener or transport, list every entry point that accepts a token (claim, resume) and write a refusal test for each, and grep docs/PROTOCOL.md for the old single-transport wording.
  Cost: review round
- 2026-10-06 #171 skill: implement-issue
  What went wrong: a browser-based test was added without adding the browser install to CI and contributor setup, so `pnpm test` failed on a fresh clone and a second review round was needed.
  Would have prevented it: when a test needs a new external binary, add its install to CI and AGENTS.md Commands in the same commit.
  Cost: review round
- 2026-10-06 #173 skill: implement-issue
  What went wrong: making a package public updated its docs entry points but left docs/ARCHITECTURE.md calling it "not yet published" and didn't describe what a plain-esbuild dev user sees with the inert entry; caught in review, needing a second round.
  Would have prevented it: when changing a package's exports or publish state, grep the repo for its name in docs/ and skills/ and update every description, including the failure symptoms of each entry.
  Cost: review round
- 2026-10-06 #172 skill: implement-issue
  What went wrong: a new entry (React Native's web entry) re-exported a subset of the API its shared types promise, so a documented setup type-checked but crashed on web; and after merging #173, a new requirement (`withAppduct` to connect RN web in development) went undocumented. Both needed extra review rounds.
  Would have prevented it: when adding a platform entry behind shared types, add it to the export-parity tests in the same commit; when a merge changes what setup is required, grep docs/, website/ and skills/ for the setup steps and update them in the merge.
  Cost: review round
- 2026-10-06 #183 skill: implement-issue
  What went wrong: attachPage registered a page binding per call, so a second attach on the same page threw, and the fix's re-attach semantics then needed a second review round.
  Would have prevented it: For any API that installs per-target state (bindings, listeners), write a test that calls it twice on the same target before opening the PR.
  Evidence: PR #183 review rounds 1 and 2.
