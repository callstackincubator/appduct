---
name: appduct
description: Drive an Appduct-enabled app (React Native, iOS or Android) from the terminal or over MCP — connect a device, list the tools the app registers, call them — and write tools that agents can use well. Use when the user mentions Appduct, wants to pair or connect a device, invoke app-defined tools from the CLI or MCP, or asks to add Appduct to an app or write tools for it.
---

# Appduct

Appduct lets you call functions a running app has registered as **tools**. One `appduct`
daemon on this machine holds every device session; the CLI and `appduct mcp` are thin clients
of it and start it on first use. There is no server for you to start.

## The loop

```bash
appduct ls                                  # connected devices
appduct tools                               # one signature + description per tool
appduct tools <name>                        # one tool's full input/output schema
appduct invoke <name> --input '{"k":"v"}'   # call it; --input is required, use '{}' for no args
```

- If `appduct ls` is empty, connect a device first: read [references/cli.md](./references/cli.md),
  section "Connect a device".
- Every session command takes an optional **selector** (alias or session id from `appduct ls`)
  as its first positional argument. Omit it when one device is connected. With several, the
  CLI fails with `ambiguous_session` and lists the aliases; pass one.
- A signature reads `name(param: type, optional?: type = default) -> { result }`. A trailing
  `[prompt]` or `[deny]` is the tool's policy. `...` means that part of the schema could not be
  summarized: run `appduct tools <name>` before calling that tool, and only for such tools.
- When the listing footer says tools were left out: run `appduct tools --groups`, then
  `appduct tools --group <name>` (a parent group includes its subgroups), or
  `appduct tools --filter <text>` (matches name and description), or page with
  `--limit <n> --offset <n>`.

## Run a known sequence as one command

Do not run one `appduct` command per turn and think in between. Read the listing once, plan the
whole sequence, then pick the smallest form that fits:

1. **Fixed sequence:** chain with `&&`. Every failure exits non-zero, so the chain stops at the
   first one.

   ```bash
   appduct invoke login --input '{"userId":"u_42"}' \
     && appduct invoke seed_cart --input '{"items":3}' \
     && appduct invoke get_cart --input '{}'
   ```

2. **A later call needs an earlier result:** add `--json` and parse it with `jq`. Success is
   `{ "ok": true, "data": … }` on stdout; failure is `{ "ok": false, "error": { "type": … } }`
   on stderr.

   ```bash
   cart_id=$(appduct invoke create_cart --input '{}' --json | jq -r .data.cartId)
   appduct invoke add_item --input "{\"cartId\":\"$cart_id\",\"sku\":\"SKU-1042\"}"
   ```

3. **A loop, a branch on a result, or a wait for an app event:** write a short `.mjs` script
   with `appduct/client` and run it with `node`. It holds one daemon connection, returns typed
   errors, and has `waitForEvent`. The `appduct` package must be a dependency of the project
   (`npm i -D appduct` if it is not; a global install cannot be imported). Example in
   [references/cli.md](./references/cli.md), section "Scripts and test suites".

4. **Something the user will keep:** the same `appduct/client` code, as a test in their suite.

## Output and errors

- Read the plain-text output. Add `--json` only when a command or script parses it; `--pretty`
  indents it.
- `no_session`, `unknown_session`, or an empty `appduct ls`: no device is connected. Connect one
  ([references/cli.md](./references/cli.md), "Connect a device").
- `policy_denied`: the daemon's policy blocks this tool. Do not retry and do not edit
  `~/.appduct/config.json`; tell the user which tool was denied.
- `tool_timeout`: a call gets 10 s unless the app registered the tool with `timeoutMs`.
  `--timeout <ms>` can only shorten that; the fix is in the app's registration.
- `tool_execution_error`: the app's handler threw; report its message.
- An empty `appduct tools` listing is not an error: the app registered no tools.

## Over MCP

Same loop, through built-in tools whose descriptions say how to use them: `appduct_connect`
then `appduct_wait_for_session` to connect a device; `appduct_list_tools`,
`appduct_describe_tool` and `appduct_call_tool` for the app's tools (the app's tools are not
MCP tools of their own). With several devices connected, pass `selector`. A tool with policy
`"prompt"` asks the user to approve each call; if they decline, do not call it again.

## References

Read a reference only when its trigger applies:

- [references/cli.md](./references/cli.md): `appduct ls` is empty, or you need a command or flag
  not shown above (`link`, `events`, `revoke`, `init`, `--open`, QR, MCP `appduct_connect`), or
  you are writing a script or test with `appduct/client`.
- [references/writing-tools.md](./references/writing-tools.md): the task is to add, change or
  review tools in the app's code (`registerTool`, `useAppductTool`, Swift or Kotlin `register`).
- [references/setup.md](./references/setup.md): the task is to add Appduct to a project that
  does not have it yet.
