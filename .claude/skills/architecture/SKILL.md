---
name: architecture
description: How code in this repo is structured - modules with a public API, calls for immediate effects and bus events for side effects, ports and adapters for everything outside the process, and the simplification checklist. Load before designing or writing any non-trivial code, and when reviewing for structure.
---

# Architecture rules

The compressed version is in `AGENTS.md`. This file is the reasoning and the examples, so
you can apply the rules to a case they do not name.

Read the `architecture` section of `.agents/memory/LESSONS.md` before starting, plus General.

## Modules

A module is a directory. Its `index.ts` exports the public API; everything else in the
directory is internal. Nothing outside the directory imports a non-index file. Lint enforces
this (`appduct/module-boundary` in the root `eslint.config.mjs`) for every directory that has
an `index.ts`, so adding one is what turns a directory into a module.

Design the public API before the internals. Ask what the caller needs to know to use the
module correctly; that and nothing more goes in `index.ts`. If two modules need each other's
internals, they are one module or the boundary is in the wrong place.

## Calls and events

Two ways for modules to interact. Pick by who needs the result.

- **The caller needs the result now**: call the other module's public API. `sessions.claim(link)`
  returns the session or throws. The caller depends on the callee.
- **Something happened and others may care**: emit a domain event on the event bus
  (`packages/appduct/src/daemon/event-bus.ts`). `session_claimed` is emitted; audit, the CLI
  event stream and the MCP server each subscribe. The emitter does not import the listeners
  and does not break if none exist.

Rules that follow: a module never emits an event and then waits for a listener to do
something it needs. An event carries facts about what happened, past tense, not instructions.
If you find yourself emitting `should_write_audit`, that is a call.

## Ports and adapters

"Outside the process" means: filesystem, child processes, network (sockets, TLS, HTTP),
clock and timers, environment variables, randomness, and the OS (home directory, platform).
Anything the process cannot make deterministic.

Each such dependency is a **port**: a small interface owned by the module that needs it,
named for the capability, not the technology.

```ts
// packages/appduct/src/daemon/state-dir/ports.ts
export type Filesystem = {
  readFile(path: string): Promise<string | undefined>;
  writeFile(path: string, contents: string, mode?: number): Promise<void>;
  ensureDir(path: string, mode?: number): Promise<void>;
};
```

Each port ships two **adapters**, side by side in source, never under `__tests__`:

- `node-filesystem.ts`: wraps `node:fs`. Lint allows Node I/O imports only in files named
  `node-*.ts`, in the composition roots, and in tests; everything else is an error.
- `memory-filesystem.ts`: an in-memory fake with the same interface, plus whatever a test
  needs to inspect it (`files()`, `modes()`). Tests across the repo reuse it.

Modules receive ports as constructor or factory arguments. Only a **composition root**
constructs real adapters: the CLI entry (`packages/appduct/src/cli/...`) and the daemon entry
(`packages/appduct/src/daemon/daemon.ts`). Nothing else writes `new NodeFilesystem()`.

Why this matters here: tests then never touch the real home directory, the real socket path
or the real clock, and a test that needs to mock I/O is the signal that a port is missing.
`vi.mock` of `node:*` or of a repo module is banned for that reason.

Existing code predates this rule; the files that still import Node I/O directly are listed
in `eslint.config.mjs` under `LEGACY_NODE_IO`, with the three module-mocking tests under
`LEGACY_VI_MOCK`. Convert a file when you substantively touch it and remove it from the list
in the same PR. Never add to the lists. Do not open a PR whose only purpose is converting
files you were not otherwise changing.

There is already a `Clock` type in `packages/appduct/src/cli/types.ts` and several `*Deps`
types in `packages/appduct/src/mcp/`. Extend those rather than inventing parallel ones.

## Native code (Swift and Kotlin)

Same rules, different spelling:

- **Module** is a Swift target or a Kotlin package. The public API is what is `public`;
  everything else is `internal` and nothing outside reaches it. No `@testable import` to get
  at internals; test through the public surface.
- **Ports** are a `protocol` or `interface` named for the capability (`Clock`, `Transport`,
  `KeyStore`). The real adapter and the in-memory fake sit next to each other in source, not
  under the test target, so every test can reuse the fake. The `Real/` directories under
  `packages/native/ios/Sources/AppductCore` are where real adapters live today.
- **Side effects** flow through the existing callback and event surface the core already
  exposes to the SDK entry points; a component never reads or writes another component's
  state directly.
- **Shared behaviour** between the three SDKs is specified once, in
  `packages/native/fixtures`. A change to a wire or descriptor shape updates the fixture
  first, then each SDK until its conformance test is green.

## Simplification checklist

Run this against your own diff before opening a PR. The review-pr skill runs it too, and a
miss is a should-fix finding, not a nit.

- **Two callers.** An abstraction (helper, base class, generic, shared type) needs two concrete
  callers in the tree or in this PR. One caller: inline it.
- **Impossible states.** No branch for a state the types or an invariant already exclude. If
  it cannot happen, assert and throw with a message; do not handle it.
- **Single-value knobs.** No option, flag or parameter that every caller passes the same value
  to. Hard-code it.
- **Speculative surface.** No interface with one implementation, no plugin hook nobody calls,
  no generic parameter that is always the same type, no "for later" export.
- **Delete before generalise.** If an existing abstraction makes the change awkward, removing
  the abstraction is usually the fix.
- **Size sanity.** Implementation over roughly three times the size of the tests it satisfies
  needs a sentence in the PR saying why.

## Before you open the PR

- Every new directory has an `index.ts` and nothing outside it imports past that.
- Every new reach outside the process goes through a port with both adapters.
- Each item in the checklist above is either satisfied or explained in the PR.
- Public API changes that alter behaviour are reflected in `docs/ARCHITECTURE.md` when that
  document describes the surface you changed.
