import { AppductError, type AppClient } from "appduct/client";
import { describe, expect, it } from "vitest";

import { createMemoryDaemon } from "../memory-daemon.js";
import { pairWith, type PairingDevice } from "../pairing.js";
import type { Clock } from "../session.js";

const clock: Clock = { now: () => 0, sleep: async () => undefined };
const client = { sessionId: "paired" } as AppClient;
const sessionOf = (deepLink: string) => new URL(deepLink).searchParams.get("appduct")!;

/** A device that records what it was asked to do and runs `onOpen` and `onAlert` like an app would. */
const fakeDevice = (onOpen: (sessionId: string) => void = () => {}, onAlert: () => void = () => {}) => {
  const device = {
    opened: [] as string[],
    alerts: 0,
    openLink: async (url: string) => {
      device.opened.push(url);
      onOpen(sessionOf(url));
    },
    alert: async () => {
      device.alerts += 1;
      onAlert();
    },
  };
  return device satisfies PairingDevice;
};

describe("pairing a device", () => {
  it("opens the link on the device and resolves once the app claims it", async () => {
    const fake = createMemoryDaemon();
    const device = fakeDevice((sessionId) => fake.appClaims(sessionId, client));

    expect(await pairWith({ platform: "android", device }, fake.daemon, clock)).toBe(client);
    expect(device.opened).toEqual(["myapp:///?appduct=s1"]);
  });

  it("mints a link that lasts as long as the wait for its claim", async () => {
    const fake = createMemoryDaemon();
    const device = fakeDevice((sessionId) => fake.appClaims(sessionId, client));

    await pairWith({ platform: "android", device }, fake.daemon, clock);

    expect(fake.links[0]?.ttlSeconds).toBe(60);
    expect(fake.claimTimeouts.get("s1")).toBe(60_000);
  });

  it("does not look for iOS's question when the app claims in time", async () => {
    const fake = createMemoryDaemon();
    const device = fakeDevice((sessionId) => fake.appClaims(sessionId, client));

    await pairWith({ platform: "ios", device }, fake.daemon, clock);

    expect(device.alerts).toBe(0);
  });

  it("accepts iOS's question when the app has not claimed in time", async () => {
    const fake = createMemoryDaemon();
    const device = fakeDevice(undefined, () => fake.appClaims("s1", client));

    expect(await pairWith({ platform: "ios", device }, fake.daemon, clock)).toBe(client);
    expect(device.alerts).toBe(1);
  });

  it("goes by the claim when accepting the question reports a failure", async () => {
    const fake = createMemoryDaemon();
    const device = fakeDevice();
    device.alert = async () => {
      device.alerts += 1;
      fake.appClaims("s1", client);
      throw new Error("alert accept exhausted its deadline");
    };

    expect(await pairWith({ platform: "ios", device }, fake.daemon, clock)).toBe(client);
  });

  it("never looks for a question on Android", async () => {
    const fake = createMemoryDaemon();
    const device = fakeDevice();
    const pairing = pairWith({ platform: "android", device }, fake.daemon, clock);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fake.appClaims("s1", client);

    await pairing;
    expect(device.alerts).toBe(0);
  });
});

describe("pairing a web page", () => {
  const browser = (evaluated: string[]) => ({
    url: async () => "http://localhost:5173/cart",
    evaluate: async (script: string) => void evaluated.push(script),
  });

  it("runs the connect script for the page's own address", async () => {
    const fake = createMemoryDaemon();
    const evaluated: string[] = [];
    fake.appClaims("s1", client);

    expect(await pairWith({ platform: "web", browser: browser(evaluated) }, fake.daemon, clock)).toBe(client);
    expect(fake.links[0]?.url).toBe("http://localhost:5173/cart");
    expect(evaluated).toEqual(['(connect("s1"), null)']);
  });

  it("gives up on a page that does not connect within ten seconds, saying what to check", async () => {
    const fake = createMemoryDaemon();
    fake.expire("s1", new AppductError("timeout", "Timed out."));

    await expect(pairWith({ platform: "web", browser: browser([]) }, fake.daemon, clock)).rejects.toMatchObject({
      type: "timeout",
      message: expect.stringContaining("@appduct/web"),
    });
    expect(fake.claimTimeouts.get("s1")).toBe(10_000);
    expect(fake.links[0]?.ttlSeconds).toBe(10);
  });
});
