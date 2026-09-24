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

- 2026-09-24 (#99) A daemon integration test trusts the daemon's certificate with `ca: daemon.tls.current().certPem` and never disables TLS verification, even where older tests do.
  Evidence: copying `NODE_TLS_REJECT_UNAUTHORIZED=0` and `rejectUnauthorized: false` from older tests raised two high CodeQL alerts and cost a review round.
  Mechanism: #104

## review-pr

## triage-issue

## design-feature

## file-issue

## e2e-device

## writing-user-docs

## writing-changelog

## cut-release

## work-issue
