import { describe, expect, test } from "vitest";

import { isEventDescriptor, MAX_EVENT_NAME_LENGTH, type EventDescriptor } from "../domains/event-descriptor.js";
import { MAX_TOOL_DESCRIPTION_LENGTH } from "../domains/tool-descriptor.js";

const validEvent = (): EventDescriptor => ({
  name: "checkout_completed",
  description: "Fired once an order finishes checkout.",
});

describe("isEventDescriptor", () => {
  test("accepts a minimal valid descriptor", () => {
    expect(isEventDescriptor(validEvent())).toBe(true);
  });

  test("accepts a dotted name a tool would reject", () => {
    expect(isEventDescriptor({ ...validEvent(), name: "cart.item_added" })).toBe(true);
  });

  test("accepts a payload_schema", () => {
    expect(
      isEventDescriptor({
        ...validEvent(),
        payload_schema: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] },
      }),
    ).toBe(true);
  });

  test("rejects a non-object value without throwing", () => {
    expect(() => isEventDescriptor(null)).not.toThrow();
    expect(isEventDescriptor(null)).toBe(false);
    expect(isEventDescriptor("checkout_completed")).toBe(false);
    expect(isEventDescriptor([])).toBe(false);
  });

  test("rejects a missing name", () => {
    const { name: _name, ...rest } = validEvent();
    expect(isEventDescriptor(rest)).toBe(false);
  });

  test("rejects an empty name", () => {
    expect(isEventDescriptor({ ...validEvent(), name: "" })).toBe(false);
  });

  test("rejects a name over the max length", () => {
    expect(isEventDescriptor({ ...validEvent(), name: "x".repeat(MAX_EVENT_NAME_LENGTH + 1) })).toBe(false);
  });

  test("accepts a name at the max length", () => {
    expect(isEventDescriptor({ ...validEvent(), name: "x".repeat(MAX_EVENT_NAME_LENGTH) })).toBe(true);
  });

  test("rejects a missing description", () => {
    const { description: _description, ...rest } = validEvent();
    expect(isEventDescriptor(rest)).toBe(false);
  });

  test("rejects an empty description", () => {
    expect(isEventDescriptor({ ...validEvent(), description: "" })).toBe(false);
  });

  test("rejects a description over the max length", () => {
    expect(isEventDescriptor({ ...validEvent(), description: "x".repeat(MAX_TOOL_DESCRIPTION_LENGTH + 1) })).toBe(
      false,
    );
  });

  test("rejects a non-object payload_schema", () => {
    expect(isEventDescriptor({ ...validEvent(), payload_schema: "not-an-object" })).toBe(false);
    expect(isEventDescriptor({ ...validEvent(), payload_schema: [] })).toBe(false);
  });
});
