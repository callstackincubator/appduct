/**
 * Renders a `ToolDescriptor` into a one-line call signature, e.g.
 * `seed_cart(items: int, sku?: string, clear?: bool = true) -> { added: int, cartId: string }`.
 *
 * This exists so `appduct tools` can list hundreds of tools cheaply for an agent to read: a
 * signature plus the description's first line says far more per line than a bare name, without
 * the cost of printing every tool's full schema (`--full`/`tools <name>` remain the source of
 * truth for that).
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
 * default belongs in the full schema (`tools <name>`), not a one-line signature. */
const MAX_DEFAULT_LENGTH = 20;

const renderEnumValues = (values: unknown[]): string => {
  const shown = values.slice(0, MAX_ENUM_VALUES).map((value) => JSON.stringify(value));
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

const renderScalarType = (typeValue: unknown, schema: JsonSchema, expandObject: boolean): string => {
  if (typeValue === "array") {
    const items = schema.items;
    return isSchemaObject(items) ? `${renderType(items, expandObject)}[]` : "unknown[]";
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
const renderType = (schema: unknown, expandObject: boolean): string => {
  if (!isSchemaObject(schema)) {
    return "...";
  }

  if (isUnresolvable(schema)) {
    return "...";
  }

  if ("const" in schema) {
    const rendered = JSON.stringify(schema.const);
    return typeof rendered === "string" ? rendered : "...";
  }

  if (Array.isArray(schema.enum)) {
    return renderEnumValues(schema.enum);
  }

  const type = schema.type;

  if (Array.isArray(type)) {
    return type.map((entry) => renderScalarType(entry, schema, expandObject)).join(" | ");
  }

  return renderScalarType(type, schema, expandObject);
};

const renderParamEntry = (
  name: string,
  propSchema: unknown,
  required: boolean,
  expandObject: boolean,
): string => {
  let entry = `${name}${required ? "" : "?"}: ${renderType(propSchema, expandObject)}`;

  if (isSchemaObject(propSchema) && "default" in propSchema) {
    const json = JSON.stringify(propSchema.default);

    if (typeof json === "string" && json.length <= MAX_DEFAULT_LENGTH) {
      entry += ` = ${json}`;
    }
  }

  return entry;
};

/** The `(...)` params group. Unlike {@link renderObjectType}, an `input_schema` not rooted at
 * `type: "object"` (or absent entirely) is always `(...)` — MCP requires an object-rooted input
 * schema (`tool-descriptor.ts`'s `isObjectRootedSchema`), so anything else means this renderer
 * cannot describe the call's arguments, not that there are none. */
const renderParams = (inputSchema: ToolSchemaDescriptor | undefined): string => {
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
  return `${name}${renderParams(tool?.input_schema)}${renderResult(tool?.output_schema)}`;
};
