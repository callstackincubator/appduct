# Writing Appduct tools

Read this when the task is to register tools in an app, or to review the tools it already has.
The tools you write are what a calling agent sees in `appduct tools`; write them for that reader.

## Register a tool

React Native (`@appduct/react-native`), with zod 4:

```ts
import { useAppductTool } from "@appduct/react-native";
import { z } from "zod";

useAppductTool({
  name: "seed_cart",
  description: "Fill the current user's cart with test items. Requires a signed-in user.",
  group: "cart",
  inputSchema: z.object({
    items: z.number().int().min(1).max(50).describe("How many distinct SKUs to add"),
    clear: z.boolean().default(true).describe("Empty the cart first"),
  }),
  outputSchema: z.object({ cartId: z.string(), itemCount: z.number() }),
  timeoutMs: 30_000,
  handler: async ({ items, clear }) => cart.seed({ items, clear }),
});
```

`useAppductTool` registers once per mount and re-registers only when the descriptor changes;
the handler always sees the latest render's state, so no refs or `deps` are needed. Outside
React, `registerTool({...})` takes the same object and returns `{ remove() }`. Give each tool
one owner. `createToolGroup("cart")` returns a `registerTool` bound to a group.

Swift (`AppductCore`) and Kotlin (`com.callstack.appduct:core`) take the same fields with raw
JSON Schema:

```swift
try Appduct.shared.register(
  name: "get_cart", description: "Return the current cart. Read-only.",
  outputSchema: ["type": "object", "properties": ["itemCount": ["type": "integer"]]],
  annotations: ToolAnnotations(readOnlyHint: true), group: "cart"
) { _ in ["itemCount": await store.cart.count] }
```

```kotlin
Appduct.register(
  name = "reset_app", description = "Clear all local data and sign out.",
  outputSchema = JSONObject("""{"type":"object","properties":{"cleared":{"type":"boolean"}}}"""),
  annotations = ToolAnnotations(destructiveHint = true, idempotentHint = true),
) { _ -> JSONObject().put("cleared", store.reset()) }
```

## Schema rules

| `inputSchema` / `outputSchema` form | Validated in app | What agents see |
| --- | --- | --- |
| Standard Schema with a JSON Schema exporter: **zod 4**, arktype | yes | the exported JSON Schema |
| `{ schema, jsonSchema }` pair: zod 3 + `zod-to-json-schema`, valibot + `@valibot/to-json-schema` | yes | the `jsonSchema` you supply |
| Raw JSON Schema object (optionally `jsonSchema<T>()` for typing) | **no** | the object verbatim |

- A bare zod 3 or plain valibot schema **throws in dev**: it would publish a shapeless tool.
- The input schema must accept a JSON object; a root string, number or array can never be
  satisfied. Prefer a single `z.object(...)`: a root union shows as `(...)` in the listing and
  forces the agent to fetch the full schema first.
- Names: `[a-zA-Z0-9_-]`, at most 64. Groups: `cart` or one subgroup `checkout/payment`, same
  characters; anything deeper throws.
- `timeoutMs` (1,000–600,000; default 10,000) is the only way to give a call more time. Callers
  can shorten it, never extend it.

## Design tools for the agent that will call them

An agent sees `name(params) -> result` plus the first line of the description, and decides from
that alone. Each rule below fixes a specific way that decision goes wrong.

1. **Name by intent, not implementation.** `go_to_checkout`, `set_feature_flag`, `seed_cart`.
   Not `dispatch_action`, `run_effect`, `do_checkout(json)`.
2. **Set `annotations`.** `readOnlyHint: true` on every observer; `destructiveHint: true` on
   anything that deletes, logs out, resets or pays. The daemon's policy and the MCP client's
   permission prompt key on `destructiveHint`; an unmarked destructive tool is silently allowed.
3. **Pair every mutation with an observer, and return the new state from the mutation.**
   `seed_cart -> { cartId, itemCount }` plus `get_cart` lets the agent verify in one call and
   re-check later.
4. **Declare an `outputSchema`, object-rooted.** It is what puts `-> { ... }` in the listing;
   without it the agent has to call the tool to learn what comes back. Wrap a scalar:
   `{ count: number }`, not `number`.
5. **First line of the description: one sentence, what it does.** Then preconditions and side
   effects: "Requires a signed-in user. Navigates to the Cart tab." Name the screen or feature so
   `--filter` finds it.
6. **Describe every parameter** (`.describe()` in zod, `description` in JSON Schema) with units
   and allowed values. Prefer enums over free strings: `tab: "home" | "cart" | "profile"`.
7. **Make setup tools idempotent and say so.** `login(userId)` is a no-op when already signed in
   as that user; mark it `idempotentHint: true`. The agent can then retry safely.
8. **Prefer a few coarse tools over many fine ones.** `complete_onboarding()` beats
   `dismiss_step_1` … `dismiss_step_7`. A long tool list costs the agent more than a wide tool.
9. **Declare `timeoutMs` on anything that touches the network.** The default is 10 s.
10. **Never register a tool that needs a person to finish.** A tool that opens a modal and
    resolves when someone taps will time out. Return once the state change is done; if something
    happens later, `postEvent("checkout_completed", {...})` and let the caller wait for it.
11. **Group once the app has more than a screenful of tools**, by feature (`cart`, `checkout`),
    so an agent lists one area instead of everything.

Before and after:

```ts
// Before: the listing shows `checkout(payload: ...)` and the word "Checkout"; nothing says what happens.
registerTool({ name: "checkout", description: "Checkout", inputSchema: z.object({ payload: z.any() }),
  handler: async ({ payload }) => runCheckout(payload) });

// After: `place_order(paymentMethod: "card" | "apple_pay" = "card") -> { orderId: string, total: number }  [destructive]`
registerTool({
  name: "place_order",
  description: "Place an order for the current cart and navigate to the confirmation screen. Requires a signed-in user with a non-empty cart. Charges the test payment method.",
  group: "checkout",
  inputSchema: z.object({
    paymentMethod: z.enum(["card", "apple_pay"]).default("card").describe("Saved test payment method to charge"),
  }),
  outputSchema: z.object({ orderId: z.string(), total: z.number().describe("Order total in cents") }),
  annotations: { destructiveHint: true },
  timeoutMs: 30_000,
  handler: async ({ paymentMethod }) => checkout.placeOrder(paymentMethod),
});
```

**Read it back.** After registering, connect a device and run `appduct tools` (or
`appduct_list_tools`). Fix any `...` in a signature, any tool without `-> { ... }`, and any
description whose first line does not say what the tool needs. That listing is exactly what the
calling agent gets.
