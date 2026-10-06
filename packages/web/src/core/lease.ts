const SCHEMA_VERSION = 1;
const MAX_ID_LENGTH = 128;
const MAX_STRING_LENGTH = 4096;

/** What a resume needs, kept in the `SessionStore`. Port of the native `ResumeLeaseV1`, minus the
 * SPKI pin: the web has no TLS pinning. */
export type ResumeLease = {
  schemaVersion: 1;
  sessionId: string;
  resumeToken: string;
  alias: string;
  endpoint: { ip: string; port: number };
  keepaliveIntervalS: number;
  graceS: number;
  /** When the socket was first lost, in unix milliseconds; null while it is up. */
  disconnectedAtMs: number | null;
};

const isBoundedNonEmpty = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

const isPositiveFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/** Reads a stored lease, or null when the value is not a valid one. */
export const parseResumeLease = (raw: string | null): ResumeLease | null => {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const endpoint = record.endpoint as Record<string, unknown> | null | undefined;
  if (typeof endpoint !== "object" || endpoint === null) return null;
  const { disconnectedAtMs } = record;

  if (record.schemaVersion !== SCHEMA_VERSION) return null;
  if (!isBoundedNonEmpty(record.sessionId, MAX_ID_LENGTH)) return null;
  if (!isBoundedNonEmpty(record.resumeToken, MAX_ID_LENGTH)) return null;
  if (!isBoundedNonEmpty(record.alias, MAX_ID_LENGTH)) return null;
  if (!isBoundedNonEmpty(endpoint.ip, MAX_STRING_LENGTH)) return null;
  if (!Number.isInteger(endpoint.port) || (endpoint.port as number) < 1 || (endpoint.port as number) > 65535) return null;
  if (!isPositiveFinite(record.keepaliveIntervalS)) return null;
  if (!isPositiveFinite(record.graceS)) return null;
  if (
    disconnectedAtMs !== null &&
    (typeof disconnectedAtMs !== "number" || !Number.isFinite(disconnectedAtMs) || disconnectedAtMs < 0)
  ) {
    return null;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: record.sessionId,
    resumeToken: record.resumeToken,
    alias: record.alias,
    endpoint: { ip: endpoint.ip as string, port: endpoint.port as number },
    keepaliveIntervalS: record.keepaliveIntervalS,
    graceS: record.graceS,
    disconnectedAtMs,
  };
};

export const isResumeLeaseExpired = (lease: ResumeLease, nowMs: number): boolean =>
  lease.disconnectedAtMs !== null && nowMs - lease.disconnectedAtMs >= Math.trunc(lease.graceS * 1000);

export const newResumeLease = (fields: Omit<ResumeLease, "schemaVersion" | "disconnectedAtMs">): ResumeLease => ({
  schemaVersion: SCHEMA_VERSION,
  ...fields,
  disconnectedAtMs: null,
});
