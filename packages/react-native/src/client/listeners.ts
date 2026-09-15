import type {
  AppductListenerKind,
  AppductUnifiedListenerMap,
} from "../Appduct.types";
import { logger } from "../logger";

export type UnifiedListenerBus = {
  addListener<Kind extends AppductListenerKind>(
    kind: Kind,
    callback: AppductUnifiedListenerMap[Kind]
  ): { remove(): void };
  emit<Kind extends AppductListenerKind>(
    kind: Kind,
    event: Parameters<AppductUnifiedListenerMap[Kind]>[0]
  ): void;
};

/**
 * The single event bus behind `addAppductListener` (ARCHITECTURE.md §11): `stateChange`,
 * `sessionChange`, and `error` (bootstrap/connect/socket/tool-handler failures, one channel).
 */
export const createUnifiedListenerBus = (): UnifiedListenerBus => {
  const listeners: {
    [K in AppductListenerKind]: Set<AppductUnifiedListenerMap[K]>;
  } = {
    stateChange: new Set(),
    sessionChange: new Set(),
    error: new Set(),
  };

  return {
    addListener(kind, callback) {
      const set = listeners[kind] as Set<typeof callback>;
      set.add(callback);
      return {
        remove: () => {
          set.delete(callback);
        },
      };
    },

    emit(kind, event) {
      const set = listeners[kind] as Set<(event: unknown) => void>;
      for (const callback of set) {
        try {
          callback(event);
        } catch (error) {
          logger.warn(`Appduct "${kind}" listener threw`, error);
        }
      }
    },
  };
};
