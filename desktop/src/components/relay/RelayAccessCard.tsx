import { useState } from "react";
import { Icon } from "../ui/icon";
import { useToast } from "../ui/toast";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { copyText } from "../../lib/utils";
import { invoke } from "../../lib/tauri";
import { buildRelaySnippet } from "../../lib/relayFormat";
import type { RelaySaveResult, RelaySnapshot } from "../../lib/types";

/**
 * ⑤ 接入（全宽）。
 *
 * 两种模式（隧道 / 内网直连）产出**同一份 settings 文件**，差别只在 `BASE_URL` 那一行。
 * 所以这里是「分段切换 + 一块代码」，不是「两种方案并排两张卡」：并排会让人以为
 * 要选一套完全不同的做法。
 *
 * 🔴 切到直连时三处必须同时变：代码块里的地址、前置条件换成橙色警告、页头徽章转橙。
 * 只变一处会让人以为还在隧道里（§4.9.2）。页头徽章由 `RelayTab` 根据 listenHost 算，
 * 另两处在这里。
 *
 * 🔴 地址文案不写「仅本机可访问」：隧道模式下监听的确是回环，但远端经隧道照样能访问。
 * 正确说法是「不对内网暴露」——说的是暴露面，不是访问来源。
 */
export function RelayAccessCard({
  snapshot,
  onChanged,
  verified,
}: {
  snapshot?: RelaySnapshot;
  onChanged: () => void | Promise<unknown>;
  verified: boolean;
}) {
  const { toast } = useToast();
  const [switching, setSwitching] = useState(false);
  const [confirmMode, setConfirmMode] = useState<"tunnel" | "direct" | null>(null);
  const port = snapshot?.port ?? 4100;
  const direct = !!snapshot && snapshot.listenHost !== "127.0.0.1";
  const listening = snapshot?.running ?? false;
  const baseUrl = direct ? `http://${snapshot?.listenHost}:${port}` : `http://127.0.0.1:${port}`;
  const alias = snapshot?.tiers.find((t) => t.tier === "default")?.alias ?? "claude-sonnet-5-5";
  const snippet = buildRelaySnippet({
    baseUrl,
    token: snapshot?.token || "…",
    model: alias,
  });

  const switchMode = async (next: "tunnel" | "direct") => {
    if ((next === "direct") === direct || switching) return;
    setSwitching(true);
    try {
      const result = await invoke<RelaySaveResult>("relay_save", { patch: { listenMode: next } });
      for (const warning of result.warnings) toast(warning, "warning");
      if (!result.warnings.length) toast(next === "direct" ? "已切到内网直连" : "已切回 SSH 隧道", "success");
      await onChanged();
    } catch (e) {
      toast(`切换失败：${String(e)}`, "error");
    } finally {
      setSwitching(false);
      setConfirmMode(null);
    }
  };

  return (
    <section className="relay-access" aria-label="远端接入步骤">
      <div className="relay-inline relay-wrap relay-access-status">
        <span className="relay-work-badge" data-tone={!listening ? "mute" : verified ? "ok" : "accent"}>
          {!listening ? "已停止监听" : verified ? "已收到客户端成功请求" : "等待首个客户端成功请求"}
        </span>
        <small>{listening ? "在本页「最近请求」验证中转结果。" : "启动中转后再复制接入配置。"}</small>
      </div>
      <div className="relay-card-head">
        <div className="bento-eyebrow grow">
          <Icon name="plug" size={12} />
          在远端用起来
          <span className="relay-proto">ANTHROPIC</span>
        </div>
        <div className="relay-seg" role="group" aria-label="接入方式">
          <button
            type="button"
            aria-pressed={!direct}
            disabled={switching}
            onClick={() => { if (direct) setConfirmMode("tunnel"); }}
          >
            隧道连接<span className="rec">推荐</span>
          </button>
          <button
            type="button"
            aria-pressed={direct}
            disabled={switching}
            onClick={() => { if (!direct) setConfirmMode("direct"); }}
          >
            内网直连
          </button>
        </div>
      </div>

      <p className="relay-method-note">
        {direct
          ? "远端直接用内网地址访问本机，少一个会断的环节，但同网段可探测。"
          : "让远端 Claude Code 通过 SSH 访问本机中转。已有相同端口转发时可以直接复用。"}
      </p>

      {direct ? (
        <div className="relay-prereq" data-warn>
          <Icon name="alertTriangle" size={13} />
          <span>
            直连要把中转绑到网卡上，同网段可探测，token 走明文。本机防火墙需放行{" "}
            <code>{port}</code>，且 token 不能为空。
          </span>
        </div>
      ) : (
        <div className="relay-prereq">
          <Icon name="info" size={13} />
          <span>
            在本机运行以下命令，并保持 SSH 会话打开：
            <code>ssh -N -o ExitOnForwardFailure=yes -R 127.0.0.1:{port}:127.0.0.1:{port} &lt;远端 SSH 主机&gt;</code>
          </span>
        </div>
      )}

      <p className="relay-method-note">把下面的配置粘贴到远端 Shell，运行 <code>claude-own</code> 后发送一条请求。</p>
      <pre className="relay-code" tabIndex={0} aria-label="远端配置命令">
        {snippet.split("\n").map((line, i) => (
          // 行用 <span display:block> 而不是 <div>：<pre> 的内容模型是短语级内容，
          // 里面塞块级元素在严格校验下是不合法的，虽然浏览器都容忍。
          <span key={i} className={line.startsWith("#") ? "ln c" : "ln"}>
            {line || " "}
          </span>
        ))}
      </pre>

      <div className="relay-actions">
        <button
          type="button"
          className="ui-button primary"
          disabled={!listening || !snapshot?.token || switching}
          onClick={() =>
            void copyText(
              snippet,
              () => toast("整块已复制，粘到远端 shell 执行即可", "success"),
              () => toast("复制失败，请手动选中复制", "error"),
            )
          }
        >
          <Icon name="copy" size={13} />
          复制远端配置
        </button>
        <p className="note">配置含中转令牌，请仅复制到自己的客户端。</p>
      </div>

      {confirmMode && (
        <ConfirmDialog
          zIndex={1100}
          title={confirmMode === "direct" ? "切到内网直连？" : "切回 SSH 隧道？"}
          description={confirmMode === "direct" ? (
            <>
              中转会从 <code>127.0.0.1:{port}</code> 改绑到内网网卡，<b>同网段任何机器都能探测到这个端口</b>，
              令牌走明文 HTTP。监听地址变了，中转会重启一次，进行中的请求会断。
            </>
          ) : "切换监听地址会重启中转，进行中的请求可能中断。远端客户端需要改用 SSH 转发地址。"}
          confirmLabel={confirmMode === "direct" ? "切到直连" : "切回隧道"}
          onCancel={() => setConfirmMode(null)}
          onConfirm={() => void switchMode(confirmMode)}
        />
      )}
    </section>
  );
}
