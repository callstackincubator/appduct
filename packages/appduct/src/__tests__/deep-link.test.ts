import { describe, expect, test } from "vitest";

import { composeDeepLink } from "../link.js";

describe("composeDeepLink", () => {
  test("appends the pin after the bootstrap payload, percent-encoding its +, / and =", () => {
    const result = {
      sessionId: "s-1",
      deepLinkPayload: "AAAA-payload_x",
      endpoint: { address: "192.168.1.10", port: 8443, family: 4 as const },
      expiresAt: 1_800_000_000,
      pin: "sha256/ab+cd/ef=",
    };

    expect(composeDeepLink("appduct", result)).toBe(
      "appduct:///?appduct=AAAA-payload_x&pin=sha256%2Fab%2Bcd%2Fef%3D",
    );
  });
});
