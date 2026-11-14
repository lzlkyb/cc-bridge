import { useSyncExternalStore } from "react";
import { invoke, listen } from "./tauri";
import { toast } from "../components/ui/toast";
import type { SshOneTimeCredentials } from "./sshConnectionForm";
import type { ForwardRule, SshConnection, TunnelStatus } from "./types";

/**
 * 端口转发的前端状态（模块级）：各连接的运行状态、转发面板正对着哪条连接、待回答的「连接时一起转发」询问。
 *
 * WHY 不放 TerminalTab：入口（侧栏连接项）和面板（终端区覆盖层）不在同一棵子树，
 * 侧栏还是 portal 出去的；转发又比终端标签活得久（后台常驻），状态跟应用同寿正合适。
 */
export interface ForwardOffer {
  conn: SshConnection;
  /** 连接弹窗里填的一次性密码：顺带交给转发，免得再输一遍。只在询问挂起期间留在内存。 */
  creds?: SshOneTimeCredentials;
}

let statuses: ReadonlyMap<string, TunnelStatus> = new Map();
let panelConnId: string | null = null;
let offer: ForwardOffer | null = null;
const listeners = new Set<() => void>();
let started = false;

function notify() {
  for (const l of listeners) l();
}

function put(s: TunnelStatus) {
  const next = new Map(statuses);
  if (s.state === "stopped") next.delete(s.connectionId);
  else next.set(s.connectionId, s);
  statuses = next;
  notify();
}

/** 第一次有人订阅时拉全量、挂事件；之后全靠事件增量。 */
function ensureStarted() {
  if (started) return;
  started = true;
  listen<TunnelStatus>("ssh_tunnel_status", put).catch(() => {});
  void invoke<TunnelStatus[]>("ssh_tunnel_list")
    .then((list) => {
      // 拉全量期间先到的事件更新，不能被这份快照盖回去。
      for (const s of list) if (!statuses.has(s.connectionId)) put(s);
    })
    .catch(() => {});
}

function subscribe(l: () => void) {
  ensureStarted();
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useTunnelStatus(connId: string): TunnelStatus | undefined {
  return useSyncExternalStore(subscribe, () => statuses.get(connId));
}

export function useForwardPanelConnId(): string | null {
  return useSyncExternalStore(subscribe, () => panelConnId);
}

export function forwardPanelOpen(): boolean {
  return panelConnId !== null;
}

export function setForwardPanelConnId(id: string | null): void {
  if (panelConnId === id) return;
  panelConnId = id;
  notify();
}

export function getForwardOffer(): ForwardOffer | null {
  return offer;
}

export function usePendingForwardOffer(): ForwardOffer | null {
  return useSyncExternalStore(subscribe, getForwardOffer);
}

export function dismissForwardOffer(): void {
  if (!offer) return;
  offer = null;
  notify();
}

/** 开启（或按最新配置重启）转发。失败已 toast，返回 false。 */
export async function startTunnel(conn: SshConnection, creds?: SshOneTimeCredentials): Promise<boolean> {
  try {
    await invoke("ssh_tunnel_start", {
      connectionId: conn.id,
      password: creds?.password ?? null,
      passphrase: creds?.passphrase ?? null,
    });
    return true;
  } catch (e) {
    toast(`开启转发失败：${e}`, "error");
    return false;
  }
}

/**
 * 用户主动连上一台机器后调用：按连接的「连接终端时」偏好决定直接开、询问还是不管。
 * 重连 / 恢复会话 / 另开终端不走这里——那些不是「新发起一次连接」。
 */
export function offerForward(conn: SshConnection, creds?: SshOneTimeCredentials): void {
  const live = statuses.get(conn.id);
  if (!(conn.forwards ?? []).some((r) => r.enabled) || (live && live.state !== "error")) return;
  const mode = conn.forwardAuto ?? "ask";
  // launch 本该已经在跑；没在跑（启动时失败或被手动停了）就和 connect 一样顺手开启。
  if (mode === "connect" || mode === "launch") void startTunnel(conn, creds);
  else if (mode === "ask") {
    offer = { conn, creds };
    notify();
  }
}

/** 只比影响 ssh 参数的字段：改备注不算「待应用」。 */
export function sameForward(a: ForwardRule, b: ForwardRule): boolean {
  return (
    a.kind === b.kind &&
    a.listenHost === b.listenHost &&
    a.listenPort === b.listenPort &&
    (a.kind === "dynamic" || (a.targetHost === b.targetHost && a.targetPort === b.targetPort))
  );
}

/** 草稿里启用的规则是否就是正在跑的那组。 */
export function matchesRunning(draft: ForwardRule[], status: TunnelStatus): boolean {
  const on = draft.filter((r) => r.enabled);
  return (
    on.length === status.rules.length &&
    on.every((r, i) => status.rules[i].rule.id === r.id && sameForward(r, status.rules[i].rule))
  );
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/** 监听在非回环地址上：本机方向意味着局域网内其它机器也能经你的 SSH 通道进入。 */
export function exposesListen(r: ForwardRule): boolean {
  return !LOOPBACK.has(r.listenHost.trim());
}
