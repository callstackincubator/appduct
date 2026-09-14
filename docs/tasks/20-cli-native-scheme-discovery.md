# 20 — `cordierite init` and scheme discovery for plain iOS/Android apps

**Depends on nothing in this directory. Parallel siblings (Phase 3 of issue #48) own
`packages/native/**` and `packages/react-native/**`; this task owns only
`packages/cordierite/**` and this file.**

## Goal

Issue #48's Phase 3 bullet: *"`cordierite init` / scheme discovery: read `CFBundleURLTypes`
from an Xcode project's Info.plist and the `cordieriteScheme` placeholder from a Gradle
project, alongside today's `app.json` step."* Before this task, `resolveScheme`'s last step
(`scheme.ts`) was a single check — `<cwd>/app.json`'s `expo.scheme` — with no static-file path
for a plain (non-Expo) native app to declare its deep-link scheme at all. A bare-RN or fully
native iOS/Android app had to fall back to `--scheme`, `CORDIERITE_SCHEME`, or a hand-written
`.cordierite/config.json` for every single command.

This task extends that one step into four more probes, all still static-file reads, all
reported in `resolveScheme`'s `tried` list, and all shared verbatim by `cordierite init`.

## What is probed, and in what order

`scheme.ts`'s step 5 (`discoverStaticProjectScheme`) tries, first match wins:

1. `<cwd>/app.json`'s `expo.scheme` — unchanged from before this task.
2. **`android-gradle`**: `app/build.gradle.kts`, then `app/build.gradle`, for a
   `manifestPlaceholders["cordieriteScheme"] = "…"` (or `manifestPlaceholders.cordieriteScheme =
   "…"`) assignment — a regex match inside the raw file text, not a Gradle evaluation.
3. **`android-manifest`**: `app/src/main/AndroidManifest.xml`, for the first `<data
   android:scheme="…">` inside an `<intent-filter>` that also declares
   `android.intent.action.VIEW`. A `<data>` tag inside a filter for some other action (`MAIN`,
   `SEND`, …) is not a deep-link declaration and is skipped even if it has a scheme attribute.
4. **`ios-info-plist`**: any file literally named `Info.plist`, found by a depth-limited walk
   from the app root (0 = the root itself, 1 = its immediate children, 2 = one level below
   that — "up to two levels deep"), excluding `Pods`, `build`, `node_modules` and
   `DerivedData` directories anywhere on the path. Files are tried nearest-first (ties broken
   alphabetically); each is parsed as an XML plist and the first non-empty
   `CFBundleURLSchemes` entry across every `CFBundleURLTypes` dict wins. A binary-encoded
   plist (Xcode can write either encoding) is detected by its `bplist` magic bytes and treated
   as unreadable — noted in `tried`, not decoded — so discovery falls through to the next
   `Info.plist` (if any) or the next probe, never to a hard failure.
5. **`ios-project-yml`**: `<cwd>/project.yml` (xcodegen), for the same `CFBundleURLSchemes` key
   under `info.properties.CFBundleURLTypes`, read with a regex targeted at that one key rather
   than a general YAML parser.

Every probe, hit or miss, contributes exactly one entry to `tried` — so the "no scheme
anywhere" error (`describeMissingScheme`) always lists all nine locations `resolveScheme` can
consult end to end (flag, env, project-config walk-up, state config, then these five), not just
whichever ones exist on disk.

`cordierite init` (`commands/init.ts`) runs this *exact* function
(`discoverStaticProjectScheme`) for its own discovery, deliberately skipping steps 1-4 of the
full precedence chain (flag/env/project-config walk-up/state-config) for the reasons its doc
comment already gave pre-#48: `init` decides what to *write*, so it must never bake an ambient
value into a committed file. Sharing the function means `init` and `resolveScheme` can never
disagree about what "discovery" means for a plain native app, the same guarantee they already
had for `app.json`.

## Why no project code is ever executed

Every new probe is a plain `fs.readFile` of a well-known file, parsed defensively, exactly like
the pre-existing `app.json` step and `artifact-inspect.ts`'s `doctor` reads:

- No `xcodebuild`, no `plutil -convert`, no invocation of any Xcode or Gradle tooling. A binary
  plist is *reported* as unreadable, not converted — running `plutil` against project state is
  exactly the "execute project code to read one string" risk `scheme.ts`'s doc comment already
  rules out for `app.config.js`/`app.config.ts`, and a native project's build tooling is no
  different in kind.
- No Gradle evaluation. `build.gradle(.kts)` is read as text and matched with a regex for the
  one assignment shape issue #48 sketches; a project that computes the placeholder value
  dynamically (string interpolation, a Gradle property, …) is not read — it falls through to
  the next probe or to `--scheme`, the same way a dynamic `app.config.js` already did.
- No XML/YAML library dependency was added. `native-scheme.ts` includes:
  - A small tolerant XML-plist tokenizer (tag stream → tree → typed value), deliberately not a
    validating XML parser — no DTD resolution, no namespaces, no attribute parsing beyond
    stripping them. It is forgiving of the ways a hand-written or generated `Info.plist` can
    still deviate slightly (a stray unescaped `&`, mismatched nesting): being tolerant here
    matters more than rejecting a technically-invalid document, since a rejection would just
    push the user to `--scheme` anyway with no benefit gained from the strictness.
  - A regex-only reader for `project.yml`'s one key of interest, not a YAML engine — the
    `CFBundleURLTypes`/`CFBundleURLSchemes` shape in xcodegen's manifest is identical to the
    plist one, so the only thing worth parsing generically would be the surrounding YAML
    structure, which this feature has no other use for.
- Every read is capped at 2 MiB and every directory walk is capped in depth (two levels) and
  entry count (5 000), so a pathological project tree degrades to "probe skipped, tried moves
  on" rather than an unbounded scan or an out-of-memory read.

## The disagreement rule

If two probes resolve to *different* schemes — the example issue #48-adjacent discussion
raised: a monorepo whose Android manifest says `myapp` and whose iOS `Info.plist` says
`otherapp` — discovery refuses to guess. It throws a usage error naming every conflicting
source (file + value), telling the caller to pass `--scheme` explicitly. This applies across
all four native probes (not just Android-vs-iOS): if, say, `build.gradle.kts`'s placeholder and
`AndroidManifest.xml`'s intent filter disagree with each other, that is caught too. Two probes
that *agree* are not a conflict — the earliest one in the order above is what `source`/`origin`
report, purely for attribution, since there is nothing to resolve.

`app.json` sits outside this check: it is still the unconditional first sub-step, and a match
there short-circuits before any native probe runs at all (unchanged from pre-#48 — `app.json`
"wins" the same way it always did, never adjudicated against the native probes).

## Deviations from the issue's sketch

- The issue's Phase 3 sketch shows only the bracket form,
  `manifestPlaceholders["cordieriteScheme"] = "myapp"`, for the Gradle placeholder. The
  property form, `manifestPlaceholders.cordieriteScheme = "myapp"`, is accepted too — it is
  common enough in real `build.gradle.kts` files that only supporting the bracket form would
  be a needless gap for the Kotlin DSL specifically.
- "`*.xcodeproj/../Info.plist`" from the issue's phrasing (the `Info.plist` sitting next to an
  `.xcodeproj` bundle) is not special-cased as its own lookup. It is already covered by the
  general depth-limited walk — an `.xcodeproj`'s sibling `Info.plist` is at most two directory
  levels from a typical app root — so a second, xcodeproj-aware lookup would be redundant.
