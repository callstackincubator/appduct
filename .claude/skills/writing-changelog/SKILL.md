---
name: writing-changelog
description: How to write a CHANGELOG.md entry - one bullet per change, one or two sentences, about what the user notices and never about how it was built. Load before adding or amending anything under Unreleased in CHANGELOG.md, before reviewing a diff that touches it, and before turning Unreleased into release notes.
---

# Changelog entries

Read the `writing-changelog` section of `.agents/memory/LESSONS.md` before starting, plus General.

The changelog is read by someone deciding whether an upgrade affects them. They scan it. They
are not implementing Appduct and they are not reading it to learn how a feature works; the
docs do that. The `writing-user-docs` voice and scope rules apply here unchanged; this skill
adds the form.

## Shape

One bullet per change, under `## Unreleased`:

```
- **<Kind>: <what the user notices>.** <At most one more sentence.>
```

- **Kind** is `New`, `Fix`, `Changed`, `Removed` or `Breaking`. `Breaking` is anything a user
  must act on to upgrade; the `cut-release` skill reads `Breaking` and `New` to pick the version
  bump, so the kind must be right. Docs-only changes are `Docs`.
- **The bold part is the whole change from the outside**: the command, flag, option, API,
  MCP tool, error or behaviour the user meets, and what it does now. Name it exactly as the
  user types or sees it.
- **The second sentence** is for the one thing they would trip on without it: a type or
  option that was renamed, a default that moved, something they need to change on upgrade.
  Or a link to the docs page that explains the feature. If there is nothing like that, stop
  at the bold part.
- **Two sentences is the cap.** If a change needs more, the rest belongs in the docs and the
  entry links there. A big feature gets one entry that says what you can now do and where to
  read about it, not a restatement of the docs.

An entry never contains: a function, class, module or file name from the implementation,
which process or component did what, why the bug happened, what the fix touched, the type
that changed unless the user writes code against it, or the PR that shipped it.

## Test

Cover the bold part and ask: would a user of the CLI, the MCP server or one of the SDKs
notice this? If not, the change is not user-visible and gets no entry. Then cover everything
after the colon and ask of each word: does a user need it to decide whether to upgrade or to
upgrade safely? Cut every word that fails.

## Examples

Leaked:

```
- **Fix: the first Appduct command on a clean machine no longer fails with a bare `ENOENT`.**
  Nothing created the state directory before the auto-spawn path wrote into it: `~/.appduct` is
  created by `startDaemon`, but the spawn-lock and `daemon.log`'s fd are opened by the *parent*
  process, before the daemon it spawns exists. So with no `~/.appduct` yet, every command that
  auto-spawns a daemon failed with `ENOENT: ... open '~/.appduct/daemon.spawn.lock'` until
  someone ran `appduct daemon run` in the foreground once. The auto-spawn path now creates the
  directory (mode `0700`, same as the daemon would) before taking the lock.
```

Clean:

```
- **Fix: the first `appduct` command on a clean machine no longer fails with `ENOENT`.**
  Commands that start the daemon for you now create `~/.appduct` themselves.
```

A feature:

```
- **New: tool groups.** A tool can declare a `group` such as `"cart"` or `"checkout/payment"`,
  and `appduct tools --group <name>` and `appduct_list_tools` list one group; see
  `docs/TOOLS.md`.
```

## Before you commit

1. Read only the bold parts down the section. Each one is a complete, true sentence on its own.
2. Every word after each colon passes the test above.
3. No entry is longer than two sentences.
4. Nothing under `Unreleased` describes a change a user could not notice.
