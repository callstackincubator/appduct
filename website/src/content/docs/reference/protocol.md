---
title: Wire protocol
description: The Appduct v2 protocol between an app and the background service — link payload, messages, tool descriptors, session states, error types, and close codes.
sidebar:
  order: 4
---

This page is for people implementing an Appduct client in a new language or framework. If you use the React Native, iOS, or Android library, you don't need it, except for [Error types](#error-types).

The types and validators in [`@appduct/shared`](https://github.com/callstackincubator/appduct/tree/main/packages/shared/src/domains) are authoritative if this page and the code ever differ. The source for this page is [PROTOCOL.md](https://github.com/callstackincubator/appduct/blob/main/docs/PROTOCOL.md).

## Overview

- One background service on the operator's computer holds a TLS private key and listens on one `wss://` port. Any number of apps connect to it, each with its own session.
- The app connects **to** the service, using an address and one-time token from a deep link.
- The app trusts the service only if the SHA-256 hash of the TLS leaf certificate's SubjectPublicKeyInfo matches a pin: `sha256/<base64>`. Apps accept a *set* of pins, so keys can be rotated.
- The deep link isn't proof of authority, only data for one pending session.

## The link

```
<scheme>:///?appduct=<payload>&pin=<sha256/...>
```

- `appduct` is the bootstrap payload, base64url without padding.
- `pin` is the service's current key fingerprint, percent-encoded. A build with embedded pins ignores it. A build without pins trusts it for this one session.

When extracting the payload, **stop at the `&`**. Reading to the end of the string pulls the pin into the payload and corrupts it.

### Payload layout

All multi-byte integers are big-endian.

| Bytes | Field | Notes |
| --- | --- | --- |
| 1 | `version` | Always `0x02`. Reject anything else, including `0x01`. |
| 1 | `family` | `0x04` (IPv4) or `0x06` (IPv6) |
| 4 or 16 | `address` | Per `family` |
| 2 | `port` | Never `0` |
| 1 + n | `sessionId` | 1-byte length (1–255), then UTF-8 bytes |
| 32 | `token` | Raw bytes. Sent in `session_claim.token` as base64url. |
| 8 | `expiresAt` | Unix **seconds** |

Decode strictly: a wrong version, unknown family, wrong total length, empty or invalid UTF-8 session id, or port `0` makes the whole payload invalid. Also reject expired payloads.

Connect to `wss://<address>:<port>`, with IPv6 addresses in brackets: `wss://[fd00::1]:8443`.

The reference clients also refuse, by default, a payload whose address isn't a local IPv4 address (RFC 1918 ranges or `127.0.0.1`).

## Connection rules

- **Text frames only.** A binary frame closes the socket (`1003`).
- **Maximum message size is 256 KiB**, in both directions.
- **One JSON object per frame.** Invalid JSON closes the socket.
- **The first message must be `session_claim` or `session_resume`**, within 10 seconds of connecting.
- **After that, every message carries the session's `session_id`.** A mismatch closes the socket.
- **Unknown message types close the socket.** They aren't ignored.
- **Keepalive uses WebSocket ping/pong**, not JSON. The service pings every 15 seconds; two missed pongs count as a lost connection. Clients should ping at the same interval and treat a missed pong as a connection error.

## Messages

### Connecting

**`session_claim`**, app → service, first message on a new connection:

```json
{
  "type": "session_claim",
  "protocol_version": 2,
  "session_id": "XzAERP54_Goh74hZ",
  "token": "<base64url, 32 bytes>",
  "device_manufacturer": "Apple",
  "device_model": "iPhone15,2",
  "device_os": "iOS 18.2"
}
```

`protocol_version` must be `2`. `session_id` and `token` are required, up to 128 characters. The `device_*` fields are optional strings up to 256 characters; one invalid field rejects the whole message. The alias is derived from `device_model`.

**`session_resume`**, app → service, first message when reconnecting:

```json
{ "type": "session_resume", "protocol_version": 2, "session_id": "XzAERP54_Goh74hZ", "resume_token": "<base64url, 32 bytes>" }
```

**`session_ack`**, service → app, success reply to either:

```json
{
  "type": "session_ack",
  "session_id": "XzAERP54_Goh74hZ",
  "status": "ok",
  "alias": "iphone15-2",
  "resume_token": "<base64url, 32 bytes>",
  "keepalive_interval_s": 15,
  "grace_s": 600
}
```

The `resume_token` changes on **every** successful claim and resume, and the previous one stops working. Always keep the latest. The reference clients keep it in memory only, never on disk.

### Tool registry

**`tool_registry_snapshot`**, app → service, after every claim and every resume. It replaces whatever the service had:

```json
{
  "type": "tool_registry_snapshot",
  "session_id": "XzAERP54_Goh74hZ",
  "tools": [
    {
      "name": "sum",
      "description": "Add two numbers.",
      "input_schema": { "type": "object", "properties": { "a": { "type": "number" }, "b": { "type": "number" } }, "required": ["a", "b"] },
      "output_schema": { "type": "object", "properties": { "total": { "type": "number" } } },
      "annotations": { "readOnlyHint": true },
      "timeout_ms": 60000,
      "group": "math"
    }
  ]
}
```

One invalid descriptor invalidates the whole snapshot and closes the socket.

**`tool_registry_delta`**, app → service, when a tool is added, changed, or removed:

```json
{ "type": "tool_registry_delta", "session_id": "XzAERP54_Goh74hZ", "operation": "upsert", "tool": { "name": "sum", "description": "Add two numbers." } }
{ "type": "tool_registry_delta", "session_id": "XzAERP54_Goh74hZ", "operation": "remove", "name": "sum" }
```

### Calls

**`tool_call`**, service → app. `args` is always a JSON object:

```json
{ "type": "tool_call", "session_id": "XzAERP54_Goh74hZ", "id": "call_1", "name": "sum", "args": { "a": 2, "b": 3 } }
```

**`tool_result`**, app → service. `result` can be any JSON value, including `null`:

```json
{ "type": "tool_result", "session_id": "XzAERP54_Goh74hZ", "id": "call_1", "result": { "total": 5 } }
```

**`tool_error`**, app → service. `error.type` must be one of the [app error types](#error-types):

```json
{
  "type": "tool_error",
  "session_id": "XzAERP54_Goh74hZ",
  "id": "call_1",
  "error": { "type": "tool_execution_error", "message": "Something went wrong", "details": { "stack": "…" } }
}
```

**`tool_call_progress`**, app → service, optional during a long call. Both fields are optional:

```json
{ "type": "tool_call_progress", "session_id": "XzAERP54_Goh74hZ", "id": "call_1", "progress": 0.5, "message": "Halfway there" }
```

**`tool_cancel`**, service → app, when the caller goes away while the call is pending:

```json
{ "type": "tool_cancel", "session_id": "XzAERP54_Goh74hZ", "id": "call_1", "reason": "client_cancelled" }
```

A cancel for an unknown or finished call is not an error. The app should abort the handler and reply with `tool_error` of type `tool_cancelled`. A handler that ignores the cancel may still reply normally.

The app runs its own timer per call, using the tool's `timeout_ms` or 10 seconds. When it fires, the app replies `tool_timeout` and ignores the handler's later result.

### App events

**`event`**, app → service, outside the call cycle:

```json
{ "type": "event", "session_id": "XzAERP54_Goh74hZ", "name": "screen_changed", "payload": { "screen": "Checkout" }, "ts": 1752600000000 }
```

`ts` is in milliseconds. `payload` is optional.

## Tool descriptor

```json
{
  "name": "sum",
  "description": "Add two numbers.",
  "input_schema": {},
  "output_schema": {},
  "annotations": { "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true },
  "timeout_ms": 60000,
  "group": "math/arithmetic"
}
```

| Field | Required | Rules |
| --- | --- | --- |
| `name` | Yes | `^[a-zA-Z0-9_-]{1,64}$`, unique per session |
| `description` | Yes | 1–4,096 characters |
| `input_schema` | No | A JSON object, documented as JSON Schema draft 2020-12. Must accept a JSON object to be callable. |
| `output_schema` | No | A JSON object |
| `annotations` | No | `readOnlyHint`, `destructiveHint`, `idempotentHint`. `destructiveHint: true` selects the `destructive` policy. |
| `timeout_ms` | No | Positive integer. The default time limit for calls; the service clamps it to 1,000–600,000. |
| `group` | No | `^[a-zA-Z0-9_-]{1,64}(/[a-zA-Z0-9_-]{1,64})?$`. Omit for an ungrouped tool; `null` and `""` are invalid. |

Descriptor fields are snake_case. A camelCase `timeoutMs` on a descriptor is an unknown field, not a time limit. The service never inspects schema contents, only that they're objects. Services that don't know `group` ignore it.

## Session states

```
                link created
                    │
                    ▼
 ┌─► PENDING ──TTL expired──► DISCARDED
 │      │
 │   claim ok
 │      ▼
 │   ACTIVE ◄──────────resume ok───────┐
 │      │                              │
 │   connection lost                   │
 │      ▼                              │
 │   SUSPENDED ──grace elapsed──► EXPIRED
 │      └──────────────────────────────┘
 └─ revoke, from any state ──► REVOKED
```

- **Pending:** the token is single-use. Five failed claims make the session unclaimable.
- **Active → suspended:** on close, error, or missed pongs. The tool list, device info, and alias are kept. Pending calls fail with `session_suspended`.
- **Suspended → active:** a `session_resume` on a new, pinned connection within `grace_s` (default 600 seconds), with the latest resume token. The app then sends a full snapshot.
- **Discarded, expired, revoked** are final and free the alias.

## Close codes

| Code | Reason | When |
| --- | --- | --- |
| 1000 | `session_replaced` | A new claim or resume for the same session replaced this connection |
| 1000 | `revoked` | The session was revoked |
| 1003 | `binary_frame_not_supported` | A binary frame arrived |
| 1008 | `pre_claim_timeout` | No claim or resume within 10 seconds |
| 1008 | `invalid_json` | A frame wasn't valid JSON |
| 1008 | `expected_claim_or_resume` | The first message was something else |
| 1008 | `unknown_message_type` | Unknown `type` after the claim |
| 1008 | `session_mismatch` | Wrong `session_id` |
| 1008 | `already_claimed` | The session already has an active connection |
| 1008 | `unknown_session` | The service doesn't know this session, for example after it restarted |
| 1008 | `link_expired` | The link's expiry passed |
| 1008 | `claim_attempts_exceeded` | The fifth failed claim |
| 1008 | `invalid_token` | Wrong claim token |
| 1008 | `invalid_resume_token` | Wrong or outdated resume token |
| 1008 | `invalid_registry` | A snapshot or delta failed validation |
| 1008 | `invalid_message` | A known message type with invalid fields |
| 1011 | `send_failed` | The service couldn't write to the socket |

**Treat `1008` as final:** no retry of the same message can succeed, so end the session and report the reason. Other closes, including `1011` and `1001` (service shutting down), are worth retrying with backoff while the grace period lasts. The reference clients back off from 0.5 up to 30 seconds, with jitter.

## Error types

These reach callers unchanged, as the `type` of a CLI `--json` error, an `AppductError` in `appduct/client`, or an MCP tool error.

**Sent by the app** in `tool_error`:

| Type | Meaning |
| --- | --- |
| `tool_not_found` | No tool with that name is registered |
| `tool_input_validation_error` | Arguments didn't match the input schema |
| `tool_output_validation_error` | The result didn't match the output schema |
| `tool_execution_error` | The handler threw |
| `tool_serialization_error` | The result couldn't be converted to JSON |
| `tool_timeout` | The call ran past its time limit |
| `tool_cancelled` | The caller cancelled the call |

**Reported by the background service:**

| Type | Meaning |
| --- | --- |
| `no_session` | No device is connected, and no selector was given |
| `ambiguous_session` | More than one device is connected; pass a selector |
| `unknown_session` | No session matches the selector |
| `session_not_active` | The session isn't active |
| `session_suspended` | The device disconnected during the call |
| `policy_denied` | [Policy](/appduct/guides/security/#limit-what-callers-can-run) refused the call. Changing config, not retrying, fixes it. |
| `invalid_request` | The request itself was malformed |

## The local control interface

The CLI, MCP server, and `appduct/client` talk to the background service with JSON-RPC 2.0 over a Unix domain socket at `<state-dir>/daemon.sock`, one message per line. It isn't part of the app protocol. Its methods are documented in [ARCHITECTURE.md §5](https://github.com/callstackincubator/appduct/blob/main/docs/ARCHITECTURE.md#5-control-plane-rpc-uds).
