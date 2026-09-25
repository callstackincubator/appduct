/**
 * Shared core of `link.create` + deep-link composition + optional emulator/simulator delivery
 * (ARCHITECTURE.md §8, §10): mints a pending session via `link.create`, then composes
 * `<scheme>:///?appduct=<payload>&pin=<spki-pin>` and optionally delivers it to a booted
 * Android emulator/device or iOS simulator. Used by `commands/link.ts` (`appduct sessions link`) and
 * `client/bootstrap.ts` (`appduct/client`'s `link()`) so this shape — scheme resolution, the
 * `pin` query param, the `127.0.0.1` emulator/simulator address override (which the experimental
 * `ios-device` target deliberately opts out of) — can't drift between the CLI and the programmatic
 * client.
 *
 * The `pin` param is separate from the `appduct` bootstrap blob (opt-in hardening dev-mode) — it
 * is never part of that binary v2 payload, so old apps that don't know about it simply ignore it.
 * It carries the daemon's SPKI pin (same value as `daemon.status`'s `pinnedKeys[0]` / `appduct
 * keygen`'s output) so any build that embeds no `cliPins` — whatever its build type, there is no
 * build-type gate — can trust it for this one connection instead of requiring a native rebuild
 * just to test locally. The pin is standard (non-URL-safe) base64
 * (`sha256/<44-char-base64>`, may contain `+`/`/`/`=`), so it is percent-encoded here; native/JS
 * parsers use `URLSearchParams`, which decodes it back.
 */
import { RPC_METHODS, type AgentEndpoint, type LinkCreateResult } from "@appduct/shared";

import {
  deliverToOpenTarget,
  isOpenTarget,
  isValidAppId,
  invalidAppIdMessage,
  isLoopbackAddress,
  loopbackAddressMessage,
  platformOf,
  usesLoopbackAddress,
  OPEN_TARGETS,
  type ExecFn,
  type OpenTarget,
} from "./cli/open-target.js";
import { loadConfig } from "./daemon/config.js";
import { getStateDirPaths } from "./daemon/state-dir.js";
import { usageError } from "./errors.js";
import { callDaemon, type SpawnFn } from "./rpc/client.js";
import { describeMissingAppId, resolveAppId, resolveSchemeOrThrow } from "./scheme.js";

/** The emulator/simulator fast path forces `127.0.0.1`: the daemon's wss listener already binds
 * all interfaces, and both delivery mechanisms (adb reverse, the iOS simulator's shared host
 * network) make the daemon reachable there regardless of the machine's real LAN address. A
 * physical iOS device (`ios-device`) has no such tunnel, so it keeps the detected LAN address —
 * see `usesLoopbackAddress`. */
const OPEN_TARGET_ADDRESS_OVERRIDE = "127.0.0.1";

/**
 * The deep-link shape, in one place: `<scheme>:///?appduct=<payload>&pin=<spki-pin>`. Exported
 * so `mcp/connect-tool.ts` composes byte-identical links rather than a second, drifting copy — the
 * `pin` param went missing from the MCP side exactly because there were two of these.
 *
 * The pin is standard (non-URL-safe) base64 (`sha256/<44 chars>`, possibly containing `+`/`/`/`=`),
 * so it is percent-encoded; parsers use `URLSearchParams`, which decodes it back. It is appended
 * *after* the bootstrap blob, so anything reading `appduct=` must stop at the `&`.
 */
export const composeDeepLink = (scheme: string, result: LinkCreateResult): string =>
  `${scheme}:///?appduct=${result.deepLinkPayload}&pin=${encodeURIComponent(result.pin)}`;

export type MintLinkOptions = {
  stateDir: string;
  spawn?: SpawnFn;
  autoSpawn?: boolean;
  ttlSeconds?: number;
  /** Delivers the link directly to a booted Android emulator/device or iOS simulator instead of
   * leaving delivery to the caller. */
  target?: OpenTarget;
  /** An adb device serial (`target: "android"`), a simulator udid (`target: "ios-sim"`) or a
   * paired-device udid (`target: "ios-device"`). Only meaningful alongside a target. */
  device?: string;
  /** The installed app's id (Android package name / iOS bundle id) — highest-precedence source in
   * `resolveAppId`'s order. Only meaningful with `target: "android"` or `target: "ios-device"`. */
  appId?: string;
  /** `target: "ios-device"` only: terminate a running instance before launching
   * (`--terminate-existing`). Off by default. */
  relaunch?: boolean;
  /** Highest-precedence scheme source (`--scheme`); see `scheme.ts` for the full order. */
  scheme?: string;
  /** Where scheme discovery starts (project `.appduct/config.json` walk-up, then `app.json`).
   * Defaults to `process.cwd()`. */
  cwd?: string;
  exec?: ExecFn;
  /** The environment handed to `adb`/`simctl` when delivering to a device. This is deliberately
   * *not* where `APPDUCT_SCHEME` is read from — callers narrow this env on purpose, and reading
   * the scheme out of it would silently drop one the user really had exported. See {@link schemeEnv}. */
  env?: NodeJS.ProcessEnv;
  /** The environment `APPDUCT_SCHEME` is read from; defaults to `process.env`. Separate from
   * {@link env} so a narrowed exec environment cannot change scheme resolution. */
  schemeEnv?: NodeJS.ProcessEnv;
};

