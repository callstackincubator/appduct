import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { postEvent, registerEvent } from "@appduct/web";
import { useAppductTool } from "@appduct/web/react";
import { playgroundPingEvent, playgroundTools } from "./playground-tools";

function App() {
  const [callCount, setCallCount] = useState(0);
  const [lastPingAt, setLastPingAt] = useState<number | null>(null);
  const bump = () => setCallCount((count) => count + 1);

  useEffect(() => {
    const declaration = registerEvent(playgroundPingEvent);
    return () => declaration.remove();
  }, []);

  // The tools of the playground contract, docs/internal/playground-contract.md.
  const contract = playgroundTools({
    read: () => callCount,
    bump,
    reset: () => setCallCount(0),
  });
  useAppductTool(contract.sum);
  useAppductTool(contract.callCount);
  useAppductTool(contract.resetCounter);
  useAppductTool(contract.slowTask);
  useAppductTool(contract.throwingTool);

  const ping = async () => {
    const at = Date.now();
    await postEvent("playground_ping", { at });
    setLastPingAt(at);
  };

  return (
    <main>
      <h1>Appduct web playground</h1>
      <p id="count">Counted calls: {callCount}</p>
      <button id="ping" onClick={ping}>
        Send playground_ping
      </button>
      <p id="last-ping">{lastPingAt === null ? "No ping sent yet." : `Last ping at ${lastPingAt}`}</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
