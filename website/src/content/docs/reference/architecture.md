---
title: How it works
description: The pieces of Appduct, how a device connects, what survives reloads and restarts, and how calls, timeouts, and policy behave.
sidebar:
  order: 3
---

This page explains what happens between your terminal and your app, as far as it affects how you use Appduct. The full design document, written for contributors, is [ARCHITECTURE.md](https://github.com/callstackincubator/appduct/blob/main/docs/ARCHITECTURE.md) on GitHub.

## The pieces

```
            your computer                                    devices
┌───────────────────────────────────────────┐
│  appduct CLI ─────┐                       │
│  MCP clients ─────┼──► background service ◄┼──── encrypted ──── iPhone   (session A)
│  test runners ────┘    (the daemon)       ◄┼──── connections ── Pixel    (session B)
│                        ~/.appduct/        ◄┼─────────────────── Simulator (session C)
└───────────────────────────────────────────┘
```

- **The background service** (`appduct daemon`) runs on your computer, one per user. It holds the private key, listens for devices on one port (8443 by default), keeps every session, and applies policy. It starts on the first command that needs it and keeps running on its own; nothing a device does stops it.
- **The CLI, the MCP server, and `appduct/client`** don't connect to devices themselves. They send requests to the background service over a local socket that only your user can open. That's why they always agree: they make the same requests.
- **Your app** registers tools and connects *to* your computer, not the other way round. That's what makes physical phones work.

## How a device connects

1. `appduct link` (or `appduct_connect`) asks the background service for a **pending session** and gets back a link: `<scheme>:///?appduct=<payload>&pin=<fingerprint>`. The payload holds your computer's address and port, a session id, a one-time token, and an expiry time.
2. The link reaches the app: through `adb` or the simulator, or as a QR code you scan.
3. The app opens an encrypted connection to the address in the link and checks your computer's key against its pins, or, with no pins, against the fingerprint in the link. See [Security](/appduct/guides/security/#choose-what-a-build-trusts).
4. The app sends the token. If it matches, the session becomes **active**, gets an alias based on the device model (like `pixel-8`), and the app sends its tool list.

For simulators and Android devices reached through `adb`, the link points to `127.0.0.1`. For QR codes and physical iPhones, it points to your computer's local network address, which the phone must be able to reach.

A link can be used once and expires after 5 minutes (`linkTtlSeconds`). Five wrong tokens for the same session make it unusable.

## What survives what

| Event | What happens |
| --- | --- |
| Metro reload, Fast Refresh | The session resumes on its own, with the same alias. |
| App in the background | The session pauses and resumes when the app returns. |
| Network drop | The app reconnects with increasing delays, up to 30 seconds apart. |
| Disconnected for more than 10 minutes (`graceSeconds`) | The session expires. Connect again with a new link. |
| App process killed or relaunched | The session can't resume: resume credentials are kept only in memory. Connect again. |
| Background service stopped or restarted | Every session ends. Connect devices again. |
| `appduct revoke` | That session ends immediately. |

While a session is disconnected, its alias and tool list are kept, and calls fail fast with `session_suspended`. After a resume, the app sends its full tool list again.

Session states: **pending** (link created) → **active** → **suspended** (disconnected) → **active** again, or **expired**. A link nobody opened in time is **discarded**. `appduct revoke` moves any session to **revoked**. Ending a session frees its alias for the next device.

## How a call runs

1. The caller asks the background service to call a tool.
2. The service checks [policy](/appduct/guides/security/#limit-what-callers-can-run). A denied call never reaches the app. A `"prompt"` call over MCP first asks the person through the MCP client.
3. The service sends the call to the app, which validates the arguments, runs the handler, and replies with the result or an error.
4. The service records the attempt in the audit log and returns the result. Error types from the app, such as `tool_execution_error`, reach the caller unchanged.

### Time limits

- The app stops each call at the tool's `timeoutMs`, or 10 seconds if it declares none. This is the real limit.
- The tool's `timeoutMs` is also sent to the background service, so callers get the same budget without asking.
- A caller can pass a shorter limit, but not a longer one: the app stops the handler at its own limit anyway.
- All limits are clamped to 1–600 seconds.

### Cancellation

A call is cancelled when the caller goes away: Ctrl-C on `appduct invoke`, an MCP client cancelling a request, or a test process exiting. The app then aborts the handler's `signal`. A handler that ignores the signal runs to the end anyway. After a timeout, whatever it returns is ignored.

## Events

Apps post events with `postEvent`. The background service keeps the last 256 events per session (not counting progress updates), so a caller can ask what happened after the fact instead of having to listen beforehand. Each event carries a `seq` cursor; pass the last one you saw as `since` to read only newer events. A session's events are discarded when it ends.

## Upgrades

The background service keeps running after you upgrade the CLI. On its first command, each CLI or MCP process compares versions:

- **Same version:** nothing happens.
- **The service is newer:** the command proceeds with a notice. Appduct never downgrades a running service.
- **The service is older and holds nothing:** it's replaced automatically.
- **The service is older and has connected devices or an unopened link:** the command stops and names both versions, instead of dropping your sessions. Run `appduct daemon stop`, or pass `--daemon-restart`.

A long-running MCP server doesn't re-check after it starts; restart it after upgrading.

## What Appduct doesn't do

- Run arbitrary code in your app. Only tools you registered can be called.
- Replace UI testing. It skips setup; your UI test tool still drives the screens.
- Accept connections without a link and a matching key.
- Relay to computers other than the one running the background service.
- Run in a web browser. The web build is a stub that does nothing.
- Call a tool whose input schema can't accept a JSON object. Such tools are listed but can't be called.

## For the details

- [Wire protocol](/appduct/reference/protocol/): messages, the link payload, and close codes, for implementing a client.
- [ARCHITECTURE.md](https://github.com/callstackincubator/appduct/blob/main/docs/ARCHITECTURE.md): the full design document.
- [SECURITY.md](https://github.com/callstackincubator/appduct/blob/main/docs/SECURITY.md): the full threat model.
