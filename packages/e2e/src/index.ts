/**
 * `@appduct/e2e`: Appduct in e2e (https://github.com/tester-army/e2e) tests. `withAppduct(test)`
 * gives every test an `appduct` fixture that calls the app's tools, and `appductTools()` gives
 * e2e's agent the same reach.
 *
 * ```ts
 * import { test as base } from "e2e";
 * import { withAppduct } from "@appduct/e2e";
 *
 * const test = withAppduct(base);
 *
 * test("checks out", async ({ app, appduct, agent }) => {
 *   await app.open();
 *   await appduct.call("seed_cart", { sku: "SHIRT" });
 *   await agent.act("check out");
 *   expect(await appduct.call("order_status")).toEqual({ status: "paid" });
 * });
 * ```
 */
import type { FixtureDefinitions, FixtureFn, TestAPI, TestFixtures } from "e2e";

import { offerToAgent } from "./agent-tools.js";
import { pairWith, type PairingBrowser, type PairingDevice, type PairingTarget } from "./pairing.js";
import { createSessions, type Appduct, type Clock } from "./session.js";

export { appductTools } from "./agent-tools.js";
export type { Appduct, EventWait } from "./session.js";

const clock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** One per worker process, shared by every `withAppduct` test in it. */
const sessions = createSessions(clock);

type EngineFixtures = TestFixtures & { readonly browser: PairingBrowser; readonly device: PairingDevice };

/** Reads the engine's fixture for the platform only when pairing, since e2e acquires fixtures on access. */
const targetOf = (fixtures: EngineFixtures): PairingTarget => {
  const { platform } = fixtures;
  if (platform === "web") return { platform, browser: fixtures.browser };
  if (platform === "ios" || platform === "android") return { platform, device: fixtures.device };
  throw new Error(`Appduct pairs with web, iOS and Android targets, not "${platform}".`);
};

/**
 * Adds an `appduct` fixture to `base`: the app's Appduct session, connected on first use and kept
 * for the next test while the app stays connected. `base` is
 * e2e's `test`, an engine's typed `test`, or one you already extended.
 */
export const withAppduct = <Fixtures extends TestFixtures>(base: TestAPI<Fixtures>): TestAPI<Fixtures & { appduct: Appduct }> => {
  const appduct: FixtureFn<Fixtures, Appduct> = async (fixtures, use) => {
    const session = sessions.forTest(() => pairWith(targetOf(fixtures as unknown as EngineFixtures)));
    const withdraw = offerToAgent(session);
    await use(session);
    withdraw();
  };
  // The mapped definition type cannot tell that `appduct` is absent from a generic `Fixtures`; a
  // base that has one fails at import with e2e's own COLLECTION_ERROR.
  return base.extend({ appduct } as FixtureDefinitions<Fixtures, { appduct: Appduct }>);
};
