# Registering tools

How the app side of Appduct publishes tools: the schema forms it accepts, what the
`useAppductTool` hook actually re-registers, the shape MCP requires, and how long a call
may run. The five-minute version lives in the
[package README](../packages/react-native/README.md#4-define-tools-in-app-startup-code); keeping a
destructive tool out of a build variant is [its own
section](./SECURITY.md#gating-a-tool-by-build-variant) of the security model.

## Accepted schema forms

An agent can only use a tool it can see the shape of, so every form below except the last one publishes a real JSON Schema:

| `inputSchema` / `outputSchema` | Validated app-side with | Published to agents | `handler` argument type |
| --- | --- | --- | --- |
| Standard Schema **with** a JSON Schema exporter — zod 4, arktype | `~standard.validate` | its `~standard.jsonSchema` export | the schema's own type |
| `{ schema, jsonSchema }` pair — zod 3, valibot, anything else | `schema["~standard"].validate` | the `jsonSchema` you supply (an object, or an `{ input, output }` converter) | the schema's own type |
| A raw JSON Schema object (no `~standard` property) | nothing — args reach the handler as sent | the object, verbatim | `Record<string, unknown>`, or `T` via `jsonSchema<T>()` |
| Standard Schema **without** an exporter — bare zod 3, plain valibot | `~standard.validate` | nothing — throws in dev (see below) | the schema's own type |

A Standard Schema does not have to be a plain object: arktype's `Type` is callable, and is detected the same way (anything carrying `~standard.validate`).

Whatever form you use, an **input schema must be object-typed at its root** to be callable over MCP — a root `enum`, `const`, `$ref`, or `anyOf` is legal JSON Schema but leaves the agent with no named arguments to pass.

Appduct has no third-party runtime dependencies and does not bundle a JSON Schema validator, so a raw JSON Schema describes the tool for the agent but never enforces anything. Use a pair when you want both a real shape *and* real validation.

The wire field is documented as draft 2020-12, but Appduct forwards whatever you supply as-is — it does not normalize, re-target, or check the dialect, and different libraries emit different JSON Schema for the same shape (draft version, `additionalProperties`, how `default` is handled). Pick the target closest to 2020-12 that your converter offers.

**Zod 3** — pair the schema with `zod-to-json-schema`:

```ts
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const sumInput = z.object({ a: z.number(), b: z.number() });

registerTool({
  name: "sum",
  description: "Add two numeric values",
  // `zod-to-json-schema` has no 2020-12 target; 2019-09 is the closest it offers, and its
  // default (`jsonSchema7`) stamps a draft-07 `$schema`. Either is understood in practice.
  inputSchema: {
    schema: sumInput,
    jsonSchema: zodToJsonSchema(sumInput, { target: "jsonSchema2019-09" }),
  },
  handler: async ({ a, b }) => undefined, // `a` and `b` are still typed `number`
});
```

**Valibot** — the same shape, with `@valibot/to-json-schema`:

```ts
import * as v from "valibot";
import { toJsonSchema } from "@valibot/to-json-schema";

const sumInput = v.object({ a: v.number(), b: v.number() });
const inputSchema = { schema: sumInput, jsonSchema: toJsonSchema(sumInput) };
```

**No validation library at all** — hand over JSON Schema directly. `jsonSchema<T>()` is an optional, purely type-level helper that tells the handler what to expect; it validates nothing:

```ts
import { jsonSchema, registerTool } from "@appduct/react-native";

registerTool({
  name: "weather",
  description: "Current weather for a city",
  inputSchema: jsonSchema<{ city: string }>({
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  }),
  handler: async ({ city }) => fetchWeather(city),
});
```

If your JSON Schema value is typed as an *interface* (`JSONSchema7` from `@types/json-schema`, for instance), TypeScript will not accept it directly — interfaces do not get the implicit index signature that `Record<string, unknown>` requires. Pass it through `jsonSchema<T>()`, or cast it.

**What is rejected.** A raw schema must be a *plain* object — an object literal or `Object.create(null)`, not a class instance — and its `type`, if it has one, must be a real JSON Schema type name (or an array of them). `{}` is fine: it's the canonical accept-anything schema. This rules out passing a validator from a library with no Standard Schema support (yup, joi, superstruct, valibot 0.x): those instances carry a `type` on their *prototype*, so a looser check would publish one as the tool's shape, and their internal circular references would then break serialization of the entire tool registry rather than just that tool.

An object mentioning `schema` or `jsonSchema` that is not a valid pair is rejected too — `{ schema: someJsonSchema, jsonSchema }` and a lone `{ jsonSchema }` are malformed pairs, and publishing them verbatim would make the wrapper itself the tool's advertised shape. The `jsonSchema` half of a pair, and anything a converter returns, must satisfy the same plain-object rule.

All of these throw a `TypeError` at registration naming what to fix.

**A Standard Schema with no exporter throws in development.** A bare zod 3 or plain valibot schema on its own has no JSON Schema to export — used to register a tool with no shape at all, which agents saw as "takes any object" while the tool looked fine and was unusable. In `__DEV__` this now throws at `registerTool` with a message pointing at the two forms above, including when the call comes from `useAppductTool`, where the throw surfaces from the component's effect. Release builds keep a softer fallback (one console warning per tool name, tool registered without a schema), so an app already shipping such a tool doesn't break on upgrade.

## Registration is per mount, not per render

The hook registers once when the component mounts and re-registers only when something that changes the registration itself changed: `name`, `description`, the exported input/output JSON Schemas, `annotations`, `timeoutMs`, or `enabled`. Re-rendering the component — including on every keystroke of some unrelated state — sends nothing over the wire.

**Your handler is always fresh.** The hook registers a stable wrapper that forwards to the handler from the latest render, so a handler that closes over component state sees the current value on the next call without being re-registered and without `useRef` workarounds:

```ts
const [cartId, setCartId] = useState<string | null>(null);

useAppductTool({
  name: "seed_cart",
  description: "Fill the current cart with test items",
  inputSchema: z.object({ items: z.number() }),
  // Reads whatever `cartId` was on the most recent render, no re-registration involved.
  handler: async ({ items }) => ({ cartId, added: items }),
});
```

**Hoisting schemas is a small optimization, not a requirement.** Schemas are compared by object identity first, so a schema defined at module scope (or wrapped in `useMemo`) is never re-exported to JSON Schema. A schema built inline in the component body is re-exported once per render to compare its shape — the same cost the old unconditional re-registration already paid — and still does not re-register unless the shape actually changed. Hoisting is worth a moment's thought for a hot component. (Builds that swap in the inert `/noop` entry never do any of this: that entry has no exporter at all, so it neither runs nor bundles JSON Schema export.)

A schema that does **not** export JSON Schema (zod 3, plain valibot — the same ones that get the "shapeless tool" dev warning) has no shape to compare, so it falls back to object identity: adding, swapping, or removing one always re-registers, and one rebuilt inline on every render therefore re-registers on every render. Hoist it, or move to zod v4, whose built-in exporter puts it back on the cheap by-shape path.

Because exportable schemas are compared by their *exported* JSON Schema, the registry keeps the schema objects from the most recent registration: replacing one with an identity-different schema that exports the same JSON Schema keeps validating against the earlier object. That only matters for a validation rule JSON Schema cannot express *and* that closes over changing state (a `.refine()` reading component state, say) — pass `deps` for that case.

**Two mounted hooks registering the same tool name** are not a supported configuration (the registry dev-warns and the later registration overwrites the earlier). One consequence is worth knowing: when the later hook unmounts, the earlier one no longer re-claims the name on its next render, so the tool stays unregistered until that hook re-registers for its own reasons. Give each tool one owner.

**`deps` is an optional, advanced override.** Passing it replaces the derived key entirely with `useEffect`'s own semantics (`enabled` is still appended), which is occasionally useful — for example, forcing a re-registration on something the descriptor doesn't capture. Most call sites should simply omit it. Pass it consistently if you pass it at all: alternating between passing `deps` and omitting it changes the dependency-array length between renders, which React warns about, exactly as it does for a hand-written `useEffect`.

## Make the input schema accept an object

A tool call always passes its arguments as a JSON object. An `inputSchema` whose root type is something else — `z.string()`, `z.number()`, `z.array(...)` — can never be satisfied, and registering one logs a dev warning naming the tool. Wrap the value instead: `inputSchema: z.object({ sku: z.string() })` rather than `z.string()`.

Unions and intersections of objects work: `z.union([...])`, `z.discriminatedUnion(...)` and `z.intersection(a, b)` export with no root `type`, and an object argument can still match one of their branches. The one-line signature in `appduct tools` shows their arguments as `(...)`, though, so an agent has to read the full schema (`appduct tools <name>`, or `appduct_describe_tool` over MCP) before it can call them. A single `z.object(...)` gives agents named arguments straight from the listing.

`outputSchema` has no such limit. A result can be any JSON value, and agents see the schema exactly as you wrote it.

## Long-running tools

A tool call gets 10 seconds by default. Declaring `timeoutMs` on the registration is the *only* way to raise that — for a real `login()`, or a `seedCart()` that hits your backend:

```ts
useAppductTool(
  {
    name: "login",
    description: "Signs a test user in against the real backend",
    timeoutMs: 60_000,
    handler: async ({ userId }, { signal }) => loginAsUser(userId, { signal }),
  },
  []
);
```

That deadline is enforced end to end: the app aborts the handler's `signal` at it, and it also travels to the daemon as the descriptor's `timeout_ms`, so an agent calling the tool over MCP (or `appduct invoke` with no `--timeout`) gets the same budget instead of a `tool_timeout` at 10 seconds.

The SDK clamps the value to `[1_000, 600_000]` ms before either timer is set, so the handler's abort timer and the daemon's call deadline are always the same number (a value outside that range is clamped with a dev warning). A caller that passes its own timeout (`appduct invoke --timeout`, `app.call(name, args, { timeoutMs })`) can only **shorten** the deadline, never extend it past this one — the app aborts the handler at its own timer regardless, so for a tool that declares nothing, a caller asking for 60 seconds still gets the app's 10-second default. `createAppductClient`'s `defaultToolTimeoutMs` changes only that app-side fallback for tools that declare nothing; it is deliberately not sent to the daemon, so declare `timeoutMs` per tool when the host needs to know.
