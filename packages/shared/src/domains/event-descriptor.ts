/**
 * `EventDescriptor` (PROTOCOL.md §5, issue #124): the shape an app declares over
 * `event_registry_snapshot`/`event_registry_delta`, and `events.list` returns. Deliberately
 * smaller than `ToolDescriptor` (`tool-descriptor.ts`) — no `group`, no `timeout_ms`, and one
 * `payload_schema` rather than a separate input/output pair, since a posted event has one payload,
 * not a call's args and result.
 *
 * `name` follows the *posted*-event-name rule (`EventMessage.name` in `messages.ts`: any non-empty
 * string up to `MAX_WIRE_STRING_LENGTH` characters), not `ToolDescriptor`'s
 * `[a-zA-Z0-9_-]{1,64}` pattern — an app already posts arbitrary names, dotted ones like
 * `cart.item_added` included, and must be able to declare any of them without renaming. The bound
 * is duplicated here as {@link MAX_EVENT_NAME_LENGTH} rather than imported from `messages.ts`,
 * which itself imports this module for {@link isEventDescriptor}.
 */

import { MAX_TOOL_DESCRIPTION_LENGTH } from "./tool-descriptor.js";

/** Draft 2020-12 JSON Schema object; internals are never validated, only that it is a JSON object
 * (same rule as `ToolSchemaDescriptor`). */
export type EventSchemaDescriptor = Record<string, unknown>;

/** Mirrors `MAX_WIRE_STRING_LENGTH` (`messages.ts`) — the bound a posted event's own `name`
 * already accepts. */
export const MAX_EVENT_NAME_LENGTH = 4096;

export type EventDescriptor = {
  /** Required, non-empty, at most {@link MAX_EVENT_NAME_LENGTH} characters — any string, not the
   * tool-name pattern. */
  name: string;
  description: string;
  payload_schema?: EventSchemaDescriptor;
};

const isJsonObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

/**
 * Strict `EventDescriptor` guard. Every element of an `event_registry_snapshot`/
 * `event_registry_delta` must pass this before any field access — an invalid element (including
 * `null`) must never be indexed into.
 */
export const isEventDescriptor = (value: unknown): value is EventDescriptor => {
  if (!isJsonObject(value)) {
    return false;
  }

  if (typeof value.name !== "string" || value.name.length === 0 || value.name.length > MAX_EVENT_NAME_LENGTH) {
    return false;
  }

  if (typeof value.description !== "string" || value.description.length === 0) {
    return false;
  }

  if (value.description.length > MAX_TOOL_DESCRIPTION_LENGTH) {
    return false;
  }

  if (value.payload_schema !== undefined && !isJsonObject(value.payload_schema)) {
    return false;
  }

  return true;
};
