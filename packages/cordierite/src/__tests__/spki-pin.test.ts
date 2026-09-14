import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  X509Certificate,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { createSpkiPin, getSpkiPinFromPrivateKeyPem } from "../spki-pin.js";

describe("SPKI pin helper", () => {
  test("derives a stable sha256 pin from freshly generated key material", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const keyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString("utf8");

    const pin = getSpkiPinFromPrivateKeyPem(keyPem);

    expect(pin).toMatch(/^sha256\/[A-Za-z0-9+/]+=*$/u);
    // Deterministic for the same key material.
    expect(getSpkiPinFromPrivateKeyPem(keyPem)).toBe(pin);
  });

  test("differs for different keys and matches an independently derived SPKI digest", () => {
    const first = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const second = generateKeyPairSync("rsa", { modulusLength: 2048 });

    const firstPem = first.privateKey.export({ format: "pem", type: "pkcs8" }).toString("utf8");
    const secondPem = second.privateKey.export({ format: "pem", type: "pkcs8" }).toString("utf8");

    expect(getSpkiPinFromPrivateKeyPem(firstPem)).not.toBe(getSpkiPinFromPrivateKeyPem(secondPem));

    const publicKey = createPublicKey(createPrivateKey(firstPem));
    const spkiDer = publicKey.export({ type: "spki", format: "der" });
    const expectedPin = `sha256/${createHash("sha256").update(spkiDer).digest("base64")}`;

    expect(getSpkiPinFromPrivateKeyPem(firstPem)).toBe(expectedPin);
  });
});

/**
 * Cross-language conformance fixture (issue #48, "Parity is the risk"):
 * `packages/native/fixtures/spki-pin.json` holds the one certificate+pin vector that used to be
 * duplicated as a hand-written string literal in `CordieriteConnectionManagerTests.swift` and
 * `CordieriteSpkiPinTest.kt`. Swift and Kotlin assert the same fixture against their own SPKI-pin
 * computation (`spkiPin(for:)` / `computeSpkiPin`) in `FixturesConformanceTests.swift` /
 * `FixturesConformanceTest.kt`. See `packages/native/fixtures/README.md`.
 */
describe("SPKI pin conformance fixture", () => {
  const fixture = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../../native/fixtures/spki-pin.json", import.meta.url)), "utf8"),
  ) as { certificateDerBase64: string; expectedPin: string };

  test("createSpkiPin reproduces the shared fixture's expected pin for its certificate", () => {
    const der = Buffer.from(fixture.certificateDerBase64, "base64");
    const certificate = new X509Certificate(der);
    const spkiDer = certificate.publicKey.export({ type: "spki", format: "der" }) as Buffer;

    expect(createSpkiPin(spkiDer)).toBe(fixture.expectedPin);
  });
});
