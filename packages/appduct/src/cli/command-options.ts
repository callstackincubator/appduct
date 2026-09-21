/**
 * Small option-parsing helpers shared across the v2 command handlers wired in `dispatch.ts`. Kept
 * separate from `dispatch.ts` itself so each parsing rule (numeric flags, the selector/target
 * positional split) has one obvious place to test in isolation.
 */

import { usageError, validationError } from "../errors.js";

/** Parses a `cac`-provided option value (already a number, a numeric string, or `undefined`) into a
 * positive integer, or throws a clear `usage_error`. */
export const parsePositiveIntegerOption = (value: unknown, flagName: string): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  // Only a number or a string is a value: `cac` (run with `run: false`) never enforces a `<n>`
  // placeholder, so a flag with no value, or followed by a flag-like token (`--limit -1`),
  // arrives as `true`, which `Number()` would otherwise silently turn into `1`.
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw usageError(`"${flagName}" must be a positive integer.`);
  }

  return parsed;
};

/** Parses a `cac`-provided option value into a non-negative integer (0 allowed, unlike
 * {@link parsePositiveIntegerOption}), or throws a clear `usage_error`. Used by `events --since`,
 * whose cursor `0` is a meaningful "everything retained" value, not an omission. */
export const parseNonNegativeIntegerOption = (value: unknown, flagName: string): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  // Only a number or a string is a value: `cac` (run with `run: false`) never enforces a `<n>`
  // placeholder, so a flag with no value, or followed by a flag-like token (`--limit -1`),
  // arrives as `true`, which `Number()` would otherwise silently turn into `1`.
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw usageError(`"${flagName}" must be a non-negative integer.`);
  }

  return parsed;
};

/**
 * Reads a free-text flag's value exactly as typed. `cac` coerces any numeric-looking value to a
 * number (`--filter 404` arrives as `404`, `--filter 007` as `7`), so the verbatim string is
 * recovered from `argv` (`--flag value` or `--flag=value`, the last occurrence wins, nothing after
 * `--`), falling back to the parsed value if argv somehow does not carry it. A flag given with no
 * value (`cac` reports `true`) is a usage error rather than silently ignored.
 */
export const readTextOption = (
  argv: readonly string[],
  value: unknown,
  flagName: string,
): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "boolean") {
    throw usageError(`"${flagName}" requires a value.`);
  }

  let raw: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;

    if (token === "--") {
      break;
    }

    if (token === flagName && index + 1 < argv.length) {
      raw = argv[index + 1];
      index += 1;
    } else if (token.startsWith(`${flagName}=`)) {
      raw = token.slice(flagName.length + 1);
    }
  }

  return raw ?? String(Array.isArray(value) ? value.at(-1) : value);
};

/**
 * Splits the positional args of a command shaped `<command> [selector] <target>` (e.g. `invoke
 * [selector] <tool>`, `tools [selector] <name>`): the last positional is always the required
 * target, everything before it (zero or one args) is the optional selector.
 */
export const splitSelectorAndRequiredTarget = (
  args: readonly string[],
  commandUsage: string,
): { selector?: string; target: string } => {
  if (args.length === 0) {
    throw usageError(`Usage: ${commandUsage}`);
  }

  if (args.length > 2) {
    throw usageError(`Usage: ${commandUsage} (too many arguments).`);
  }

  if (args.length === 1) {
    return { target: args[0]! };
  }

  return { selector: args[0], target: args[1]! };
};

/** Splits the positional args of a command shaped `<command> [selector]`: at most one positional,
 * the optional selector. */
export const splitOptionalSelector = (args: readonly string[], commandUsage: string): { selector?: string } => {
  if (args.length > 1) {
    throw usageError(`Usage: ${commandUsage} (too many arguments).`);
  }

  return { selector: args[0] };
};

/**
 * Splits the positional args of a command shaped `<command> [selector] [target]` (`tools [selector]
 * [name]`): with 2 args, `(selector, target)`; with 1, the single arg is ambiguous between "the
 * selector" and "the target with the selector omitted" — the caller resolves that (see
 * `commands/tools.ts`), so it comes back unlabeled here as `selectorOrTarget`.
 */
export const splitOptionalSelectorAndTarget = (
  args: readonly string[],
  commandUsage: string,
): { selector?: string; target?: string; selectorOrTarget?: string } => {
  if (args.length > 2) {
    throw usageError(`Usage: ${commandUsage} (too many arguments).`);
  }

  if (args.length === 2) {
    return { selector: args[0], target: args[1] };
  }

  if (args.length === 1) {
    return { selectorOrTarget: args[0] };
  }

  return {};
};

/**
 * Parses the JSON payload for `invoke --input`; never throws a raw `SyntaxError` at the CLI
 * boundary. A missing flag is a usage error (nothing was given); a present-but-unparseable or
 * wrong-shaped value is a validation error (something was given, and it's invalid).
 */
export const parseJsonInputOption = (value: string | undefined): Record<string, unknown> => {
  if (value === undefined) {
    throw usageError('"--input" is required.');
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw validationError(`"--input" must be valid JSON: ${(error as Error).message}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw validationError('"--input" must be a JSON object.');
  }

  return parsed as Record<string, unknown>;
};
