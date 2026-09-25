/**
 * `config.json` loading and validation (ARCHITECTURE.md §3). All fields are optional; unknown
 * top-level keys produce a warning (not an error); invalid values throw a clear error naming the
 * offending key.
 */

import { readFile } from "node:fs/promises";

import type { StateDirPaths } from "./state-dir.js";

export type PolicyDecision = "allow" | "deny" | "prompt";

/**
 * `config.json`'s `policy` shape (ARCHITECTURE.md §12): `default` applies to tools whose
 * descriptor has no `annotations.destructiveHint`; `destructive` applies when it is `true`;
 * `tools["<alias>/<name>"]` overrides both for one specific tool on one specific session alias.
 * `"prompt"` means "a human gate is required; if one cannot be guaranteed, deny" — today the only
 * such gate is an MCP client that declares the `elicitation` capability at `initialize`
 * (ARCHITECTURE.md §9/§12, issue #10). Every other caller (CLI, an MCP client without
 * elicitation) gets `policy_denied` with reason `no_consent_channel`.
 */
export type AppductPolicyConfig = {
  default: PolicyDecision;
  destructive: PolicyDecision;
  tools?: Record<string, PolicyDecision>;
};

export type AppductConfig = {
  /**
   * TCP port for the pinned-wss listener (ARCHITECTURE.md §3). `0` is special and means
   * "let the OS assign a free ephemeral port": the listener binds `0`, and everything that
   * reports or advertises the port afterwards (`daemon.status`'s `wssPort`, a minted link's
   * `endpoint.port`) reports the *bound* port instead. That is the only way several daemons can
   * coexist on one machine without the operator hand-picking ports for each — which is exactly
   * what the test suite needs when several vitest processes run concurrently. Every other value
   * must be a positive integer.
   */
  wssPort: number;
  keyPath: string;
  graceSeconds: number;
  linkTtlSeconds: number;
  keepaliveIntervalSeconds: number;
  /** Max retained `app_event`s per session (ARCHITECTURE.md §5's `events.since`
   * retention buffer); default 256. */
  eventBufferSize: number;
  /** Days of `audit/<YYYY-MM-DD>.jsonl` history to keep; files older than this are pruned on
   * daemon start and once a day thereafter (ARCHITECTURE.md §3). Default 30. */
  auditRetentionDays: number;
  /** Size at which `daemon.log` is rotated to `daemon.log.1` before a daemon is spawned
   * (ARCHITECTURE.md §3/§4). Default 10 MiB. */
  daemonLogMaxBytes: number;
  /** Size past which the daemon rotates `events.log` to `events.log.1` (ARCHITECTURE.md §3).
   * Default 10 MiB. */
  eventsLogMaxBytes: number;
  policy: AppductPolicyConfig;
  /**
   * When the CLI/MCP client finds the running daemon on a different Appduct version, restart it
   * even if that drops live sessions (issue #30, ARCHITECTURE.md §4's "Version drift"). Default
   * `false`: with sessions connected the command fails with both versions and the remedy instead.
   * The `--daemon-restart` flag and `APPDUCT_DAEMON_RESTART=1` force the same thing per run.
   */
  restartDaemonOnVersionMismatch: boolean;
  /** Operator override for advertised-address detection (daemon/address.ts); undefined = auto-detect. */
  advertisedIp?: string;
  /**
   * Deep-link URI scheme used to compose `appduct sessions link`'s output (ARCHITECTURE.md §10: "taken
   * from the flag, else `config.json`, else the CLI errors with a clear message"). Not part of the
   * `config.json` shape enumerated in ARCHITECTURE.md §3 (which only covers daemon-side settings),
   * but `config.json` is explicitly "all fields optional" there and this is the natural home for a
   * CLI-side setting an operator wants to set once rather than pass with every `link` invocation.
   */
  scheme?: string;
};

const KNOWN_TOP_LEVEL_KEYS = new Set<string>([
  "wssPort",
  "keyPath",
  "graceSeconds",
  "linkTtlSeconds",
  "keepaliveIntervalSeconds",
  "eventBufferSize",
  "auditRetentionDays",
  "daemonLogMaxBytes",
  "eventsLogMaxBytes",
  "policy",
  "advertisedIp",
  "scheme",
  "restartDaemonOnVersionMismatch",
]);

const KNOWN_POLICY_KEYS = new Set<string>(["default", "destructive", "tools"]);

const POLICY_DECISIONS = new Set<string>(["allow", "deny", "prompt"]);

export const DEFAULT_AUDIT_RETENTION_DAYS = 30;
export const DEFAULT_DAEMON_LOG_MAX_BYTES = 10 * 1024 * 1024;

export class AppductConfigError extends Error {
  constructor(
    readonly key: string,
    message: string,
  ) {
    super(message);
    this.name = "AppductConfigError";
  }
}

const configError = (key: string, message: string): AppductConfigError => {
  return new AppductConfigError(key, `Invalid Appduct config value for "${key}": ${message}`);
};

/**
 * `wssPort` alone accepts `0` on top of the positive integers — it is not a degenerate port but a
 * documented request for an OS-assigned one (see {@link AppductConfig.wssPort}). Kept separate
 * from {@link requirePositiveInteger} so no *other* key silently gains a meaningless zero.
 */
const requireWssPort = (value: unknown, key: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65_535) {
    throw configError(key, "must be a port number between 0 and 65535 (0 binds an OS-assigned port).");
  }

  return value;
};

const requirePositiveInteger = (value: unknown, key: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw configError(key, "must be a positive integer.");
  }

  return value;
};

