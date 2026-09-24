# Working in this repository

Appduct lets a terminal, a test runner or an agent call functions inside a running app. Read
[README.md](README.md) for what it does and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how
the daemon, CLI, MCP server and SDKs fit together.

## Map

| Path | What it is |
| --- | --- |
| `packages/appduct` | CLI, daemon, MCP server, `appduct/client` (TypeScript) |
| `packages/shared` | Wire protocol and domain types shared by CLI and SDK |
| `packages/react-native` | React Native SDK, Expo config plugin, Metro helper |
| `packages/native` | Framework-free iOS (Swift) and Android (Kotlin) core |
| `playground`, `playground-native` | Expo app and native apps registering the same five demo tools |
| `skills/appduct` | The skill shipped to Appduct users; not for working on this repo |
| `.agents/` | Agent resources: `memory/` (curated `LESSONS.md` read by section, raw `INBOX.md` write-only), `scripts/` (worktree create and remove, also wired as Claude Code hooks) |
| `docs/` | Architecture, protocol, security, tools; `docs/tasks` is a historical design record |

## Commands

Run from the repo root. Node 24, pnpm 11 via corepack.

```bash
pnpm install --frozen-lockfile   # once
pnpm build                       # turbo; tests depend on it
pnpm test                        # vitest, all packages
pnpm lint && pnpm typecheck
pnpm --filter appduct test -- src/__tests__/<file>   # one file
pnpm playground:appduct -- <cli args>                # this repo's CLI, from the playground
.agents/scripts/worktree.sh <branch>                 # worktree with node_modules cloned copy-on-write, ~10 s;
                                                     # Claude Code's worktree hooks call it and worktree-remove.sh
```

## Rules

1. **Modules.** A module is a directory whose `index.ts` is the only thing imported from
   outside it. Immediate effects are calls on a module's public API. Side effects other modules
   react to are events on the event bus; the emitter never knows who listens.
2. **Ports.** Anything outside the process (filesystem, child processes, network, clock, env,
   randomness, OS) is reached through a port: a small interface named for the capability, with
   a real adapter and an in-memory fake beside it. Real adapters are constructed only in a
   composition root (a CLI or daemon entry point). Module mocking (`vi.mock`) is banned.
3. **Simplest thing.** No abstraction with fewer than two callers, no handling of states the
   types exclude, no option that only one value ever uses, no interface with one implementation,
   no extension point nobody calls. Delete before you generalise.
4. **Tests observe public behaviour only**: return values, errors, emitted events, port fake
   state, CLI output. Never internals. Names read as the spec: `it("rejects a link older than five minutes")`.
5. **Tests first.** Acceptance criteria from the issue, red tests committed before any
   implementation, checkpoint commits that each lower the failing count.
6. **Changelog.** Every PR with a user-visible change adds or amends a line under
   `## Unreleased` in [CHANGELOG.md](CHANGELOG.md), written with the `writing-changelog` skill.
7. **Branches** are `issue-<N>-<slug>`, derived from the issue (see the implement-issue skill).
   PRs reference the issue and follow the PR template.
8. **Nothing irreversible without a human**: no force push, no `gh pr merge`, no release, no
   `npm publish`, no deleting branches other than your own. One exception: the review-memory
   skill merges its own PR when it touches nothing outside `.agents/memory/`.
9. **Memory.** Before a task, read the section of [.agents/memory/LESSONS.md](.agents/memory/LESSONS.md)
   named after your skill, plus General. Never read `INBOX.md`; only append to it, and only
   through the work-issue friction gate.

## Writing

Applies to reports, PR descriptions, issue comments and commit messages. Lead with the
outcome. Plain everyday English, colleague to colleague. Say only what bears on the matter at
hand; skip what you checked and found fine unless it changes a decision. No filler, no hedging,
no restating the question. Commit subjects: conventional prefix, imperative, under 72 chars.

## Skills

Load the skill before starting the matching task. They live in `.claude/skills/`.
Model and Forked mirror each skill's `model:` and `context: fork` frontmatter, and
`pnpm check:skills` fails CI when they drift. A forked skill runs in its own subagent on its
model however it is started, and sees only the arguments it was invoked with.

| Task | Skill | Model | Forked |
| --- | --- | --- | --- |
| Designing or writing any non-trivial code | `architecture` | none | no |
| Implementing an issue (tests first, draft PR, checkpoints) | `implement-issue` | sonnet | yes |
| Reviewing a PR or branch | `review-pr` | opus | yes |
| Investigating a bug report | `triage-issue` | opus | yes |
| Designing a feature too big for one PR, or sizing one | `design-feature` | opus | yes |
| Turning a request or a found bug into an issue (interviews first) | `file-issue` | sonnet | no |
| Running the app on a simulator and driving it through the CLI | `e2e-device` | sonnet | yes |
| Writing or editing anything an Appduct user reads: READMEs, `docs/`, website, the shipped skill, CLI help, error messages | `writing-user-docs` | none | no |
| Adding, amending or reviewing an entry in `CHANGELOG.md` | `writing-changelog` | none | no |
| Cutting a release | `cut-release` | sonnet | no |
| Curating agent memory (weekly, or when the inbox has notes) | `review-memory` | opus | yes |
| Taking an issue from `status:ready` to a reviewed, tested PR | `work-issue` (orchestrator) | none | no |
| Driving an Appduct-enabled app as a user of Appduct | `appduct` (in `skills/`) | none | no |
