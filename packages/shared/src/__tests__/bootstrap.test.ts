import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { decodeBootstrap, encodeBootstrap, type BootstrapPayload } from "../domains/bootstrap.js";
import { formatAgentWebSocketUrl } from "../domains/transport.js";

const rawToken = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

const encodeToken = (bytes: Uint8Array): string => {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return globalThis.btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll(/=+$/gu, "");
};

const ipv4Payload = (): BootstrapPayload => ({
  family: 4,
  address: "192.168.1.10",
  port: 8443,
  sessionId: "session-abc",
  token: encodeToken(rawToken(7)),
  expiresAt: 1_800_000_000,
});

const ipv6Payload = (): BootstrapPayload => ({
  family: 6,
  address: "fd00::1",
  port: 8443,
  sessionId: "session-xyz",
  token: encodeToken(rawToken(9)),
  expiresAt: 1_800_000_000,
});

type BootstrapPayloadVector = {
  name: string;
  base64url: string;
  expected: (Omit<BootstrapPayload, "token"> & { tokenBase64url: string }) | null;
};

/** The cross-language vectors in `packages/native/fixtures`; rejections are covered by fixtures-conformance. */
const validFixtureVectors = (
  JSON.parse(
    readFileSync(fileURLToPath(new URL("../../../native/fixtures/bootstrap-payloads.json", import.meta.url)), "utf8"),
  ) as BootstrapPayloadVector[]
).flatMap(({ name, base64url, expected }) => {
  if (expected === null) {
    return [];
  }

  const { tokenBase64url, ...rest } = expected;
  const payload: BootstrapPayload = { ...rest, token: tokenBase64url };
  return [{ name, base64url, payload }];
});

describe("encodeBootstrap / decodeBootstrap", () => {
  test("round-trips an IPv4 payload byte-for-byte", () => {
    const payload = ipv4Payload();
    const encoded = encodeBootstrap(payload);
    expect(decodeBootstrap(encoded)).toEqual(payload);
  });

  test("round-trips an IPv6 payload byte-for-byte", () => {
    const payload = ipv6Payload();
    const encoded = encodeBootstrap(payload);
    expect(decodeBootstrap(encoded)).toEqual(payload);
  });

  test("round-trips a compressible IPv6 address", () => {
    const payload = { ...ipv6Payload(), address: "::1" };
    const encoded = encodeBootstrap(payload);
    expect(decodeBootstrap(encoded)).toEqual(payload);
  });

  test.each(validFixtureVectors.map((vector) => [vector.name, vector] as const))(
    "encodes %s to the fixture's exact bytes",
    (_name, vector) => {
      expect(encodeBootstrap(vector.payload)).toBe(vector.base64url);
    },
  );

  test("rejects port 0", () => {
    expect(() => encodeBootstrap({ ...ipv4Payload(), port: 0 })).toThrow();
  });

  test("rejects garbage input", () => {
    expect(decodeBootstrap("not-valid-base64url!!!")).toBeNull();
    expect(decodeBootstrap("")).toBeNull();
  });

  test("encodeBootstrap rejects a token that is not exactly 32 raw bytes", () => {
    expect(() => encodeBootstrap({ ...ipv4Payload(), token: "short" })).toThrow();
  });
});

describe("formatAgentWebSocketUrl", () => {
  test("formats IPv4 without brackets", () => {
    expect(formatAgentWebSocketUrl({ family: 4, address: "192.168.1.10", port: 8443 })).toBe(
      "wss://192.168.1.10:8443",
    );
  });

  test("brackets IPv6 literals", () => {
    expect(formatAgentWebSocketUrl({ family: 6, address: "fd00::1", port: 8443 })).toBe("wss://[fd00::1]:8443");
  });
});
