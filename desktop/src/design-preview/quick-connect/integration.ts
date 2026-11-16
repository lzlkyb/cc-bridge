import { buildBaseCommand, buildConnectCommand, buildMultiDeviceCommand, quoteRemotePath, type McpScope } from "../../lib/utils";
export type ConnectionMethod = "stable" | "direct";
export interface SharedSetup {
  method: ConnectionMethod; scope: McpScope; path: string; ip: string; port: number; token: string; multiDevice: boolean;
}
/** Both connection methods use the existing command builders and the same scope/token state. */
export function sharedCommand(setup: SharedSetup): string {
  const host = setup.method === "stable" ? "127.0.0.1" : setup.ip;
  const command = setup.multiDevice
    ? buildMultiDeviceCommand(host, setup.port, setup.token, "http", false, "demo")
    : buildConnectCommand(buildBaseCommand(host, setup.port, setup.token, "http", false), setup.scope);
  return setup.scope === "project" && setup.path.trim() ? `cd ${quoteRemotePath(setup.path.trim())} && ${command}` : command;
}
export const setupKey = (scope: McpScope, path: string, token: string, multi: boolean) => JSON.stringify([scope, scope === "project" ? path.trim() : "", token, multi]);
