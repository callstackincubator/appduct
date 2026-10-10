import { describe, expect, test } from "vitest";

import { isKnownErrorType, isToolErrorType } from "../domains/errors.js";

// Written out by hand, not read from ERROR_TYPES / TOOL_ERROR_TYPES, so dropping a type from the
// source fails here instead of silently shrinking the list under test.
const TOOL_ERROR_TYPE_NAMES = [
  "tool_not_found",
  "tool_input_validation_error",
  "tool_output_validation_error",
  "tool_execution_error",
  "tool_serialization_error",
  "tool_timeout",
  "tool_cancelled",
];

const ERROR_TYPE_NAMES = [
  "no_session",
  "ambiguous_session",
  "unknown_session",
  "session_not_active",
  ...TOOL_ERROR_TYPE_NAMES,
  "session_suspended",
  "policy_denied",
  "invalid_request",
];

describe("isKnownErrorType", () => {
  test.each(ERROR_TYPE_NAMES.map((type) => [type] as const))("accepts %s", (type) => {
    expect(isKnownErrorType(type)).toBe(true);
  });

  test("rejects an unknown string", () => {
    expect(isKnownErrorType("something_else")).toBe(false);
  });

  test("rejects non-strings", () => {
    expect(isKnownErrorType(42)).toBe(false);
    expect(isKnownErrorType(null)).toBe(false);
    expect(isKnownErrorType(undefined)).toBe(false);
  });
});

describe("isToolErrorType", () => {
  test.each(TOOL_ERROR_TYPE_NAMES.map((type) => [type] as const))("accepts %s", (type) => {
    expect(isToolErrorType(type)).toBe(true);
  });

  test("rejects a known error type outside the tool_* subset", () => {
    expect(isToolErrorType("no_session")).toBe(false);
    expect(isToolErrorType("policy_denied")).toBe(false);
  });
});
