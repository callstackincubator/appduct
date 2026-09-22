---
name: appduct
description: Drive an Appduct-enabled app (React Native, iOS or Android) from the terminal or over MCP — connect a device, list the tools the app registers, call them — and write tools that agents can use well. Use when the user mentions Appduct, wants to pair or connect a device, invoke app-defined tools from the CLI or MCP, or asks to add Appduct to an app or write tools for it.
---

# Appduct

Appduct lets you call functions a running app has registered as **tools**. One `appduct`
daemon on this machine holds every device session; the CLI and `appduct mcp` are thin clients
of it and start it on first use. There is no server to start or stop.

## The loop

```bash
appduct ls                                  # connected devices; empty → references/cli.md
appduct tools                               # one signature + description per tool
appduct tools <name>                        # one tool's full input/output schema
appduct invoke <name> --input '{"k":"v"}'   # call it (--input is required; pass '{}' for no args)
```

- Every session command takes an optional **selector** (alias or session id from `appduct ls`)
  as its first positional argument. Omit it with one device connected; with several, the CLI
  fails with `ambiguous_session` and lists the aliases.
- A signature reads `name(param: type, optional?: type = default) -> { result }`. `...` means
  that part of the schema could not be summarized: read `appduct tools <name>` before calling.
  A trailing `[prompt]` or `[deny]` is the tool's policy.
- Large app: `appduct tools --groups` first, then `--group <name>` (a parent group includes its
  subgroups), or `--filter <text>` on name and description. `--limit`/`--offset` page a listing
  whose footer says tools were left out.

## Chain calls instead of narrating between them

Every `appduct` command is a short-lived process talking to the same daemon, so a sequence you
already know belongs in one shell invocation. Failures exit non-zero, so `&&` stops at the first:

```bash
appduct invoke login --input '{"userId":"u_42"}' \
  && appduct invoke seed_cart --input '{"items":3}' \
  && appduct invoke get_cart --input '{}'
```

When a later call needs an earlier result, parse `--json`. A success is `{ "ok": true, "data": … }`;
a failure is `{ "ok": false, "error": { "type": … } }` on stderr:

```bash
cart_id=$(appduct invoke create_cart --input '{}' --json | jq -r .data.cartId)
appduct invoke add_item --input "{\"cartId\":\"$cart_id\",\"sku\":\"SKU-1042\"}"
```

Read the listing once, plan the whole sequence, and fetch full schemas only for tools whose
signature shows `...`. A test suite should use `appduct/client` (see the CLI reference) rather
than spawning `appduct invoke` per call.

## Output and errors

- Plain text is for reading and may change between versions. Add `--json` only when something
  parses the output (`--pretty` indents it).
- `no_session`, `unknown_session`, or an empty `appduct ls`: no device is connected. Connect one
  (references/cli.md).
- `policy_denied`: the daemon's policy blocks this tool. Retrying will not help; it is a
  `policy` change in `~/.appduct/config.json`, and the user's call to make.
- `tool_timeout`: a call gets 10 s unless the app registered the tool with `timeoutMs`.
  `--timeout <ms>` can only shorten that.
- `tool_execution_error`: the app's handler threw; the message is the app's.
- An empty `appduct tools` is not an error: the app registered nothing.

## Over MCP

Same loop through built-in tools that describe themselves: `appduct_connect` then
`appduct_wait_for_session` to connect a device, and `appduct_list_tools`,
`appduct_describe_tool`, `appduct_call_tool` for the app's tools (the app's tools are not MCP
tools of their own). With several devices connected pass `selector`. A tool with policy
`"prompt"` asks the user to approve each call; if they decline, do not retry it yourself.

## References

Read only what the task needs:

- [references/cli.md](./references/cli.md): connect a device (`appduct link`, `--open`, QR,
  MCP `appduct_connect`), watch events, end a session, every command and flag, `appduct/client`
  for test suites.
- [references/writing-tools.md](./references/writing-tools.md): register tools in the app
  (`registerTool`/`useAppductTool`, Swift, Kotlin), the schema rules, and how to design tools so
  the agent calling them gets it right first time.
- [references/setup.md](./references/setup.md): add Appduct to a project for the first time.
