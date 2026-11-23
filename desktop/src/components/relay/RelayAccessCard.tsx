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
}: {
  snapshot?: RelaySnapshot;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [switching, setSwitching] = useState(false);
  const [confirmDirect, setConfirmDirect] = useState(false);
  const port = snapshot?.port ?? 4100;
  const direct = !!snapshot && snapshot.listenHost !== "127.0.0.1";
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
      toast(next === "direct" ? "已切到内网直连：中转会绑到网卡上" : "已切回隧道模式：中转只绑回环", "success");
      onChanged();
    } catch (e) {
      toast(`切换失败：${String(e)}`, "error");
    } finally {
      setSwitching(false);
      setConfirmDirect(false);
    }
  };

  return (
    <section className="bento-card relay-access">
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
            onClick={() => void switchMode("tunnel")}
          >
            隧道连接<span className="rec">推荐</span>
          </button>
          <button
            type="button"
            aria-pressed={direct}
            disabled={switching}
            onClick={() => setConfirmDirect(true)}
          >
            IP 直连
          </button>
        </div>
      </div>

      <p className="relay-method-note">
        {direct
          ? "远端直接用内网地址访问本机，少一个会断的环节，但同网段可探测。"
          : "远端不用装任何东西，走已有的 SSH 会话把端口映射回来就行。"}
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
            先确保远端有一条到本机的 SSH 会话，把端口反向映射回去：
            <code>ssh -N -L {port}:127.0.0.1:{port} &lt;你的电脑&gt;</code>
          </span>
        </div>
      )}

      <pre className="relay-code">
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
          onClick={() =>
            void copyText(
              snippet,
              () => toast("整块已复制，粘到远端 shell 执行即可", "success"),
              () => toast("复制失败，请手动选中复制", "error"),
            )
          }
        >
          <Icon name="copy" size={13} />
          复制整块
        </button>
        <p className="note">
          自动写入远端走已连上的 SSH 会话（备份原文件、沿用原权限、幂等追加），排在下一步。
        </p>
      </div>

      {confirmDirect && (
        <ConfirmDialog
          title="切到内网直连？"
          description={
            <>
              中转会从 <code>127.0.0.1:{port}</code> 改绑到内网网卡，<b>同网段任何机器都能探测到这个端口</b>，
              令牌走明文 HTTP。监听地址变了，中转会重启一次，进行中的请求会断。
            </>
          }
          confirmLabel="切到直连"
          onCancel={() => setConfirmDirect(false)}
          onConfirm={() => void switchMode("direct")}
        />
      )}
    </section>
  );
}
