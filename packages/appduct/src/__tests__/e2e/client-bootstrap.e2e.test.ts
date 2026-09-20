/**
 * E2E scenario: the `appduct/client` bootstrap half — `link()`/`waitForSession()` (issue #8) —
 * against a real daemon and a fake app client, exercising: the already-claimed fast path, the
 * claim racing the subscribe (regression coverage for the listener-must-register-before-subscribe
 * ordering fix), and the timeout path.
 */
import { afterEach, describe, expect, test } from "vitest";

import { link, waitForSession, AppductError } from "../../client/index.js";
import { FakeAppClient } from "./app-client.js";
import { cleanupAfterEach, daemonWssPort, decodeDeepLink, ensureDaemon, fetchPinnedKeys, makeTempStateDir } from "./harness.js";

afterEach(cleanupAfterEach);

describe("e2e: appduct/client bootstrap", () => {
  test("link() mints a claimable deep link, and waitForSession() resolves once a fake app claims it concurrently with the subscribe", async () => {
    const { stateDir } = await makeTempStateDir();
    await ensureDaemon(stateDir);
    // The daemon binds an OS-assigned wss port (`wssPort: 0`), so the port is read back
    // from the daemon itself rather than chosen here — see harness.makeTempStateDir.
    const port = await daemonWssPort(stateDir);
    const pinnedKeys = await fetchPinnedKeys(stateDir);

    const minted = await link({ stateDir, ttlSeconds: 60 });
    expect(minted.sessionId).toBeTruthy();
    expect(minted.deepLink).toContain("appduct=");

    const decoded = decodeDeepLink(minted.deepLink);
    const fakeApp = new FakeAppClient(port, pinnedKeys);

    // No artificial delay between starting the wait and claiming — this is exactly the window
    // where a `session_claimed` notification can land in the same TCP chunk as the
    // `events.subscribe` response, which the listener-registration-order fix in bootstrap.ts
    // exists to handle correctly.
    const [app] = await Promise.all([
      waitForSession(minted.sessionId, { stateDir, timeoutMs: 10_000 }),
      fakeApp.claim(decoded, { model: "Pixel 8" }),
    ]);

    expect(app.sessionId).toBe(minted.sessionId);

    app.close();
    fakeApp.close();
  });

  test("waitForSession() resolves immediately when the session is already claimed", async () => {
    const { stateDir } = await makeTempStateDir();
    await ensureDaemon(stateDir);
    // The daemon binds an OS-assigned wss port (`wssPort: 0`), so the port is read back
    // from the daemon itself rather than chosen here — see harness.makeTempStateDir.
    const port = await daemonWssPort(stateDir);
    const pinnedKeys = await fetchPinnedKeys(stateDir);

    const minted = await link({ stateDir });
    const decoded = decodeDeepLink(minted.deepLink);
    const fakeApp = new FakeAppClient(port, pinnedKeys);
    await fakeApp.claim(decoded, { model: "Pixel 8" });

    const app = await waitForSession(minted.sessionId, { stateDir, timeoutMs: 5_000 });
    expect(app.sessionId).toBe(minted.sessionId);

    app.close();
    fakeApp.close();
  });

  test("waitForSession() rejects with a client-only \"timeout\" AppductError if nothing ever claims it", async () => {
    const { stateDir } = await makeTempStateDir();
    await ensureDaemon(stateDir);

    const minted = await link({ stateDir });

    await expect(waitForSession(minted.sessionId, { stateDir, timeoutMs: 300 })).rejects.toBeInstanceOf(
      AppductError,
    );
    await expect(waitForSession(minted.sessionId, { stateDir, timeoutMs: 300 })).rejects.toMatchObject({
      type: "timeout",
    });
  });

  test("link() rejects with a client_error AppductError when no scheme is configured or available", async () => {
    const { stateDir } = await makeTempStateDir({ scheme: undefined });
    await ensureDaemon(stateDir);

    // `cwd` is pinned to the temp state dir so "no scheme available" is literally true: scheme
    // discovery walks up from the working directory and reads its `app.json` (issue #29), which
    // would otherwise make this assertion depend on where the suite happens to be run from.
    await expect(link({ stateDir, cwd: stateDir, schemeEnv: {} })).rejects.toMatchObject({
      type: "client_error",
    });
  });
});
