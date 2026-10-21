/**
 * `@appduct/e2e`: Appduct in e2e (https://github.com/tester-army/e2e) tests. `test` gives every
 * test an `appduct` fixture that calls the app's tools, and `appductTools()` gives e2e's agent the
 * same reach.
 *
 * ```ts
 * import { test } from "@appduct/e2e";
 *
 * test("checks out", async ({ app, appduct, agent }) => {
 *   await app.open();
 *   await appduct.call("seed_cart", { sku: "SHIRT" });
 *   await agent.act("check out");
 *   expect(await appduct.call("order_status")).toEqual({ status: "paid" });
 * });
 * ```
 */
import { test as base, type TestFixtures } from "e2e";

import { offerToAgent } from "./agent-tools.js";
import { pairWith, type PairingBrowser, type PairingDevice, type PairingTarget } from "./pairing.js";
import { createSession, type Appduct, type Clock } from "./session.js";

export { appductTools } from "./agent-tools.js";
export type { Appduct, EventWait } from "./session.js";

const clock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

type EngineFixtures = TestFixtures & { readonly browser: PairingBrowser; readonly device: PairingDevice };

/** Reads the engine's fixture for the platform only when pairing, since e2e acquires fixtures on access. */
const targetOf = (fixtures: EngineFixtures): PairingTarget => {
  const { platform } = fixtures;
  if (platform === "web") return { platform, browser: fixtures.browser };
  if (platform === "ios" || platform === "android") return { platform, device: fixtures.device };
  throw new Error(`Appduct pairs with web, iOS and Android targets, not "${platform}".`);
};

/** e2e's `test` with an `appduct` fixture: the app's Appduct session, paired on first use. */
export const test = base.extend<{ appduct: Appduct }>({
  appduct: async (fixtures, use) => {
    const session = createSession(() => pairWith(targetOf(fixtures as EngineFixtures)), clock);
    const withdraw = offerToAgent(session);
    await use(session);
    withdraw();
    session.close();
  },
});
