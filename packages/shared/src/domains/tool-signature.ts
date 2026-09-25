/**
 * Renders a `ToolDescriptor` into a one-line call signature, e.g.
 * `seed_cart(items: int, sku?: string, clear?: bool = true) -> { added: int, cartId: string }`.
 *
 * This exists so `appduct tools ls` can list hundreds of tools cheaply for an agent to read: a
 * signature plus the description's first line says far more per line than a bare name, without
 * the cost of printing every tool's full schema (`--full`/`tools describe <name>` remain the
 * source of truth for that).
 *
 * A tool's `input_schema`/`output_schema` are draft-2020-12 JSON Schema fragments whose internals
 * are never validated anywhere in this codebase (`tool-descriptor.ts`'s `isToolDescriptor` only
 * checks they are JSON objects) — an app can send anything shaped like an object. Every function
 * here is therefore purely defensive: an unrecognised or malformed fragment renders as `...`
 * (or `{...}`/`(...)`/`unknown[]` in context) rather than throwing.
 */

import type { ToolDescriptor, ToolSchemaDescriptor } from "./tool-descriptor.js";

type JsonSchema = Record<string, unknown>;

const isSchemaObject = (value: unknown): value is JsonSchema => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

/** JSON Schema keywords that describe a composed/indirect schema this renderer does not attempt
 * to resolve — always `...`, at any depth. */
const isUnresolvable = (schema: JsonSchema): boolean => {
  return (
    schema.anyOf !== undefined ||
    schema.oneOf !== undefined ||
    schema.allOf !== undefined ||
    schema.not !== undefined ||
    schema.$ref !== undefined
  );
};

const MAX_ENUM_VALUES = 5;
/** `default` only appends to a param entry when its JSON rendering stays this short — a longer
 * default belongs in the full schema (`tools describe <name>`), not a one-line signature. */
const MAX_DEFAULT_LENGTH = 20;

/** An `enum`/`const` value longer than this (as JSON) is cut with `…` — one 5 KB enum string must
 * not turn a one-line signature into a page. */
const MAX_LITERAL_LENGTH = 40;
/** Nested `type: "array"` `items` deeper than this render as `...[]`. Objects already stop after
 * one level; without this cap, arrays of arrays (or a cyclic `items`, possible for an in-process
 * caller) would recurse until the stack overflows. */
const MAX_ARRAY_DEPTH = 4;

/** `JSON.stringify` that never throws (a `BigInt`, a cycle) — `undefined` when it can't render. */
const tryStringify = (value: unknown): string | undefined => {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json : undefined;
  } catch {
    return undefined;
  }
};

const renderLiteral = (value: unknown): string => {
  const json = tryStringify(value);

  if (json === undefined) {
    return "...";
  }

  const codePoints = Array.from(json);
  return codePoints.length > MAX_LITERAL_LENGTH ? `${codePoints.slice(0, MAX_LITERAL_LENGTH).join("")}…` : json;
};

/** A property name as written in the signature: bare when it is identifier-like, else quoted as
 * JSON, so a hostile key (a newline, an escape sequence) can never break the line it sits on. */
const renderPropertyName = (name: string): string => {
  return /^[\p{L}\p{N}_$-]+$/u.test(name) ? name : JSON.stringify(name);
};

