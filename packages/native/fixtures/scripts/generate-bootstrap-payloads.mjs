#!/usr/bin/env node
// Regenerates packages/native/fixtures/bootstrap-payloads.json.
//
// Run from the repository root, after `pnpm build` (this script imports the *built*
// @cordierite/shared output, not its TypeScript source):
//
//   node packages/native/fixtures/scripts/generate-bootstrap-payloads.mjs
//
// Positive vectors are produced with @cordierite/shared's own `encodeBootstrap`, so they are
// guaranteed to be well-formed per docs/PROTOCOL.md §2. Negative vectors are built by hand from
// raw bytes (this script's own `encodeRawBootstrap` helper below, deliberately independent of
// `encodeBootstrap`) so that each one is corrupted in exactly one documented way, then base64url
// encoded the same way the wire format requires (RFC 4648 §5, no padding).
//
// See ../README.md for the fixture's shape and the rule that any change to the bootstrap wire
// format (docs/PROTOCOL.md §2, packages/shared/src/domains/bootstrap.ts) must regenerate this
// file and keep it passing in all three conformance suites.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { encodeBootstrap } from "../../../shared/dist/index.js";

const OUTPUT_PATH = fileURLToPath(new URL("../bootstrap-payloads.json", import.meta.url));

const TOKEN_A = new Uint8Array(32).fill(0x01);
const TOKEN_B = new Uint8Array(32).fill(0x02);

const base64url = (bytes) => Buffer.from(bytes).toString("base64url");
const tokenToBase64Url = (bytes) => base64url(bytes);

// --- helpers for the positive (encodeBootstrap-generated) vectors ---

const buildValid = (name, payload) => {
  const base64urlValue = encodeBootstrap(payload);

  return {
    name,
    base64url: base64urlValue,
    expected: {
      family: payload.family,
      address: payload.address,
      port: payload.port,
      sessionId: payload.sessionId,
      tokenBase64url: payload.token,
      expiresAt: payload.expiresAt,
    },
  };
};

const positives = [
  buildValid("ipv4-basic", {
    family: 4,
    address: "192.168.1.10",
    port: 8443,
    sessionId: "session-1",
    token: tokenToBase64Url(TOKEN_A),
    expiresAt: 4_000_000_000,
  }),
  buildValid("ipv4-loopback-emulator-fast-path", {
    family: 4,
    address: "127.0.0.1",
    port: 8443,
    sessionId: "XzAERP54_Goh74hZ",
    token: tokenToBase64Url(TOKEN_B),
    expiresAt: 4_000_000_000,
  }),
  buildValid("ipv6-basic", {
    family: 6,
    address: "fd00::1",
    port: 8443,
    sessionId: "session-ipv6",
    token: tokenToBase64Url(TOKEN_A),
    expiresAt: 4_000_000_000,
  }),
  buildValid("ipv6-loopback", {
    family: 6,
    address: "::1",
    port: 9999,
    sessionId: "s",
    token: tokenToBase64Url(TOKEN_B),
    expiresAt: 4_000_000_000,
  }),
  buildValid("session-id-min-length-1", {
    family: 4,
    address: "10.0.0.1",
    port: 1,
    sessionId: "a",
    token: tokenToBase64Url(TOKEN_A),
    expiresAt: 1,
  }),
  buildValid("session-id-max-port-65535", {
    family: 4,
    address: "172.16.0.1",
    port: 65_535,
    sessionId: "session-max-port",
    token: tokenToBase64Url(TOKEN_B),
    expiresAt: 4_000_000_000,
  }),
  buildValid("session-id-multibyte-utf8", {
    family: 4,
    address: "192.168.0.42",
    port: 8443,
    sessionId: "sesión-héllo-日本語",
    token: tokenToBase64Url(TOKEN_A),
    expiresAt: 4_000_000_000,
  }),
  buildValid("session-id-255-bytes", {
    family: 4,
    address: "192.168.0.43",
    port: 8443,
    sessionId: "s".repeat(255),
    token: tokenToBase64Url(TOKEN_B),
    expiresAt: 4_000_000_000,
  }),
];