export type MintLinkResult = {
  sessionId: string;
  deepLink: string;
  endpoint: AgentEndpoint;
  /** Unix seconds. */
  expiresAt: number;
  pin: string;
  delivered?: true;
  target?: OpenTarget;
};

/** Throws `usageError`/`AppductCliError` on validation failure — `commands/link.ts` renders
 * that straight through the CLI's own error path; `client/bootstrap.ts` converts it to a
 * `AppductError` via `toAppductError` (which already understands `AppductCliError`). */
export const mintLink = async (options: MintLinkOptions): Promise<MintLinkResult> => {
  if (options.target !== undefined && !isOpenTarget(options.target)) {
    throw usageError(
      `"target" must be one of ${OPEN_TARGETS.map((target) => `"${target}"`).join(", ")} (got "${
        options.target
      }").`,
    );
  }

  if (options.device !== undefined && options.target === undefined) {
    throw usageError('"device" only applies alongside a target.');
  }

  if (
    options.appId !== undefined &&
    options.target !== "android" &&
    options.target !== "ios-device"
  ) {
    throw usageError('"appId" only applies alongside target "android" or target "ios-device".');
  }

  if (options.relaunch !== undefined && options.target !== "ios-device") {
    throw usageError('"relaunch" only applies alongside target "ios-device".');
  }

  const paths = getStateDirPaths(options.stateDir);
  const config = await loadConfig(paths);
  const scheme = await resolveSchemeOrThrow({
    flagScheme: options.scheme,
    env: options.schemeEnv,
    cwd: options.cwd,
    configScheme: config.scheme,
    stateConfigPath: paths.configPath,
    stateDirRoot: paths.root,
  });

  // `android` and `ios-device` both need the installed app's id named explicitly (Android: `-p`,
  // so Android cannot fall back to an "Open with" chooser; iOS: `devicectl`'s launch target).
  // Resolved (and required) *before* the link is minted so a missing or malformed one is a plain
  // usage error rather than a stranded pending session.
  const platform = options.target === undefined ? undefined : platformOf(options.target);
  let appId: string | undefined;

  if (platform !== undefined) {
    const resolved = await resolveAppId({
      platform,
      flagAppId: options.appId,
      cwd: options.cwd,
      stateDirRoot: paths.root,
    });

    if (resolved.appId === undefined) {
      throw usageError(describeMissingAppId(platform, resolved.tried));
    }

    appId = resolved.appId;
  }

  if (appId !== undefined && !isValidAppId(appId)) {
    throw usageError(invalidAppIdMessage(appId));
  }

  const result = await callDaemon<LinkCreateResult>(
    RPC_METHODS.linkCreate,
    {
      ttlSeconds: options.ttlSeconds,
      addressOverride:
        options.target && usesLoopbackAddress(options.target) ? OPEN_TARGET_ADDRESS_OVERRIDE : undefined,
    },
    { stateDir: options.stateDir, spawn: options.spawn, autoSpawn: options.autoSpawn },
  );

  // A physical device is the one target that cannot reach a loopback address, and
  // `detectAdvertisedAddress` falls back to `127.0.0.1` when it finds no routable interface. Left
  // unchecked, the link would be delivered happily and then never claimed — a silent hang in
  // `wait_for_session` with nothing pointing at the cause.
  if (options.target === "ios-device" && isLoopbackAddress(result.endpoint.address)) {
    throw usageError(loopbackAddressMessage(result.endpoint.address));
  }

  const deepLink = composeDeepLink(scheme, result);

  if (options.target) {
    await deliverToOpenTarget({
      target: options.target,
      deepLink,
      wssPort: result.endpoint.port,
      device: options.device,
      appId,
      relaunch: options.relaunch,
      exec: options.exec,
      env: options.env,
    });

    return {
      sessionId: result.sessionId,
      deepLink,
      endpoint: result.endpoint,
      expiresAt: result.expiresAt,
      pin: result.pin,
      delivered: true,
      target: options.target,
    };
  }

  return {
    sessionId: result.sessionId,
    deepLink,
    endpoint: result.endpoint,
    expiresAt: result.expiresAt,
    pin: result.pin,
  };
};
