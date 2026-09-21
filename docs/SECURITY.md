# Security model

One page: what pinning defends against, what it doesn't, how to configure trust, how to
handle keys, and what production deployments should turn on. See
[`PROTOCOL.md`](PROTOCOL.md) for wire-level detail,
[`ARCHITECTURE.md`](ARCHITECTURE.md#12-policy--audit) for the policy/audit implementation,
and [`BUILD-VARIANTS.md`](BUILD-VARIANTS.md) for whether Appduct's code ships in a given
build at all.

**In one line:** TLS is required for the Appduct socket, and pins are SHA-256 over SPKI
(`sha256/...`), so only *your* host keys match.

## Threat model

**What Appduct defends against:**

- An attacker on the same Wi-Fi/LAN who can see or intercept traffic — the socket is
  `wss://` (TLS), not cleartext.
- An attacker who controls DNS, ARP, or IP routing on the network — the app authenticates
  the daemon by its certificate's SPKI hash (`sha256/...`), not by address or hostname.
  Being able to answer on the right IP is not enough to impersonate the daemon.
- An attacker who intercepts or replays a deep link — the link is bootstrap data for one
  short-lived, single-use session token, not a credential. A captured link is useless
  once its TTL elapses or its token is consumed, and 5 failed claim attempts against a
  session id burn the link outright.
- An unauthenticated local process on the same machine that isn't the operator — the
  control plane is a Unix domain socket under `~/.appduct/` at mode `0600`, inside a
  `0700` directory; anything that can't read that socket can't talk to the daemon.

**What Appduct does not defend against:**

- **A compromised operator machine.** Anything that can read `key.pem` or connect to
  `daemon.sock` has full control: it can mint links, list/invoke tools on any connected
  device, and read the audit log. The trust boundary is the operator's machine, full
  stop — see "The localhost/UDS trust boundary" below.
- **A malicious or compromised app build.** Appduct constrains what an *external*
  caller can do to the app; it assumes the app's own code (and thus whatever tools it
  chooses to register) is trusted. A tool with `destructiveHint` still executes whatever
  its handler does — policy can deny the *call*, not audit the handler's internals.
- **Key compromise.** The pinned key doubles as both the trust anchor and the TLS
  identity. If `key.pem` leaks, an attacker with network access to a claimed or
  claimable session can impersonate the daemon until every app build with the old pin is
  retired. Rotation (below) is the mitigation, not prevention.
- **Anonymous internet exposure without policy.** Appduct does not by itself decide
  whether exposing the `wss://` port to the internet is a good idea for your app; that
  decision is yours, and if you make it, policy + audit (below) are not optional.

## Trust modes

What a build trusts is decided by an explicit `trust` config value — `"pin"` or `"link"` —
never by whether the build happens to be debuggable. There is no build-type signal anywhere
in this resolution on either platform.

**`trust: "pin"`** is everything described above: the app embeds a key fingerprint set
(`cliPins`) ahead of time and refuses anything else. Requires non-empty `cliPins`; the config
plugin rejects `trust: "pin"` with empty/missing `cliPins` at prebuild time, and the native
trust-resolution logic (`resolveTrustedPins` on both platforms) rejects the same combination
again if that check is ever bypassed by hand-editing native config.

**`trust: "link"`** — the default whenever `cliPins` is absent, and available in **any**
build type, not just a locally-run debug build — is a deliberately weaker flow so that a
fresh clone of this repo (or a fresh app project) works with zero setup:

- The daemon auto-generates `key.pem` the first time it starts if the file is missing, and
  prints its `sha256/...` fingerprint.
- `appduct link` composes that fingerprint into the deep link as a separate `pin` query
  param, alongside the existing binary `appduct` bootstrap payload. The binary payload
  format is unchanged — an app build that doesn't know about `pin` simply ignores it.
- The native client trusts that link-carried pin, for that one link's session only, when the
  effective trust mode is `"link"` (explicit, or the default because no `cliPins` are
  configured) and the connect options actually carry a `linkPin`. It then logs,
  unconditionally (not gated behind any log level):

  ```
  Appduct: trust=link — trusting the SPKI pin carried by the bootstrap link for this session.
  ```

