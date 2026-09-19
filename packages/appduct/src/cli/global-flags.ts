/**
 * The CLI's global output flags (`--json`, `--pretty`, `--verbose`, `--no-color`) as a single
 * declarative table. This module sits on the eager path (ARCHITECTURE.md §10 "Startup cost") —
 * every invocation resolves these flags before a command word is even known — so it imports
 * nothing beyond `cac`'s types (erased at build time) and stays free of runtime dependencies.
 *
 * Add a flag by adding one entry to {@link globalFlagDefinitions}: `create-cli.ts` registers it
 * with `cac` via {@link registerGlobalFlags}, and `dispatch.ts` resolves it into the
 * {@link GlobalFlags} object every route receives as `env.flags` via {@link resolveGlobalFlags} /
 * {@link resolveGlobalFlagsFromArgv} — no other file needs to change.
 */

import type { CAC } from "cac";

export type GlobalFlags = {
  json: boolean;
  pretty: boolean;
  verbose: boolean;
  color: boolean;
};

type GlobalFlagDefinition<K extends keyof GlobalFlags> = {
  /** The flag's key in {@link GlobalFlags}. */
  key: K;
  /** What `cli.option()` receives, e.g. `"--json"` or `"--no-color"`. */
  spec: string;
  /** Shown by `--help`. */
  description: string;
  /** Derives the flag's value from `cac`'s parsed options object (camelCased keys). */
  fromOptions: (options: Readonly<Record<string, unknown>>) => GlobalFlags[K];
  /** Derives the flag's value directly from argv — needed for the path where `cac` itself throws
   * before a parsed options object exists (`dispatch.ts`'s parse-failure fallback). */
  fromArgv: (argv: readonly string[]) => GlobalFlags[K];
};

/** A `GlobalFlagDefinition<K>` for some `K`, with `K` erased — lets every definition live in one
 * array while each individual entry keeps its own key/value type tied together. */
type AnyGlobalFlagDefinition = { [K in keyof GlobalFlags]: GlobalFlagDefinition<K> }[keyof GlobalFlags];

const globalFlagDefinitions: readonly AnyGlobalFlagDefinition[] = [
  {
    key: "json",
    spec: "--json",
    description: "Print machine-readable JSON (NDJSON for streaming commands).",
    fromOptions: (options) => Boolean(options.json),
    fromArgv: (argv) => argv.includes("--json"),
  },
  {
    key: "pretty",
    spec: "--pretty",
    description:
      "Indent JSON output. Applies to --json results and to JSON values embedded in human " +
      "output; never to NDJSON event lines.",
    fromOptions: (options) => Boolean(options.pretty),
    fromArgv: (argv) => argv.includes("--pretty"),
  },
  {
    key: "verbose",
    spec: "--verbose",
    description: "Include command metadata (command, timestamp, duration) in the output.",
    fromOptions: (options) => Boolean(options.verbose),
    fromArgv: (argv) => argv.includes("--verbose"),
  },
  {
    key: "color",
    spec: "--no-color",
    description: "Disable terminal color in human-readable output.",
    // `cac` reports a `--no-<flag>` option as `<flag>: false` when passed, and omits it (leaving
    // the parsed value `undefined`) otherwise — so "not explicitly disabled" is the default `true`.
    fromOptions: (options) => options.color !== false,
    fromArgv: (argv) => !argv.includes("--no-color"),
  },
];

/** Registers every table entry with `cli.option()`, in table order. */
export const registerGlobalFlags = (cli: CAC): void => {
  for (const definition of globalFlagDefinitions) {
    cli.option(definition.spec, definition.description);
  }
};

/** Resolves {@link GlobalFlags} from `cac`'s parsed options object (the normal path). */
export const resolveGlobalFlags = (options: Readonly<Record<string, unknown>>): GlobalFlags => {
  const flags = {} as GlobalFlags;

  for (const definition of globalFlagDefinitions) {
    flags[definition.key] = definition.fromOptions(options);
  }

  return flags;
};

/** Resolves {@link GlobalFlags} directly from argv — used when `cac.parse()` itself throws before
 * a parsed options object exists. */
export const resolveGlobalFlagsFromArgv = (argv: readonly string[]): GlobalFlags => {
  const flags = {} as GlobalFlags;

  for (const definition of globalFlagDefinitions) {
    flags[definition.key] = definition.fromArgv(argv);
  }

  return flags;
};

/**
 * The single place that decides compact vs. indented JSON. Compact (`JSON.stringify(value)`) by
 * default; `--pretty` restores the 2-space indentation the CLI used to always apply.
 */
export const formatJson = (value: unknown, flags: Pick<GlobalFlags, "pretty">): string => {
  return flags.pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
};
