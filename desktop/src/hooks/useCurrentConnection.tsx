import { createContext, useContext, type ReactNode } from "react";
import { currentConnection, type ConnectionAccess } from "../lib/connectionAccess";
import type { StaticStatus } from "../lib/types";

const Context = createContext<ConnectionAccess | undefined>(undefined);
export function CurrentConnectionProvider({ access, children }: { access?: ConnectionAccess; children: ReactNode }) {
  return <Context.Provider value={access}>{children}</Context.Provider>;
}
export function useCurrentConnection(status?: StaticStatus) {
  return useContext(Context) ?? currentConnection(status);
}