// --- helpers for the hand-corrupted (negative) vectors ---
//
// Deliberately independent of `encodeBootstrap`/`decodeBootstrap`: these build the exact byte
// layout from docs/PROTOCOL.md §2 by hand so a corruption can be introduced at a specific byte
// without going through (and being rejected by) the real encoder.

const ipv4ToBytes = (ip) => new Uint8Array(ip.split(".").map(Number));

const u16be = (value) => new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);

const u64beSeconds = (value) => {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, BigInt(value), false);
  return out;
};

const concatBytes = (...chunks) => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

const validRawLayout = () =>
  concatBytes(
    new Uint8Array([0x02, 0x04]), // version 2, family ipv4
    ipv4ToBytes("192.168.1.10"),
    u16be(8_443),
    new Uint8Array([9]), // sessionId length
    new TextEncoder().encode("session-1"),
    TOKEN_A,
    u64beSeconds(4_000_000_000),
  );

const negatives = [
  {
    name: "v1-version-byte",
    base64url: base64url(concatBytes(new Uint8Array([0x01]), validRawLayout().slice(1))),
  },
  {
    name: "unknown-family-byte",
    base64url: base64url(concatBytes(new Uint8Array([0x02, 0x99]), validRawLayout().slice(2))),
  },
  {
    name: "truncated-buffer",
    // Drops the last 10 bytes (part of the token + all of expiresAt) -- fails the exact
    // total-length check in decodeBootstrap.
    base64url: base64url(validRawLayout().slice(0, validRawLayout().length - 10)),
  },
  {
    name: "oversized-buffer",
    // Appends trailing garbage after an otherwise-valid layout -- also fails the exact
    // total-length check (decodeBootstrap has no notion of "extra bytes are OK").
    base64url: base64url(concatBytes(validRawLayout(), new Uint8Array([0xde, 0xad, 0xbe, 0xef]))),
  },
  {
    name: "zero-length-session-id",
    base64url: base64url(
      concatBytes(
        new Uint8Array([0x02, 0x04]),
        ipv4ToBytes("192.168.1.10"),
        u16be(8_443),
        new Uint8Array([0]), // sessionId length = 0
        TOKEN_A,
        u64beSeconds(4_000_000_000),
      ),
    ),
  },
  {
    name: "invalid-utf8-session-id",
    base64url: base64url(
      concatBytes(
        new Uint8Array([0x02, 0x04]),
        ipv4ToBytes("192.168.1.10"),
        u16be(8_443),
        new Uint8Array([2]), // sessionId length = 2
        new Uint8Array([0xff, 0xfe]), // not valid UTF-8
        TOKEN_A,
        u64beSeconds(4_000_000_000),
      ),
    ),
  },
  {
    name: "port-zero",
    base64url: base64url(
      concatBytes(
        new Uint8Array([0x02, 0x04]),
        ipv4ToBytes("192.168.1.10"),
        u16be(0),
        new Uint8Array([9]),
        new TextEncoder().encode("session-1"),
        TOKEN_A,
        u64beSeconds(4_000_000_000),
      ),
    ),
  },
  {
    name: "empty-buffer",
    base64url: base64url(new Uint8Array(0)),
  },
  {
    name: "single-byte-buffer",
    // Shorter than the 2-byte version+family header decodeBootstrap requires before it even
    // reads the family byte.
    base64url: base64url(new Uint8Array([0x02])),
  },
].map((vector) => ({ ...vector, expected: null }));

const vectors = [...positives, ...negatives];

writeFileSync(OUTPUT_PATH, `${JSON.stringify(vectors, null, 2)}\n`, "utf8");

console.log(`Wrote ${vectors.length} bootstrap-payload vectors to ${OUTPUT_PATH}`);
