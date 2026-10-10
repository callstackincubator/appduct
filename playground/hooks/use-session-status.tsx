import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  addAppductListener,
  getAppductState,
  type AppductClientState,
  type AppductSessionChangeEvent,
} from "@appduct/react-native";

type SessionStatus = {
  connectionState: AppductClientState;
  /** The current session's alias, `null` while there is none. */
  alias: string | null;
  lastSessionEvent: AppductSessionChangeEvent | null;
};

const SessionStatusContext = createContext<SessionStatus | null>(null);

/**
 * Follows the connection from app start, above the tabs. The Status screen mounts only when it is
 * first opened, so a link that arrives before that would otherwise leave it without the alias.
 */
export function SessionStatusProvider({ children }: { children: ReactNode }) {
  const [connectionState, setConnectionState] = useState<AppductClientState>(getAppductState());
  const [alias, setAlias] = useState<string | null>(null);
  const [lastSessionEvent, setLastSessionEvent] = useState<AppductSessionChangeEvent | null>(null);

  useEffect(() => {
    const state = addAppductListener("stateChange", (event) => setConnectionState(event.state));
    const session = addAppductListener("sessionChange", (event) => {
      setLastSessionEvent(event);
      setAlias(event.type === "lost" ? null : event.alias);
    });
    return () => {
      state.remove();
      session.remove();
    };
  }, []);

  return (
    <SessionStatusContext.Provider value={{ connectionState, alias, lastSessionEvent }}>
      {children}
    </SessionStatusContext.Provider>
  );
}

export function useSessionStatus(): SessionStatus {
  const status = useContext(SessionStatusContext);
  if (status === null) throw new Error("useSessionStatus needs a SessionStatusProvider");
  return status;
}
