import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./clawdSquad.css";

const SquadHost = createContext<HTMLDivElement | null | undefined>(undefined);

/** Keep the roster alongside both transcript and composer, without owning session state. */
export function CcConversationLayout({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return <SquadHost.Provider value={host}>
    <div className="cc-conversation-layout">
      {children}
      <div className="cc-squad-host" ref={setHost} />
    </div>
  </SquadHost.Provider>;
}

export function ClawdRosterSlot({ children }: { children: ReactNode }) {
  const host = useContext(SquadHost);
  // Standalone component fixtures can render the same roster without a layout provider.
  return host === undefined ? children : host ? createPortal(children, host) : null;
}
