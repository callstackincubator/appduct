import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { decodeBootstrap } from "../domains/bootstrap.js";
import { isToolDescriptor } from "../domains/tool-descriptor.js";

/**
 * Cross-language conformance fixtures (issue #48, "Parity is the risk"): every vector here also
 * loads and asserts in Swift (`packages/native/ios/Tests/AppductCoreTests/FixturesConformanceTests.swift`)
 * and Kotlin (`packages/native/android/core/src/test/.../FixturesConformanceTest.kt`) against
 * their own implementations of the same rules. See `packages/native/fixtures/README.md` for the
 * rule that a divergence found this way is fixed in the implementation, never in the fixture.
 */
const FIXTURES_DIR = fileURLToPath(new URL("../../../native/fixtures/", import.meta.url));

const loadFixture = <T>(name: string): T => JSON.parse(readFileSync(`${FIXTURES_DIR}${name}`, "utf8")) as T;

type BootstrapPayloadVector = {
  name: string;
  base64url: string;
  expected: {
    family: 4 | 6;
    address: string;
    port: number;
    sessionId: string;
    tokenBase64url: string;
    expiresAt: number;
  } | null;
};

describe("fixtures-conformance: bootstrap-payloads.json (decodeBootstrap)", () => {
  const vectors = loadFixture<BootstrapPayloadVector[]>("bootstrap-payloads.json");

  test("the fixture is non-empty", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  test.each(vectors.map((vector) => [vector.name, vector] as const))("%s", (_name, vector) => {
    const decoded = decodeBootstrap(vector.base64url);

    if (vector.expected === null) {
      expect(decoded).toBeNull();
      return;
    }

    expect(decoded).not.toBeNull();
    expect(decoded?.family).toBe(vector.expected.family);
    expect(decoded?.address).toBe(vector.expected.address);
    expect(decoded?.port).toBe(vector.expected.port);
    expect(decoded?.sessionId).toBe(vector.expected.sessionId);
    expect(decoded?.token).toBe(vector.expected.tokenBase64url);
    expect(decoded?.expiresAt).toBe(vector.expected.expiresAt);
  });
});

type BootstrapLinkVector = {
  name: string;
  url: string;
  expected: { payloadIndex: number; pin: string | null };
};

/** Same shape `packages/react-native/src/bootstrap.ts`'s `extractLinkPin` validates against. */
const LINK_PIN_PATTERN = /^sha256\/[A-Za-z0-9+/]{43}=$/u;

describe("fixtures-conformance: bootstrap-links.json (deep link appduct+pin extraction)", () => {
  const payloadVectors = loadFixture<BootstrapPayloadVector[]>("bootstrap-payloads.json");
  const linkVectors = loadFixture<BootstrapLinkVector[]>("bootstrap-links.json");

  test("the fixture is non-empty", () => {
    expect(linkVectors.length).toBeGreaterThan(0);
  });

  test.each(linkVectors.map((vector) => [vector.name, vector] as const))("%s", (_name, vector) => {
    const url = new URL(vector.url);
    const appductParam = url.searchParams.get("appduct");

    expect(appductParam).not.toBeNull();
    expect(appductParam).toBe(payloadVectors[vector.expected.payloadIndex]?.base64url);

    const rawPin = url.searchParams.get("pin");
    const pin = rawPin !== null && LINK_PIN_PATTERN.test(rawPin) ? rawPin : null;

    expect(pin).toBe(vector.expected.pin);
  });
});

type ToolDescriptorVector = {
  name: string;
  descriptor: unknown;
  valid: boolean;
};

describe("fixtures-conformance: tool-descriptors.json (isToolDescriptor)", () => {
  const vectors = loadFixture<ToolDescriptorVector[]>("tool-descriptors.json");

  test("the fixture is non-empty", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  test.each(vectors.map((vector) => [vector.name, vector] as const))("%s", (_name, vector) => {
    expect(isToolDescriptor(vector.descriptor)).toBe(vector.valid);
  });
});

type CloseCodeVector = {
  code: number | null;
  reason: string | null;
  terminal: boolean;
};

/**
 * `@appduct/shared`/`@appduct/react-native` no longer implement terminal-close
 * classification themselves (it moved to native in issue #48 phase 2 — see
 * `docs/tasks/15-native-session-logic.md`'s "Deleted" section for `client/terminal-close.ts`).
 * This suite still loads and asserts the fixture, both to keep it self-consistent with
 * `docs/PROTOCOL.md` §7 and so a future JS-side consumer of this rule has a passing reference
 * implementation to copy. The Swift and Kotlin suites assert the same fixture against their own
 * production `isTerminalCloseEvent`/`isAppductTerminalCloseCode` functions.
 */
const POLICY_VIOLATION_CLOSE_CODE = 1008;
const isTerminalCloseCode = (code: number | null): boolean => code === POLICY_VIOLATION_CLOSE_CODE;

describe("fixtures-conformance: close-codes.json (terminal-close classification)", () => {
  const vectors = loadFixture<CloseCodeVector[]>("close-codes.json");

  test("the fixture is non-empty", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  test.each(vectors.map((vector, index) => [`${index}: ${vector.code ?? "null"} ${vector.reason ?? "null"}`, vector] as const))(
    "%s",
    (_name, vector) => {
      expect(isTerminalCloseCode(vector.code)).toBe(vector.terminal);
    },
  );

  test("exactly one close code value (1008) is ever terminal", () => {
    for (const vector of vectors) {
      if (vector.terminal) {
        expect(vector.code).toBe(1008);
      }
    }
  });
});
