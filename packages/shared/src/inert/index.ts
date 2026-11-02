/**
 * `@appduct/shared/inert`: the few runtime values the inert `@appduct/react-native/noop` entry
 * needs. A release build that swaps `./noop` in ships this entry's graph and nothing else, so it
 * must never import the SDK client, schema conversion or listener code (ARCHITECTURE.md §11).
 * `@appduct/shared/sdk` re-exports all of it, so the real entry's API is unchanged. Types come
 * from the SDK with `import type`, which leaves no runtime import.
 */
import type {
  AppductBootstrapParseErrorCode,
  AppductJsonSchemaObject,
} from "../sdk/index.js";

export { createToolGroupFactory } from "./tool-group.js";

/**
 * True iff `url` has an `appduct` key in its query string, the rule the native core's `handleUrl`
 * and the JS deep-link listener use to recognise a pairing link. Accepts full URLs and bare paths,
 * returns `false` for anything else, never throws. A query-string scan on purpose: `new URL`
 * throws on relative input.
 *
 * Use it to keep Appduct links out of your router, for example in Expo Router's
 * `+native-intent` `redirectSystemPath`: `isAppductLink("myapp:///?appduct=abc")` is `true`,
 * `isAppductLink("myapp:///settings")` is `false`.
 */
export function isAppductLink(url: string): boolean {
  if (typeof url !== "string") return false;
  const queryStart = url.indexOf("?");
  if (queryStart === -1) return false;
  const hashStart = url.indexOf("#", queryStart);
  const query = url.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart);
  return query.split("&").some((pair) => pair.split("=")[0] === "appduct");
}

/** Local app-side ceiling for a tool handler, matching the daemon's `tools.call` default (§5/§11). */
export const APPDUCT_DEFAULT_TOOL_TIMEOUT_MS = 10_000;


/**
 * Tags a raw JSON Schema object with the argument/result type its handler should see. Purely a
 * type-level cast — the object is returned unchanged, nothing is validated, and no runtime check
 * ever confirms that `T` matches the schema.
 *
 * ```ts
 * inputSchema: jsonSchema<{ city: string }>({
 *   type: "object",
 *   properties: { city: { type: "string" } },
 *   required: ["city"],
 * })
 * ```
 */
export const jsonSchema = <T = Record<string, unknown>>(
  schema: Record<string, unknown>,
): AppductJsonSchemaObject<T, T> =>
  schema as AppductJsonSchemaObject<T, T>;

export class AppductBootstrapParseError extends Error {
  code: AppductBootstrapParseErrorCode;

  constructor(code: AppductBootstrapParseErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "AppductBootstrapParseError";
  }
}

/** `connect()` rejects with this on the `./noop` entry (ARCHITECTURE.md §11: compile-out builds). */
export class AppductDisabledError extends Error {
  code = "appduct_disabled" as const;

  constructor() {
    super("Appduct is disabled in this build (the ./noop entry is in use).");
    this.name = "AppductDisabledError";
  }
}
