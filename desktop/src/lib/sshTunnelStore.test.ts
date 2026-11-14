import { beforeEach, expect, it, vi } from "vitest";
import type { SshConnection } from "./types";

vi.mock("./tauri", () => ({ invoke: vi.fn(async () => []), listen: vi.fn(async () => () => {}) }));
vi.mock("../components/ui/toast", () => ({ toast: vi.fn() }));

import { invoke } from "./tauri";
import { dismissForwardOffer, getForwardOffer, offerForward } from "./sshTunnelStore";

const rule = { id: "r", enabled: true, kind: "local", listenHost: "127.0.0.1", listenPort: 18080, targetHost: "127.0.0.1", targetPort: 22, note: "" } as const;
const conn = (extra: Partial<SshConnection> = {}) =>
  ({ id: "c", name: "测试机", host: "192.0.2.10", port: 22, username: "dev", authType: "password", forwards: [rule], ...extra }) as SshConnection;

beforeEach(() => {
  dismissForwardOffer();
  vi.mocked(invoke).mockClear();
});

it("默认询问：挂起询问并带上连接弹窗里的一次性密码，不直接开启", () => {
  offerForward(conn(), { password: "once" });
  expect(getForwardOffer()?.creds).toEqual({ password: "once" });
  expect(invoke).not.toHaveBeenCalled();
});

it("记住了自动开启：不询问，直接带着一次性密码开启", () => {
  offerForward(conn({ forwardAuto: "connect" }), { password: "once" });
  expect(getForwardOffer()).toBeNull();
  expect(invoke).toHaveBeenCalledWith("ssh_tunnel_start", { connectionId: "c", password: "once", passphrase: null });
});

it("记住了不开启、或没有启用的规则：什么都不做", () => {
  offerForward(conn({ forwardAuto: "off" }));
  offerForward(conn({ forwards: [{ ...rule, enabled: false }] }));
  expect(getForwardOffer()).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
});