- `CFBundleURLTypes` is an array of dicts; the first dict that actually declares a non-empty
  `CFBundleURLSchemes` wins, not strictly the first dict in the array. An app can legitimately
  register more than one `CFBundleURLTypes` entry (a custom scheme plus a universal-link-only
  entry with no `CFBundleURLSchemes` at all), and skipping straight to "no scheme found" on the
  first miss would be wrong.
- The five-thousand-entry defensive cap on the `Info.plist` walk is not covered by its own test
  (constructing a tree that large in a unit test is not worth the runtime cost for a
  belt-and-suspenders limit); the depth cap and the per-file size cap — the limits actually
  reachable by a realistic project — are.

## Where this lives

- `packages/cordierite/src/native-scheme.ts` — the four probes, the tolerant plist parser, the
  directory walk, and `discoverNativeScheme`'s disagreement check.
- `packages/cordierite/src/scheme.ts` — `discoverStaticProjectScheme`, the shared step-5
  implementation `resolveScheme` and `cordierite init` both call; `SchemeSource` gained the
  four new tags.
- `packages/cordierite/src/commands/init.ts` — switched from calling `discoverExpoScheme`
  directly to `discoverStaticProjectScheme`; `InitCommandData` gained `origin` and the four new
  `source` values.
- `packages/cordierite/src/output.ts` — `cordierite init`'s human output gained a "Read from"
  field and a "Scheme … was read from …" hint in `Next`, present only when the scheme came from
  a discovery tier rather than `--scheme`/an already-recorded value.
- Tests: `packages/cordierite/src/__tests__/native-scheme.test.ts` (the four probes in
  isolation — table-driven per probe, the depth/size limits, binary-plist handling, the
  disagreement error) and the "native project discovery" cases added to
  `packages/cordierite/src/__tests__/init.integration.test.ts`; the pre-existing
  `scheme.test.ts`/`scheme-discovery.integration.test.ts` cover the resolver-level precedence
  unchanged.

## Acceptance

- `pnpm --filter cordierite build && pnpm --filter cordierite test && pnpm --filter cordierite typecheck`
  all pass.
- A plain Xcode app (an `Info.plist` with `CFBundleURLTypes`, no `app.json`) and a plain Gradle
  app (a `cordieriteScheme` placeholder, no `app.json`) each resolve a scheme with zero
  additional configuration, matching the Expo `app.json` zero-config path issue #29 shipped.
- Nothing under `packages/native/**`, `packages/react-native/**` or `playground*/**` changed —
  this task is CLI-only, per Phase 3's split across parallel PRs.