const requireNonEmptyString = (value: unknown, key: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw configError(key, "must be a non-empty string.");
  }

  return value;
};

const requireBoolean = (value: unknown, key: string): boolean => {
  if (typeof value !== "boolean") {
    throw configError(key, "must be a boolean.");
  }

  return value;
};

const requirePolicyDecision = (value: unknown, key: string): PolicyDecision => {
  if (typeof value !== "string" || !POLICY_DECISIONS.has(value)) {
    throw configError(key, 'must be "allow", "deny", or "prompt".');
  }

  return value as PolicyDecision;
};

export const defaultConfig = (paths: StateDirPaths): AppductConfig => {
  return {
    wssPort: 8443,
    keyPath: paths.keyPath,
    graceSeconds: 600,
    linkTtlSeconds: 300,
    keepaliveIntervalSeconds: 15,
    eventBufferSize: 256,
    auditRetentionDays: DEFAULT_AUDIT_RETENTION_DAYS,
    daemonLogMaxBytes: DEFAULT_DAEMON_LOG_MAX_BYTES,
    eventsLogMaxBytes: 10 * 1024 * 1024,
    restartDaemonOnVersionMismatch: false,
    policy: {
      default: "allow",
      destructive: "allow",
    },
  };
};

export type ConfigWarnFn = (message: string) => void;

/** Loads and validates `<state-dir>/config.json`, falling back to defaults when it is missing. */
export const loadConfig = async (
  paths: StateDirPaths,
  options: { warn?: ConfigWarnFn } = {},
): Promise<AppductConfig> => {
  const warn = options.warn ?? (() => {});
  const config = defaultConfig(paths);

  let raw: unknown;

  try {
    raw = JSON.parse(await readFile(paths.configPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return config;
    }

    throw configError("config.json", `could not be read/parsed (${(error as Error).message}).`);
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw configError("config.json", "must be a JSON object.");
  }

  const parsed = raw as Record<string, unknown>;

  for (const key of Object.keys(parsed)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      warn(`Unknown Appduct config key "${key}" is ignored.`);
    }
  }

  if (parsed.wssPort !== undefined) {
    config.wssPort = requireWssPort(parsed.wssPort, "wssPort");
  }

  if (parsed.keyPath !== undefined) {
    config.keyPath = requireNonEmptyString(parsed.keyPath, "keyPath");
  }

  if (parsed.advertisedIp !== undefined) {
    config.advertisedIp = requireNonEmptyString(parsed.advertisedIp, "advertisedIp");
  }

  if (parsed.scheme !== undefined) {
    config.scheme = requireNonEmptyString(parsed.scheme, "scheme");
  }

  if (parsed.graceSeconds !== undefined) {
    config.graceSeconds = requirePositiveInteger(parsed.graceSeconds, "graceSeconds");
  }

  if (parsed.linkTtlSeconds !== undefined) {
    config.linkTtlSeconds = requirePositiveInteger(parsed.linkTtlSeconds, "linkTtlSeconds");
  }

  if (parsed.keepaliveIntervalSeconds !== undefined) {
    config.keepaliveIntervalSeconds = requirePositiveInteger(
      parsed.keepaliveIntervalSeconds,
      "keepaliveIntervalSeconds",
    );
  }

  if (parsed.eventBufferSize !== undefined) {
    config.eventBufferSize = requirePositiveInteger(parsed.eventBufferSize, "eventBufferSize");
  }

  if (parsed.auditRetentionDays !== undefined) {
    config.auditRetentionDays = requirePositiveInteger(parsed.auditRetentionDays, "auditRetentionDays");
  }

  if (parsed.daemonLogMaxBytes !== undefined) {
    config.daemonLogMaxBytes = requirePositiveInteger(parsed.daemonLogMaxBytes, "daemonLogMaxBytes");
  }

  if (parsed.eventsLogMaxBytes !== undefined) {
    config.eventsLogMaxBytes = requirePositiveInteger(parsed.eventsLogMaxBytes, "eventsLogMaxBytes");
  }

  if (parsed.restartDaemonOnVersionMismatch !== undefined) {
    config.restartDaemonOnVersionMismatch = requireBoolean(
      parsed.restartDaemonOnVersionMismatch,
      "restartDaemonOnVersionMismatch",
    );
  }

  if (parsed.policy !== undefined) {
    if (typeof parsed.policy !== "object" || parsed.policy === null || Array.isArray(parsed.policy)) {
      throw configError("policy", "must be an object.");
    }

    const policy = parsed.policy as Record<string, unknown>;

    for (const key of Object.keys(policy)) {
      if (!KNOWN_POLICY_KEYS.has(key)) {
        warn(`Unknown Appduct config key "policy.${key}" is ignored.`);
      }
    }

    if (policy.default !== undefined) {
      config.policy.default = requirePolicyDecision(policy.default, "policy.default");
    }

    if (policy.destructive !== undefined) {
      config.policy.destructive = requirePolicyDecision(policy.destructive, "policy.destructive");
    }

    if (policy.tools !== undefined) {
      if (typeof policy.tools !== "object" || policy.tools === null || Array.isArray(policy.tools)) {
        throw configError("policy.tools", "must be an object.");
      }

      const tools: Record<string, PolicyDecision> = {};

      for (const [toolKey, toolValue] of Object.entries(policy.tools as Record<string, unknown>)) {
        tools[toolKey] = requirePolicyDecision(toolValue, `policy.tools["${toolKey}"]`);
      }

      config.policy.tools = tools;
    }
  }

  return config;
};
