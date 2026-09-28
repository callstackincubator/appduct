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
