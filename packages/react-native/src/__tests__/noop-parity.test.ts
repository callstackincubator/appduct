import { describe, expect, vi, test } from "vitest";
import { z as z3 } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { AppductDisabledError } from "../Appduct.types";
import type { AppductPublicApi } from "../public-api";

(globalThis as { __DEV__?: boolean }).__DEV__ = true;

/** Compile-time assertion that `value` is exactly `T` (invariant, so a widened arg type fails). */
const expectType = <T>(value: T): T => value;

// The root (`.`) entry pulls in `react-native` (for `AppState`/`Linking`), whose own source cannot
// be parsed under a Node test runner (Flow-typed; see `deep-link-install.test.ts`); `./noop` never
// touches `react-native` at all, but this file imports both entries side by side, so the mock is
// needed regardless.
vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove() {} }),
  },
  Linking: {
    getInitialURL: () => Promise.resolve(null),
    addEventListener: () => ({ remove() {} }),
  },
}));

describe("noop parity: type-level (see also public-api.ts's doc comment)", () => {
  test("both entries structurally satisfy AppductPublicApi", async () => {
    const realModule = await import("../index");
    const noopModule = await import("../noop");
    const webModule = await import("../index.web");

    // The meaningful check here is `tsc` (`pnpm run build`) accepting these two assignments —
    // Vitest strips types at runtime, so this is a signpost for the reader, not the enforcement,
    // mirroring
    // `connect-options-parity.test.ts`'s pattern.
    const realSatisfiesPublicApi: AppductPublicApi = realModule;
    const noopSatisfiesPublicApi: AppductPublicApi = noopModule;
    const webSatisfiesPublicApi: AppductPublicApi = webModule;

    const names: (keyof AppductPublicApi)[] = [
      "registerTool",
      "createToolGroup",
      "useAppductTool",
      "jsonSchema",
      "postEvent",
      "registerEvent",
      "getRegisteredTools",
      "addAppductListener",
      "restoreSession",
      "getAppductState",
      "connect",
      "getAppductBuildConfig",
    ];
    for (const name of names) {
      expect(typeof realSatisfiesPublicApi[name]).toBe("function");
      expect(typeof noopSatisfiesPublicApi[name]).toBe("function");
      expect(typeof webSatisfiesPublicApi[name]).toBe("function");
    }
  });

  test("a group-bound registrar infers handler args and refuses a group override on both entries", async () => {
    const realModule = await import("../index");
    const noopModule = await import("../noop");

    const zod3Input = z3.object({ a: z3.number() });
    const pairedSchema = {
      schema: zod3Input,
      jsonSchema: zodToJsonSchema(zod3Input) as Record<string, unknown>,
    };

    // The enforcement is `tsc`: `createToolGroup` from either entry must infer the paired schema's
    // own output type, and refuse a registration that tries to set its own `group`.
    const groupFactories: AppductPublicApi["createToolGroup"][] = [
      realModule.createToolGroup,
      noopModule.createToolGroup,
    ];

    for (const createToolGroup of groupFactories) {
      const registerCartTool = createToolGroup("cart");

      registerCartTool({
        name: "grouped-paired",
        description: "d",
        inputSchema: pairedSchema,
        handler: (args) => {
          expectType<{ a: number }>(args);
        },
      }).remove();

      registerCartTool({
        name: "grouped-override",
        description: "d",
        // @ts-expect-error -- the bound group cannot be overridden per registration.
        group: "other",
        handler: () => undefined,
      }).remove();
    }
  });

  test("useAppductTool takes the same (definition, deps, options) arity on both entries", async () => {
    const realModule = await import("../index");
    const noopModule = await import("../noop");

    // `AppductPublicApi` alone would not catch one entry silently dropping the third `options`
    // parameter — TS structurally accepts a function with fewer parameters where more are
    // expected, so `{ enabled }` support could drift without this failing at the type level.
    // Both entries build `useAppductTool` from the same `createUseAppductTool` factory
    // (see `useAppductTool.ts`), so this asserts that invariant holds rather than merely
    // hoping it does — `.length` reflects the function's declared (non-rest, non-default)
    // parameter count at runtime.
    expect(realModule.useAppductTool.length).toBe(
      noopModule.useAppductTool.length,
    );
    expect(realModule.useAppductTool.length).toBe(3);
  });
});

describe("noop entry: runtime no-op behavior", () => {
  test("registerTool returns a disposer but registers nothing observable", async () => {
    const { registerTool } = await import("../noop");

    const registration = registerTool({
      name: "any-tool",
      description: "d",
      handler: () => "result",
    });

    expect(typeof registration.remove).toBe("function");
    expect(() => registration.remove()).not.toThrow();
  });

  test("postEvent resolves without doing anything", async () => {
    const { postEvent } = await import("../noop");
    await expect(postEvent("anything", { a: 1 })).resolves.toBeUndefined();
  });

  test("addAppductListener returns a disposer; the callback never fires", async () => {
    const { addAppductListener } = await import("../noop");
    let fired = false;

    const subscription = addAppductListener("stateChange", () => {
      fired = true;
    });

    expect(fired).toBe(false);
    expect(() => subscription.remove()).not.toThrow();
  });

  test("getRegisteredTools() always returns an empty array, even after registerTool", async () => {
    const { registerTool, getRegisteredTools } = await import("../noop");

    registerTool({
      name: "any-tool",
      description: "d",
      handler: () => "result",
    });

    expect(getRegisteredTools()).toEqual([]);
  });

  test("restoreSession() always resolves false (no native lease exists)", async () => {
    const { restoreSession } = await import("../noop");
    await expect(restoreSession()).resolves.toBe(false);
  });

  test('getAppductState() always returns "idle"', async () => {
    const { getAppductState } = await import("../noop");
    expect(getAppductState()).toBe("idle");
  });

  test('getAppductBuildConfig() reports the documented "absent" shape', async () => {
    const { getAppductBuildConfig } = await import("../noop");

    expect(getAppductBuildConfig()).toEqual({
      trust: "absent",
      hasEmbeddedPins: false,
      allowPrivateLanOnly: true,
    });
  });

  test("connect() rejects with an AppductDisabledError (code: appduct_disabled)", async () => {
    const { connect } = await import("../noop");

    await expect(
      connect({
        ip: "127.0.0.1",
        port: 8443,
        sessionId: "s",
        token: "a".repeat(43),
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      }),
    ).rejects.toThrow(AppductDisabledError);

    try {
      await connect({
        ip: "127.0.0.1",
        port: 8443,
        sessionId: "s",
        token: "a".repeat(43),
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      });
      throw new Error("expected connect() to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(AppductDisabledError);
      expect((error as AppductDisabledError).code).toBe(
        "appduct_disabled",
      );
    }
  });
});

describe("noop parity: registerEvent", () => {
  test("registerEvent returns a disposer that does nothing", async () => {
    const noopModule = await import("../noop");
    const registration = noopModule.registerEvent({
      name: "checkout_completed",
      description: "An order was paid.",
    });
    expect(() => registration.remove()).not.toThrow();
  });
});
