import {
  clampToolTimeoutMs,
  isEventDescriptor,
  isToolDescriptor,
  type EventDescriptor,
  type ToolDescriptor,
} from "@appduct/shared";

const parseObject = (json: string, subject: string): unknown => {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new Error(`${subject} descriptor must be a JSON object.`);
  }
};

const describe = (value: unknown): string =>
  typeof value === "object" && value !== null && typeof (value as { name?: unknown }).name === "string"
    ? ` "${(value as { name: string }).name.slice(0, 64)}"`
    : "";

/** Only the fields PROTOCOL.md defines go on the wire; a stray key is dropped, as the Swift and
 * Kotlin cores do. */
const toWireTool = (descriptor: ToolDescriptor): ToolDescriptor => ({
  name: descriptor.name,
  description: descriptor.description,
  ...(descriptor.input_schema !== undefined ? { input_schema: descriptor.input_schema } : {}),
  ...(descriptor.output_schema !== undefined ? { output_schema: descriptor.output_schema } : {}),
  ...(descriptor.annotations !== undefined ? { annotations: descriptor.annotations } : {}),
  ...(descriptor.timeout_ms !== undefined ? { timeout_ms: clampToolTimeoutMs(descriptor.timeout_ms) } : {}),
  ...(descriptor.group !== undefined ? { group: descriptor.group } : {}),
});

const toWireEvent = (descriptor: EventDescriptor): EventDescriptor => ({
  name: descriptor.name,
  description: descriptor.description,
  ...(descriptor.payload_schema !== undefined ? { payload_schema: descriptor.payload_schema } : {}),
});

export type ToolRegistry = {
  /** Validates per PROTOCOL.md §5 and throws on a bad descriptor. Returns what goes on the wire. */
  upsert(json: string): ToolDescriptor;
  /** Whether `name` was registered. */
  remove(name: string): boolean;
  get(name: string): ToolDescriptor | undefined;
  /** In registration order; a re-registration keeps its place. */
  list(): ToolDescriptor[];
};

export const createToolRegistry = (): ToolRegistry => {
  const entries = new Map<string, ToolDescriptor>();
  return {
    upsert(json) {
      const value = parseObject(json, "Tool");
      if (!isToolDescriptor(value)) {
        throw new Error(`Tool${describe(value)} is not a valid tool descriptor (PROTOCOL.md section 5).`);
      }
      const wire = toWireTool(value);
      entries.set(wire.name, wire);
      return wire;
    },
    remove: (name) => entries.delete(name),
    get: (name) => entries.get(name),
    list: () => [...entries.values()],
  };
};

export type EventRegistry = {
  /** Validates per PROTOCOL.md §5a and throws on a bad descriptor. Returns what goes on the wire. */
  upsert(json: string): EventDescriptor;
  /** Whether `name` was declared. */
  remove(name: string): boolean;
  /** In declaration order; a re-declaration keeps its place. */
  list(): EventDescriptor[];
};

export const createEventRegistry = (): EventRegistry => {
  const entries = new Map<string, EventDescriptor>();
  return {
    upsert(json) {
      const value = parseObject(json, "Event");
      if (!isEventDescriptor(value)) {
        throw new Error(`Event${describe(value)} is not a valid event descriptor (PROTOCOL.md section 5a).`);
      }
      const wire = toWireEvent(value);
      entries.set(wire.name, wire);
      return wire;
    },
    remove: (name) => entries.delete(name),
    list: () => [...entries.values()],
  };
};
