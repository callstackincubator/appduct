# Lessons

Curated memory for agents working on this repo. Read only the section named after the skill
you are running, plus General. Written only by the `review-memory` skill; everything else
goes to [INBOX.md](INBOX.md) first.

Entry format, two lines, plus a third `Mechanism: #<issue>` while a lint rule or test is pending:

```
- YYYY-MM-DD (#PR, #PR) <the rule, one sentence>
  Evidence: <what happened without it, one sentence>
```

Caps: 10 entries per section, 40 in total. Over the cap, the next review merges or drops.

## General

## architecture

## implement-issue

- 2026-09-28 (#116, #118, #120) Write every doc comment, help line, changelog line and skill doc about a computed value (cursor, count, truncated preview) from the function that computes it, with one worked example, never from memory of the API.
  Evidence: docs for `since()` cursors, the `dropped` count and `--payload-max-bytes` each described the value wrongly and cost one to two extra review rounds per PR.
- 2026-09-28 (#111, #120) When adding, renaming or removing a CLI command or flag, grep the bare words repo-wide (multiline too, including `playground:appduct -- ...` forms) and update and test every printed hint that names the command, such as the `events since` resume hint.
  Evidence: a removed flag survived in an output hint on #111 and the resume hint dropped the new `--name`/`--payload-max-bytes` flags on #120, costing four review rounds between them.
- 2026-09-28 (#117) Match user-supplied wildcard patterns in the daemon without building a regex (split on `*` and `indexOf` each piece, as `daemon/event-bus.ts` does), and add a many-star timing test with the red tests.
  Evidence: a `.*`-per-star regex backtracked exponentially and could block the single-threaded daemon; caught only in review.
  Mechanism: #132
- 2026-10-05 (#119, #140) When a change moves a call onto its own resource or adds a deliberate close, list everything the existing path did for free or emitted (close on shutdown, error typing, `error` events) and write a red test for each, including `close()` with no tick before it and an open that rejects.
  Evidence: #119 broke `close()` three ways and hit the fix-loop limit; #140 fired the app's error listener on every app switch.
- 2026-10-05 (#145, #146) When an SDK sends a snapshot on ack, route everything sent around it through one ordered queue and test a declaration made from a listener and from another thread during ack handling; run a fixture that pins frame order 25 times before committing.
  Evidence: Swift deltas overtook the snapshot (flaked 9 in 25) and a Kotlin delta sent before the snapshot was erased on the daemon.
- 2026-10-05 (#108, #143) When a lint rule, fixture or command mirrors an existing one, start from every case of the nearest existing one (vector classes, renderer cases such as an empty page with total > 0) and write a red test per spelling of the pattern; add a non-BMP vector for any length limit.
  Evidence: the no-tls-bypass rule missed `vi.stubEnv` and `globalAgent.options` forms, the events fixture lacked vectors tools had, and `events ls` printed "No events declared." past the last page; each cost a review round.

## review-pr

## triage-issue

## design-feature

## file-issue

## e2e-device

## writing-user-docs

## writing-changelog

## cut-release

## work-issue

- 2026-09-28 (#100, #111, #117, #118, #120) Before delegating anything, check for a simulator (`xcrun simctl`, or an Android emulator with KVM); if there is none, ask the human up front to run `e2e-device` locally instead of discovering it at the E2E phase.
  Evidence: five PRs in a row ended with E2E blocked because the cloud Linux container has no simulator.
