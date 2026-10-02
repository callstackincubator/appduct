/**
 * Renders an `EventDescriptor` into a one-line signature, e.g. `checkout_completed { orderId:
 * string }`, for `appduct events ls`. Deliberately smaller than `tool-signature.ts`'s
 * `renderToolSignature`: an event has one `payload_schema`, not a params/result pair, so this only
 * ever expands one level of a `type: "object"` payload's own properties (no nested-object
 * expansion, no array-of-array depth limit) — the payload shapes apps declare are flat far more
 * often than a tool's structured result, and `events ls <exact name>`'s full schema stays the
 * source of truth for anything deeper.
 *
 * Like `renderToolSignature`, this is purely defensive: `payload_schema` is never validated
 * (`event-descriptor.ts`'s `isEventDescriptor` only checks it is a JSON object), so an
 * unrecognised or malformed fragment renders as `{...}` rather than throwing.
 */

import type { EventDescriptor, EventSchemaDescriptor } from "./event-descriptor.js";

type JsonSchema = Record<string, unknown>;

const isSchemaObject = (value: unknown): value is JsonSchema => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const primitiveTypeName = (type: string): string | undefined => {
  switch (type) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "bool";
    case "integer":
      return "int";
    case "null":
      return "null";
    default:
      return undefined;
  }
};

/** One property's type: an array's element type one level deep, `{...}` for a nested object
 * (never expanded further), a primitive's short name, or `...` for anything unrecognised. */
const renderPropertyType = (schema: unknown): string => {
  if (!isSchemaObject(schema)) {
    return "...";
  }

  if (Array.isArray(schema.enum)) {
    return schema.enum.length > 0 ? "..." : "never";
  }

  const type = schema.type;

  if (type === "array") {
    const items = schema.items;
    return isSchemaObject(items) ? `${renderPropertyType(items)}[]` : "unknown[]";
  }

  if (type === "object") {
    return "{...}";
  }

  if (typeof type === "string") {
    return primitiveTypeName(type) ?? "...";
  }

  return "...";
};

/** The ` { ... }` payload group, empty string when the event declares no `payload_schema` at all
 * (a posted event with no payload). A schema not rooted at `type: "object"`, or with no usable
 * `properties`, renders as ` {...}` — there may be a payload, this renderer just cannot describe
 * its shape. */
const renderPayload = (schema: EventSchemaDescriptor | undefined): string => {
  if (schema === undefined) {
    return "";
  }

  if (!isSchemaObject(schema) || schema.type !== "object") {
    return " {...}";
  }

  const properties = schema.properties;

  if (!isSchemaObject(properties)) {
    return schema.additionalProperties === false ? " {}" : " {...}";
  }

  const keys = Object.keys(properties);

  if (keys.length === 0) {
    return " {}";
  }

  const requiredRaw = schema.required;
  const required = Array.isArray(requiredRaw)
    ? requiredRaw.filter((entry): entry is string => typeof entry === "string")
    : [];

  const entries = keys.map((name) => `${name}${required.includes(name) ? "" : "?"}: ${renderPropertyType(properties[name])}`);

  return ` { ${entries.join(", ")} }`;
};

/**
 * Renders an event into its one-line signature. Pure and total: no input can make this throw.
 */
export const renderEventSignature = (
  event: Pick<EventDescriptor, "name" | "payload_schema">,
): string => {
  const name = typeof event?.name === "string" ? event.name : "";

  try {
    return `${name}${renderPayload(event?.payload_schema)}`;
  } catch {
    return name;
  }
};
