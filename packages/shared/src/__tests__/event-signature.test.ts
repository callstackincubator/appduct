import { describe, expect, test } from "vitest";

import { renderEventSignature } from "../domains/event-signature.js";

describe("renderEventSignature", () => {
  test("renders a bare name for an event with no payload_schema", () => {
    expect(renderEventSignature({ name: "app_ready" })).toBe("app_ready");
  });

  test("renders the design's own example", () => {
    expect(
      renderEventSignature({
        name: "checkout_completed",
        payload_schema: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] },
      }),
    ).toBe("checkout_completed { orderId: string }");
  });

  test("marks an optional property with a trailing ?", () => {
    expect(
      renderEventSignature({
        name: "cart_updated",
        payload_schema: {
          type: "object",
          properties: { itemCount: { type: "integer" }, coupon: { type: "string" } },
          required: ["itemCount"],
        },
      }),
    ).toBe("cart_updated { itemCount: int, coupon?: string }");
  });

  test("renders an empty object payload as {}", () => {
    expect(renderEventSignature({ name: "ping", payload_schema: { type: "object", properties: {} } })).toBe(
      "ping {}",
    );
  });

  test("renders an unrecognised payload shape as {...} rather than throwing", () => {
    expect(() => renderEventSignature({ name: "weird", payload_schema: { anyOf: [{ type: "string" }] } })).not.toThrow();
    expect(renderEventSignature({ name: "weird", payload_schema: { anyOf: [{ type: "string" }] } })).toBe(
      "weird {...}",
    );
  });

  test("never throws for a malformed name", () => {
    expect(() => renderEventSignature({ name: undefined as unknown as string })).not.toThrow();
  });
});