- The moment `cliPins` is configured, that embedded set always wins regardless of `trust`'s
  value, and the link's `pin` is ignored outright — config can only *narrow* trust, never
  widen it back to link TOFU.
- **A `trust` value that is neither `"link"` nor `"pin"`** — a typo like `"PIN"` or a
  hand-edited native config — is a hard error, both at config/prebuild time and independently
  in the native trust-resolution logic, deliberately: it must never be treated as the
  missing-key default, which would let a mistyped `trust` silently widen an intended `"pin"`
  configuration into permissive link TOFU.

**What changed vs. pinned trust:** the trust anchor moves from "a key you baked into the
binary ahead of time" to "whoever handed you this link" — the same class of trust a
`ssh <host>` on first connect or an unauthenticated `npm install <package>` extends to
whoever controls that name at the moment you run it. It is intentionally weaker, which is
why production and internal-distribution deployments should configure `cliPins` (which flips
the effective trust mode to `"pin"` automatically) rather than relying on the default.

**Residual risk:** an attacker already on the operator's private LAN who can get someone to
open a malicious bootstrap link or scan a malicious QR code on a build with no embedded pins
can stand in for a legitimate daemon for that one session — the same link-replay and
short-lived-token protections in the main threat model still apply (a captured link is
useless once its TTL elapses or its token is consumed), but there is no embedded key to
check the link's claimed identity against. This is a materially smaller blast radius than no
pinning at all (still requires LAN presence, still requires a social-engineering step, still
bounded by the link's TTL), but it is not equivalent to pinned trust — do not leave a
production or internal-distribution build without `cliPins` for anything beyond local
development.

A delivered bootstrap link also *supersedes* a session the app is already holding, rather than
being ignored while one is active: a link is a deliberate, local act by the operator and
outranks a session the app happens to be sitting on. Within the residual risk above, that means
such a link can interrupt a legitimate session as well as stand in for a daemon — an
availability effect, bounded the same way. It is not a cheap one: the payload is parsed and
validated in full, against the same address policy and expiry, *before* anything is torn down,
so a malformed or expired link costs the existing session nothing.

**What actually contains link trust now, since there is no build-type gate:** it is opt-in
configuration alone. Set `cliPins` (which makes `trust: "pin"` the default) on any build you
don't want accepting a link-carried pin. Separately, if you don't want Appduct's native
code present in a build at all — regardless of trust mode — exclude it from autolinking (see
[Compiling Appduct out of production
builds](BUILD-VARIANTS.md#compiling-appduct-out-of-production-builds)); `appduct doctor`
verifies that exclusion actually took effect in a built artifact, rather than trusting the
config that was supposed to produce it.

## Configuring trust

Nothing here is required for a zero-config app: with no pins configured, `trust: "link"`
is the default and the flow above just works — in any build type. Configure the values
below when you want a build to trust only keys you embedded ahead of time.

Generate the pin with `appduct keygen`, which prints the exact `sha256/...` fingerprint
value to use. After changing any of this, run your normal prebuild / rebuild flow so
native config receives the values.

### Expo

Add the **`@appduct/react-native`** config plugin to Expo config:

```json
{
  "expo": {
    "scheme": "myapp",
    "plugins": [
      [
        "@appduct/react-native",
        {
          "cliPins": ["sha256/REPLACE_WITH_KEYGEN_OUTPUT"],
          "trust": "pin",
          "allowPrivateLanOnly": true,
          "deepLinkScheme": "myapp"
        }
      ]
    ]
  }
}
```

| Option | Required? | Meaning |
| --- | --- | --- |
| `cliPins` | Optional in general; **required** — non-empty, each a `sha256/` + 44-character base64 SPKI pin — whenever `trust: "pin"` is set or implied by `cliPins` being non-empty. The plugin throws naming the offending value. | The pin set this build trusts |
| `trust` | Optional | `"link"` \| `"pin"`, defaulted as described under [Trust modes](#trust-modes). Any other value is a config-time error |
| `allowPrivateLanOnly` | Optional, defaults to `true` (fail-closed) | Bootstrap must target a local IPv4 address |
| `deepLinkScheme` | Optional | Warns at prebuild time if it isn't declared in `expo.scheme` |

Leave `cliPins`/`trust` unset entirely if you're fine with link-per-session trust — it's
the default, and a plain zero-config setup can skip this whole plugin entry.

### Bare React Native — native keys

Autolink the module and set the equivalent native keys. Field names and semantics mirror
the Expo plugin (see
[`app.plugin.js`](../packages/react-native/app.plugin.js)).

iOS `Info.plist`:

| Key | Purpose |
| --- | ------- |
| `AppductCliPins` | String array of `sha256/...` SPKI pins |
| `AppductTrust` | `"link"` \| `"pin"` — any other value is a hard error at connect time |
| `AppductAllowPrivateLanOnly` | Boolean; if true, bootstrap host must be a local IPv4 address |

Android `<application>` meta-data:

| Name | Purpose |
| --- | ------- |
| `com.callstack.appduct.CLI_PINS` | JSON array string of pin values |
| `com.callstack.appduct.TRUST` | `"link"` \| `"pin"` — any other value is a hard error at connect time |
| `com.callstack.appduct.ALLOW_PRIVATE_LAN_ONLY` | Boolean meta-data value (a `"true"`/`"false"` String is also accepted); defaults to `true` (fail-closed) when absent |

Wire **deep links** so the OS can open your app with the host's bootstrap URL, and make
sure the app scheme matches the one `appduct link` (or the `deepLinkScheme` plugin
option, or `config.json`) uses to compose that link.

### Plain native apps (no React Native)

A plain iOS app consuming `packages/native` directly (`Appduct.shared`) sets the exact same
three `Info.plist` keys — `AppductCliPins`, `AppductTrust`, `AppductAllowPrivateLanOnly`
— read from the same table above, since both `@appduct/react-native`'s bridge and the plain-app
facade resolve trust through the same native `resolveTrustedPins` logic. See
[`packages/native/ios/README.md`](../packages/native/ios/README.md#hardened-builds) for the
worked example and `Appduct.shared.buildConfig`, the plain-app equivalent of
`getAppductBuildConfig()`.

A plain Android app consuming `packages/native` directly (the `Appduct` object) sets the same
`<application>` meta-data keys — `com.callstack.appduct.CLI_PINS`, `.TRUST`,
`.ALLOW_PRIVATE_LAN_ONLY` — from the table above, read by the same `resolveTrustedPins`-equivalent
logic the RN bridge's `connect()` uses. See
[`packages/native/android/README.md`](../packages/native/android/README.md#5-hardened-builds) for
the worked example and `Appduct.buildConfig`.

### `allowPrivateLanOnly`

When enabled, bootstrap must target a **local IPv4** address — RFC1918 private ranges or
`127.0.0.1`. It is a **dev-hardening** switch, not a claim that Appduct is LAN-only.

There is nothing to configure for this in JS: which addresses a bootstrap link may point
at is native build config, enforced by native `connect()` and read from the same place by
the deep-link handler. JS can only ever narrow what native allows, never widen it.

### `trust: "pin"` needs pins

`trust: "pin"` requires non-empty `cliPins` (bare RN: `AppductTrust`/`TRUST` set to
`"pin"` **and** `AppductCliPins`/`CLI_PINS` non-empty). A build that only ever trusts
embedded pins but has none configured would have no way to trust anything, so the plugin
refuses that combination at config time, and the native readers refuse it again if that
check is ever bypassed by hand.

### Reading the effective configuration at runtime

**`getAppductBuildConfig()`** reports the effective trust configuration a running build
actually has — `{ trust, hasEmbeddedPins, allowPrivateLanOnly }`. It is read via
`getConstants()` from the exact same native manifest/plist parse `connect()`'s
`resolveTrustedPins` uses, never a second parse path, so it can never disagree with what a
real connect attempt would do.

`trust` reports the *effective* bucket — `"pin"` whenever embedded pins are present, since
they always win; `"link"` otherwise — not the raw config string. On `/noop` it reports the
documented absent shape: `{ trust: "absent", hasEmbeddedPins: false, allowPrivateLanOnly: true }`.
Pin fingerprints themselves are never exposed, only whether any are embedded.

## What a build without the native module does

With the native module absent — excluded via autolinking, Expo Go, or a
debug-tooling-free JS-only environment — every exported function on the root
`@appduct/react-native` entry degrades to the exact `/noop` entry's behavior: one
warning log the first time, no throws, `getAppductState()` reporting `"idle"`, and
`connect()` always rejecting with `AppductDisabledError` (`code: "appduct_disabled"`).

See [`ARCHITECTURE.md`](ARCHITECTURE.md#11-react-native-sdk) §11 for the parity contract
between the two entries, and [`BUILD-VARIANTS.md`](BUILD-VARIANTS.md) for how to produce
such a build deliberately.

## Gating a tool by build variant

Registration is the app-side allowlist, and it is the only control that sits inside the
app's own trust boundary. `useAppductTool` takes a third `options` argument,
`{ enabled?: boolean }` (default `true`).

`enabled: false` never registers the tool, and removing it (or a hook that was already
mounted) leaves no registration behind. Toggling `enabled` at runtime registers and
unregisters cleanly — so put the condition in the argument instead of wrapping the hook
call in an `if`, which is a rules-of-hooks violation:

```ts
useAppductTool(
  {
    name: "wipe-local-db",
    description: "Destructive: clears the local database",
    handler: async () => wipeLocalDb(),
  },
  [],
  { enabled: process.env.EXPO_PUBLIC_APPDUCT_TOOLS === "full" }
);
```

The recommended predicate is an app-owned build flag inlined by the bundler at build time
(`EXPO_PUBLIC_*` env vars, a Babel define plugin, etc.) — something your release pipeline
controls explicitly, like `process.env.EXPO_PUBLIC_APPDUCT_TOOLS === "full"` above.

**`__DEV__` is the wrong default here**, for the same reason a `debuggable` build-type
check is the wrong native gate: `__DEV__` is `false` in *any* release-bundled JS, including
the release-signed, internally-distributed "testing" variant agents actually drive in CI.
Gating a destructive tool on `__DEV__` removes it exactly where it is needed.

`__DEV__` is still fine for tools that are genuinely debug-only — a "dump internal state"
tool with no purpose outside a local dev loop, say. It just shouldn't be the example every
app copies for hardening.

**Consequence for agents and E2E flows:** because registration is the app-side allowlist,
the tool set legitimately differs per build artifact. A CI testing build may expose a
different tool set than a local dev build or a hardened production build. Automated flows
should discover tools (`appduct tools`, or `appduct_list_tools` over MCP) rather than assume
a fixed set is always present.

## Key handling rules

- **Never commit a private key.** `git ls-files "*.pem"` must stay empty in this repo and
  should stay empty in yours. Test suites generate throwaway keys into temp directories
  at runtime; they are never checked in.
- **`key.pem` must be `0600`.** The daemon refuses to load a key file that is
  group- or world-readable — treat that refusal as the system working, not a bug to
  work around by loosening permissions.
- **One key per developer/environment**, not one key shared across a team or checked
  into a shared secrets store that many people can read. `appduct keygen` is cheap;
  run it per machine.
- **Back up the fingerprint, not just the key.** The `sha256/...` value printed by
  `appduct keygen` is what you actually ship in app config (`cliPins`); losing the key
  file just means generating a new one and re-shipping the app, which is the normal
  rotation path anyway.

## Rotation runbook

Both native clients accept a pin *set*, not a single pin — this is what makes rotation
possible without a flag day:

1. Generate a new key: `appduct keygen --out new-key.pem`. Note its printed
   fingerprint (`sha256/NEW...`).
2. Add the new fingerprint to the app's `cliPins` **alongside** the existing one (don't
   remove the old one yet):
   ```json
   "cliPins": ["sha256/OLD...", "sha256/NEW..."]
   ```
3. Ship that app build. Any app on this build now trusts either key, so operators can
   run daemons on either the old or the new key without breaking anyone.
4. Point new/updated daemons at `new-key.pem` (`config.json`'s `keyPath`, or
   `appduct keygen`'s default output).
5. Once every app build in the field has picked up step 2-3's release (track this the
   same way you track any minimum-supported-version rollout), ship a follow-up release
   that drops `sha256/OLD...` from `cliPins` and retires `key.pem`.

Treat this as the standard operating procedure, not an incident-response-only process —
rotating periodically, not just after a suspected compromise, keeps the runbook exercised
and keeps any one key's exposure window bounded.

## Production guidance

Appduct is dev-first but production-capable: the same protocol runs everywhere,
production just turns on the pieces below rather than using a different architecture.

**Policy and audit are operator ergonomics, not a production control.** Both run on the
daemon, which lives on the operator's machine — the trust boundary this document already
names above ("A compromised operator machine"). Anyone who can read `key.pem` or reach
`daemon.sock` controls the daemon directly and is not subject to its own policy config or
audited by its own audit log; policy/audit shape what a *legitimate* CLI/MCP caller talking
to an *honest* daemon can do, they do not defend the app against the operator machine
itself. The control that actually sits inside the app, on the app's side of the trust
boundary, is **which tools the app registers at all** — `useAppductTool`'s `enabled`
option (see [Gating a tool by build variant](#gating-a-tool-by-build-variant)) lets an app conditionally
withhold a destructive tool's registration based on its own release-pipeline-controlled
build flag, independent of whatever the operator machine's daemon policy says. Treat policy
and audit below as convenience for a trusted operator working across many tools/sessions,
not as the mechanism that keeps a destructive tool out of reach of a hostile one.

- **Policy.** Set `config.json`'s `policy.default` / `policy.destructive` (and per-tool
  `policy.tools["<alias>/<name>"]` overrides) to `"deny"` for anything you don't want an
  arbitrary caller invoking against a production build. Every `tools.call` — CLI, MCP, and
  `appduct/client` alike — is evaluated against this before it ever reaches the app;
  a denial returns `policy_denied` and never sends a `tool_call` frame. `"prompt"` requires a human gate
  and fails closed everywhere one can't be guaranteed: today the only implemented gate
  is an MCP client that declares the `elicitation` capability, which receives an
  `elicitation/create` prompt for each call; the CLI and every other client are denied outright
  (`policy_denied`, reason `no_consent_channel`) rather than silently treated as
  `"allow"`. That gate is *not* a defense within this feature's own trust boundary: the
  daemon trusts the MCP server's `consent: "elicitation"` param verbatim rather than
  re-deriving it, so any local process that can reach `daemon.sock` — including the CLI,
  or an agent with shell access, which is the typical Claude Code setup this feature
  targets — could send that param directly, the same way it could send any other RPC
  call. This is consistent with, not an exception to, the trust boundary above: anything
  that can reach the socket already has full daemon control. `"prompt"` guards against a
  compliant MCP client silently auto-approving on the caller's behalf, not against a
  hostile process on the operator's own machine. The prompt reaches whatever the client
  does with elicitations: a client configured to answer them automatically (Claude Code's
  `Elicitation` hook, for example) approves without showing anything, and the daemon cannot
  tell that apart from a person accepting. A client's declared capabilities are
  also self-reported, so it's not a defense against a hostile client that answers the
  prompt itself either — only against a compliant client's own auto-approval. Worth
  knowing rather than filing as a bug: `"prompt"` denies unconditionally in CI or any other
  unattended pipeline (there is no consent channel there at all), so a pipeline that
  needs a tool to run unattended must set `allow`/`deny` for it explicitly. Until a
  non-MCP consent channel ships, `"deny"` remains the only way to hard-block a tool for
  CLI callers.
- **Audit.** Every `tools.call` attempt — regardless of outcome — appends one line to
  `audit/<YYYY-MM-DD>.jsonl`: timestamp, session, alias, tool name, a sha256 of the
  canonicalized args (never the raw args), outcome, error type if any, duration, caller
  (`cli`/`mcp`/`client`), and — only for a `"prompt"` call that proceeded — `consent: "elicitation"`
  (files written by older versions may also contain `consent: "client"`).
  That marker is the weakest form of evidence recorded here: the daemon never observes
  the actual consent decision, only that the call arrived already gated, so it's kept
  distinct from a plain `"ok"` rather than folded into it. This is on unconditionally;
  there's no flag to disable it. Check `daemon.status`'s `audit.failedWrites` if you
  need to confirm the log is actually landing on disk (e.g. under a read-only or full
  filesystem).
- **Inclusion defaults to dev builds only — not a compiled-in build-type check.** iOS
  restricts CocoaPods linking to the `Debug` configuration; Android swaps in a no-op
  `AppductPackage` for `release`. Both are real per-variant decisions, not a
  `debuggable`/`#if DEBUG` gate compiled into every variant, and neither quietly depends on
  a custom build-type/configuration name being spelled `debug`/`Debug`.

  A release pipeline that wants Appduct anyway (an agent-driven, release-signed internal
  build) sets `APPDUCT_ENABLED=1`; one that wants it gone even from debug sets
  `APPDUCT_ENABLED=0`.
  [`BUILD-VARIANTS.md`](BUILD-VARIANTS.md#inclusion-is-an-autolinking-decision) has the full
  mechanism.

  Verify the outcome against the built artifact (`appduct doctor`). On Android, `doctor` deliberately trusts
  only its `AppductNativeMarker` keep-rule signal, since the release-default no-op stub
  shares the real implementation's package name and would otherwise look present to a naive
  scan. When the module genuinely isn't present, the JS public API degrades to the exact
  `/noop` entry's behavior — see [What a build without the native module
  does](#what-a-build-without-the-native-module-does).
- **Compile out of a build you don't want carrying Appduct at all.** Being present and
  trusting nothing (`trust: "pin"` with a `cliPins` set that has no matching daemon, or an
  app that simply never mints a bootstrap link for that build) still ships the native code
  and JS bundle inside the binary.

  Stripping it takes two independent steps. Excluding the package from **autolinking** is
  the only thing that removes the compiled native pod/module; swapping the **JS** entries
  for `/noop` at bundle time is the only thing that removes the deep-link listener and tool
  registry from the bundle.

  Neither alone removes both. `APPDUCT_ENABLED=0` drives both at once, but only once
  the `withAppduct` Metro helper is wired into `metro.config.js` — without it the
  variable removes the native half only.

  The exact snippets, the `package.json`-only placement of `expo.autolinking`, the
  `apple`-overrides-`ios` rule and the iOS codegen coupling live in
  [`BUILD-VARIANTS.md`](BUILD-VARIANTS.md#compiling-appduct-out-of-production-builds).
  `appduct doctor` verifies the exclusion actually took effect in a built artifact rather
  than trusting the config that was supposed to produce it — this whole area is now checked
  by CI, not just documented.
- **App-store-review note.** An always-installed deep-link listener that can open a
  pinned socket and let an external process invoke code is a legitimate "remote control"
  surface from a reviewer's point of view, even though it can't be exercised without a
  trusted key. A release build submitted to app-store review does *not* carry Appduct by
  default (see above); a team that overrides this with `APPDUCT_ENABLED=1` for a review
  build should be ready to explain the trust model in review notes, or exclude Appduct
  entirely (above) for that build track instead.

## The localhost/UDS trust boundary

The control plane (`daemon.sock`) is guarded by filesystem permissions, not by an
application-level credential: anything running as the same OS user that can open that
socket can do anything the CLI or MCP server can do — list sessions, invoke tools,
read audit-adjacent metadata, shut the daemon down. This is an intentional simplification
(matching the trust most local dev tooling — Docker's socket, most language-server
protocols — already assumes for the same-user case), not an oversight, but it means:

- Don't run the daemon as a different, more-privileged user than the processes that
  should be allowed to talk to it.
- Multi-tenant machines (shared CI runners, shared dev boxes) should give each
  tenant/user their own `APPDUCT_STATE_DIR`, since anyone who can reach another user's
  socket has that user's full Appduct access.
- This boundary is orthogonal to the `wss://` pinning boundary: compromising the UDS
  control plane gets you the same access as running the CLI yourself, but does not by
  itself hand you the private key or let you impersonate the daemon to a device that
  hasn't connected yet.
