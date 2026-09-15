/**
 * Client-facing error type (issue #8): the wire `error.data.type` (ARCHITECTURE.md §5) surfaced as
 * a typed exception instead of a `DaemonRpcError`/stderr string a test would have to pattern-match.
 * `type` preserves the wire value verbatim — the same non-rewrapping rule `errors.ts`'s
 * `toCliError` already enforces for the CLI — so `expect(...).rejects.toMatchObject({ type:
 * "policy_denied" })` works without this package's internal error classes leaking into test code.
 */
import type { ErrorType } from "@appduct/shared";

import { isAppductCliError } from "../errors.js";
import { DaemonRpcError, isDaemonUnreachableError } from "../rpc/client.js";

/** The wire `ErrorType` union, plus three client-only buckets for conditions the daemon never
 * produced: `"connection_error"` (daemon unreachable/unspawnable, or the connection dropped mid-
 * wait), `"timeout"` (a client-side wait — `waitForEvent`, `waitForSession` — gave up; distinct
 * from the wire `"tool_timeout"` so a test can tell "the app's tool timed out" apart from "my wait
 * gave up"), and `"client_error"` (anything else, e.g. a failed emulator/simulator delivery from
 * {@link link}, or a malformed JSON-RPC error with no `data.type`). */
export type AppductErrorType = ErrorType | "connection_error" | "timeout" | "client_error";

export class AppductError extends Error {
  readonly type: AppductErrorType;
  readonly details?: unknown;
  /** The JSON-RPC error code, when this wraps a `DaemonRpcError`. */
  readonly code?: number;

  constructor(type: AppductErrorType, message: string, details?: unknown, code?: number) {
    super(message);
    this.name = "AppductError";
    this.type = type;
    this.details = details;
    this.code = code;
  }
}

/** Converts any error thrown by the RPC layer into a {@link AppductError}, preserving the wire
 * `data.type` verbatim when present. Idempotent on an already-converted error. */
export const toAppductError = (error: unknown): AppductError => {
  if (error instanceof AppductError) {
    return error;
  }

  const withCause = (result: AppductError): AppductError => {
    result.cause = error;
    return result;
  };

  if (error instanceof DaemonRpcError) {
    const type = error.data?.type ?? "client_error";
    return withCause(new AppductError(type, error.message, error.data?.details, error.code));
  }

  if (isDaemonUnreachableError(error)) {
    return withCause(
      new AppductError(
        "connection_error",
        error instanceof Error ? error.message : "The Appduct daemon is unreachable.",
      ),
    );
  }

  if (isAppductCliError(error)) {
    return withCause(new AppductError("client_error", error.message, error.details));
  }

  if (error instanceof Error) {
    return withCause(new AppductError("client_error", error.message));
  }

  return new AppductError("client_error", "An unexpected error occurred.", error);
};
