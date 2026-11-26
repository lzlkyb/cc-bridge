import { sendTerminalUserInput } from "../lib/terminalUserInput";
import { useCallback, useEffect, useRef, useState } from "react";
import { readImage } from "@tauri-apps/plugin-clipboard-manager";
import { invoke } from "../lib/tauri";
import { quoteShellArgIfNeeded } from "../lib/terminalPaste";
import { toast } from "../components/ui/toast";

interface Args {
  sessionId: string;
  /** 连接 id：scp 上传命令（ssh_sftp_put）按连接寻址。 */
  connId: string;
  /** 会话已断开：直接报错而不是静默失败。 */
  closed: boolean;
}

/** 待确认的一张图片：编码已完成，但**一个字节都还没离开本机**。 */
export interface PendingImagePaste {
  /** 远端目标路径（含文件名），确认框里原样展示给用户。 */
  remote: string;
  width: number;
  height: number;
  /** 预览用 object URL；确认或取消时 revoke。 */
  url: string;
  bytes: Uint8Array;
}

/** 时间戳文件名：本地日期 + 时分秒 + 毫秒，肉眼可读且几乎不会撞名。 */
function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
}

/**
 * 剪贴板图片 → SFTP 上传远端 → 路径填进终端输入行（P1 ⑤，cc-bridge 差异化）。
 *
 * 痛点：Claude Code 在远端跑时，本地剪贴板里的截图物理上过不去（SSH 不转发图片），
 * 社区方案全是「本地 daemon + SSH 反向隧道 + 远端 shim」。我们把三件已有基建
 * 组合起来零新依赖：clipboard-manager 读图（RGBA）→ canvas 编码 PNG →
 * 临时文件（Rust `temp_file_write`）→ 现成 `ssh_sftp_put` 上传 → 路径插入输入行。
 *
 * WHY 路径插输入行而不自动回车：用户可能想配一句话（「看这张图哪里错了」），
 * 插入后回不回车、说什么，交给用户。
 *
 * 🔴 WHY 上传前必须确认（2026-11-26 交互审计 P1）：触发面有两条容易误碰的路——
 * `Ctrl+Shift+V` 在剪贴板无文本时会自动退化成传图，工具栏 image 按钮又紧挨着 paste。
 * 刚截了含敏感信息的图、想粘文本却按了这一下，图就已经在服务器上了，撤回不了。
 * 多行**文本**粘贴本来就有两段式确认（useTerminalPaste），更危险的图片不能反而没有。
 * 所以读图 + 编码之后停在 `pending`，落盘与上传都等用户点「上传」。
 */
export function useClipboardImagePaste({ sessionId, connId, closed }: Args) {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingImagePaste | null>(null);
  // ref 承接易变态：本回调挂进 window 键盘监听（只挂一次），闭包必须总读到最新值。
  const stateRef = useRef({ sessionId, connId, closed, busy: false });
  stateRef.current = { ...stateRef.current, sessionId, connId, closed };
  const pendingRef = useRef<PendingImagePaste | null>(null);
  pendingRef.current = pending;

  /** 收起确认框并释放预览与忙标记（取消 / 传完 / 失败共用）。 */
  const clearPending = useCallback(() => {
    const p = pendingRef.current;
    if (p) URL.revokeObjectURL(p.url);
    pendingRef.current = null;
    setPending(null);
    stateRef.current.busy = false;
    setBusy(false);
  }, []);

  const pasteImage = useCallback(async (remoteDir: string | null) => {
    const s = stateRef.current;
    if (s.busy) return; // 上一张还在传 / 确认框还开着：忽略连按，不弹窗打扰
    if (s.closed) {
      toast("连接已断开，无法发送图片", "error");
      return;
    }
    s.busy = true;
    setBusy(true);
    try {
      // 1. 读剪贴板图片（RGBA 像素）。文本/空剪贴板会抛错——正是「没有图片」的判定。
      const img = await readImage();
      // 数据拷进 JS 后立刻释放 rid；finally 保证 rgba/size 任一抛错也不泄漏原生资源。
      const [rgba, size] = await Promise.all([img.rgba(), img.size()] as const).finally(() =>
        void img.close(),
      );
      if (rgba.length === 0 || size.width === 0 || size.height === 0) {
        toast("剪贴板里没有图片", "error");
        clearPending();
        return;
      }
      // 2. RGBA → PNG：canvas 是 WebView 原生编码器，零依赖。img.dispose 释放 rid。
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        toast("图片编码失败：无法创建画布", "error");
        clearPending();
        return;
      }
      ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), size.width, size.height), 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) {
        toast("图片编码失败", "error");
        clearPending();
        return;
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      // 3. 目标路径（探不到 cwd 时 "."，scp 语义 = 远端 home）。文件名唯一，不做同名询问。
      const name = `clipboard-${stamp()}.png`;
      const base = (remoteDir ?? ".").replace(/\/+$/, "") || ".";
      const remote = base === "." ? name : `${base}/${name}`;
      // 4. 停在确认框：落盘 / 上传 / 插入路径都还没发生。
      const next = { remote, width: size.width, height: size.height, url: URL.createObjectURL(blob), bytes };
      pendingRef.current = next;
      setPending(next);
    } catch (e) {
      // readImage 对「剪贴板没有图片」的报错文案里带 image 关键字，翻译成友好提示。
      const msg = String(e);
      toast(/image|clip/i.test(msg) ? "剪贴板里没有图片" : `图片粘贴失败：${msg}`, "error");
      clearPending();
    }
  }, [clearPending]);

  /** 用户点了「上传」：这时才落临时文件、传远端、把路径插进输入行。 */
  const confirmUpload = useCallback(async () => {
    const p = pendingRef.current;
    const s = stateRef.current;
    if (!p) return;
    if (s.closed) {
      toast("连接已断开，无法发送图片", "error");
      clearPending();
      return;
    }
    try {
      // scp 只认本机路径。Vec<u8> 走 JSON 序列化，几 MB 可接受。
      const local = await invoke<string>("temp_file_write", {
        data: Array.from(p.bytes),
        ext: "png",
      });
      await invoke("ssh_sftp_put", {
        connectionId: s.connId,
        local,
        remote: p.remote,
        transferId: crypto.randomUUID(),
      });
      // 收尾：删中转文件（失败不阻塞），路径插入输入行（不带换行，回车交给用户）。
      // 路径按需加引号：cwd 带空格等字符时，裸路径会被远端 shell 切词。
      void invoke("temp_file_remove", { path: local }).catch(() => {});
      await sendTerminalUserInput(s.sessionId, quoteShellArgIfNeeded(p.remote));
      toast(`图片已上传到 ${p.remote}，路径已填入输入行`, "success");
    } catch (e) {
      toast(`图片上传失败：${String(e)}`, "error");
    } finally {
      clearPending();
    }
  }, [clearPending]);

  // 卸载时确认框还开着：预览的 object URL 不释放就泄漏到文档生命周期结束。
  useEffect(() => () => {
    if (pendingRef.current) URL.revokeObjectURL(pendingRef.current.url);
  }, []);

  return { busy, pending, pasteImage, confirmUpload, cancelUpload: clearPending };
}