const renderEnumValues = (values: unknown[]): string => {
  const shown = values.slice(0, MAX_ENUM_VALUES).map(renderLiteral);
  const suffix = values.length > MAX_ENUM_VALUES ? " | …" : "";
  return `${shown.join(" | ")}${suffix}`;
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

/**
 * One property list, shared by the top-level params `(...)` group and a one-level-deep nested
 * object's `{...}` group: `undefined` means the schema declares no usable `properties` at all
 * (missing, or not itself a JSON object) — the caller decides what that renders as. A present but
 * empty `properties` object (an intentional "no fields") renders as `[]`, distinct from that.
 */
const propertyEntries = (schema: JsonSchema, expandObject: boolean): string[] | undefined => {
  const properties = schema.properties;

  if (!isSchemaObject(properties)) {
    return undefined;
  }

  const requiredRaw = schema.required;
  const required = Array.isArray(requiredRaw)
    ? requiredRaw.filter((entry): entry is string => typeof entry === "string")
    : [];

  return Object.keys(properties).map((name) =>
    renderParamEntry(name, properties[name], required.includes(name), expandObject),
  );
};

/** Renders one `(...)`/`{...}` group: an explicit empty property list is `emptyToken`; a schema
 * with no `properties` key at all falls back to `emptyToken` when `additionalProperties` is
 * `false` (nothing to show, so same as truly empty) or `unresolvedToken` otherwise (there may be
 * fields, this renderer just cannot see them). */
const renderPropertyGroup = (
  schema: JsonSchema,
  expandObject: boolean,
  emptyToken: string,
  wrap: (joined: string) => string,
  unresolvedToken: string,
): string => {
  const entries = propertyEntries(schema, expandObject);

  if (entries === undefined) {
    return schema.additionalProperties === false ? emptyToken : unresolvedToken;
  }

  return entries.length === 0 ? emptyToken : wrap(entries.join(", "));
};

/** A `type: "object"` schema encountered while rendering a type (a property's own type, an array's
 * `items`, ...) — expanded one level via {@link renderPropertyGroup} when `expandObject` allows
 * it, else the deliberately shallow `{...}`. */
const renderObjectType = (schema: JsonSchema): string => {
  return renderPropertyGroup(schema, false, "{}", (joined) => `{ ${joined} }`, "{...}");
};

const renderScalarType = (
  typeValue: unknown,
  schema: JsonSchema,
  expandObject: boolean,
  arrayDepth: number,
): string => {
  if (typeValue === "array") {
    const items = schema.items;

    if (!isSchemaObject(items)) {
      return "unknown[]";
    }

    return arrayDepth >= MAX_ARRAY_DEPTH ? "...[]" : `${renderType(items, expandObject, arrayDepth + 1)}[]`;
  }

  if (typeValue === "object") {
    return expandObject ? renderObjectType(schema) : "{...}";
  }

  if (typeof typeValue === "string") {
    const primitive = primitiveTypeName(typeValue);

    if (primitive) {
      return primitive;
    }
  }

  return "...";
};

/**
 * The single type renderer every other function here goes through: `enum`/`const` win over
 * `type`, a `type` array fans out and joins with ` | `, and `expandObject` gates one level of
 * `type: "object"` expansion (`renderObjectType` always passes `false` back down, so nothing
 * expands twice).
 */
const renderType = (schema: unknown, expandObject: boolean, arrayDepth = 0): string => {
  if (!isSchemaObject(schema)) {
    return "...";
  }

  if (isUnresolvable(schema)) {
    return "...";
  }

  if ("const" in schema) {
    return renderLiteral(schema.const);
  }

  if (Array.isArray(schema.enum)) {
    return renderEnumValues(schema.enum);
  }

  const type = schema.type;

  if (Array.isArray(type)) {
    return type.map((entry) => renderScalarType(entry, schema, expandObject, arrayDepth)).join(" | ");
  }

  return renderScalarType(type, schema, expandObject, arrayDepth);
};

const renderParamEntry = (
  name: string,
  propSchema: unknown,
  required: boolean,
  expandObject: boolean,
): string => {
  let entry = `${renderPropertyName(name)}${required ? "" : "?"}: ${renderType(propSchema, expandObject)}`;

  if (isSchemaObject(propSchema) && "default" in propSchema) {
    const json = tryStringify(propSchema.default);

    if (json !== undefined && json.length <= MAX_DEFAULT_LENGTH) {
      entry += ` = ${json}`;
    }
  }

  return entry;
};

/** The `(...)` params group. An absent `input_schema` is `()`: the SDKs omit it for a tool that
 * takes no input. Unlike {@link renderObjectType}, a present `input_schema` not rooted at
 * `type: "object"` is always `(...)` — a call's args are always a JSON object, so anything else
 * means this renderer cannot describe the call's arguments, not that there are none. */
const renderParams = (inputSchema: ToolSchemaDescriptor | undefined): string => {
  if (inputSchema === undefined) {
    return "()";
  }

  if (!isSchemaObject(inputSchema) || inputSchema.type !== "object") {
    return "(...)";
  }

  return renderPropertyGroup(inputSchema, true, "()", (joined) => `(${joined})`, "(...)");
};

/** The ` -> ...` result suffix, empty when the tool declares no `output_schema` at all. An
 * object-rooted result is inlined one level (`renderType`'s `type: "object"` branch, same as any
 * other property value); anything else renders as its own type, e.g. ` -> string[]`. */
const renderResult = (outputSchema: ToolSchemaDescriptor | undefined): string => {
  if (outputSchema === undefined) {
    return "";
  }

  return ` -> ${renderType(outputSchema, true)}`;
};

/**
 * Renders a tool into its one-line call signature. Pure and total: no input can make this throw,
 * and every unrecognised schema shape degrades to `...` (or the contextual `{...}`/`(...)`/
 * `unknown[]`) rather than omitting information or crashing the listing that calls it.
 */
export const renderToolSignature = (
  tool: Pick<ToolDescriptor, "name" | "input_schema" | "output_schema">,
): string => {
  const name = typeof tool?.name === "string" ? tool.name : "";

  try {
    return `${name}${renderParams(tool?.input_schema)}${renderResult(tool?.output_schema)}`;
  } catch {
    // Unreachable for JSON off the wire; an in-process caller can still hand over an object whose
    // getters throw. The listing that calls this must not die for one tool.
    return `${name}(...)`;
  }
};

/** The listing's per-tool summary length, in code points. The full description (up to
 * `MAX_TOOL_DESCRIPTION_LENGTH`) stays available from a single-tool lookup. */
export const MAX_TOOL_SUMMARY_LENGTH = 120;

/**
 * A tool description's first line, for a listing (`appduct tools ls`, `appduct_list_tools`): any line
 * break ends it (`\r` alone included), remaining control characters are dropped since the text is
 * app-supplied and may be printed straight to a terminal, and it is capped at
 * {@link MAX_TOOL_SUMMARY_LENGTH} code points, never cut through a surrogate pair.
 */
export const summarizeToolDescription = (description: string): string => {
  const firstLine = (description.split(/\r\n|[\n\r\u2028\u2029]/u)[0] ?? "").replace(/\p{Cc}/gu, "").trim();
  const codePoints = Array.from(firstLine);

  return codePoints.length > MAX_TOOL_SUMMARY_LENGTH
    ? `${codePoints.slice(0, MAX_TOOL_SUMMARY_LENGTH).join("")}…`
    : firstLine;
};
