import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "../ui/icon";
import { Button } from "../ui/button";
import { useToast } from "../ui/toast";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { copyText } from "../../lib/utils";
import { invoke } from "../../lib/tauri";
import { buildRelaySnippet } from "../../lib/relayFormat";
import type { RelayLastDeploy, RelaySaveResult, RelaySnapshot } from "../../lib/types";
import { RelaySshAccess, useRelaySshAccess } from "./RelaySshAccess";
import { RelayDeploy, oneClickTunnel } from "./RelayDeploy";
import "../tabs/connect/stable-connect.css";

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
  const access = useRelaySshAccess(!direct && listening);
  const baseUrl = direct ? `http://${snapshot?.listenHost}:${port}`
    : access.port ? `http://127.0.0.1:${access.port}` : "";
  const alias = snapshot?.tiers.find((t) => t.tier === "default")?.alias ?? "claude-sonnet-5-5";
  const snippet = baseUrl ? buildRelaySnippet({
    baseUrl,
    token: snapshot?.token || "…",
    model: alias,
  }) : "";

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

  // P2：一键切隧道＝切模式＋建转发＋重新部署，落固定回环地址。目标连接取上次部署的那条。
  const lastDeploy = useQuery({
    queryKey: ["relayLastDeploy"],
    queryFn: () => invoke<RelayLastDeploy | null>("relay_last_deploy"),
    enabled: listening,
  });
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const tunnelConnId = lastDeploy.data?.connectionId ?? access.connection?.id;
  const goTunnel = async () => {
    if (!tunnelConnId || tunnelBusy || switching) return;
    setTunnelBusy(true);
    try {
      const r = await oneClickTunnel(tunnelConnId);
      toast(`已切隧道并部署，固定地址 ${r.baseUrl}，IP 变化不再影响。`, "success");
      await onChanged();
    } catch (e) {
      toast(`切隧道未完成：${String(e)}。可在上方手动建立转发后部署。`, "error");
    } finally {
      setTunnelBusy(false);
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
      </div>

      {/* P0：模式选择是决定地址稳不稳定的最关键选择，独立成「接入方式」全宽分段＋后果卡，
          置于代码块上方；不再埋进卡头标题行（复用本仓 stable-method 视觉范式）。 */}
      <div className="relay-method">
        <div className="stable-method-heading">
          <h3>接入方式</h3>
          <div className="stable-method-toggle" role="group" aria-label="接入方式">
            <button
              type="button"
              aria-pressed={!direct}
              disabled={switching}
              onClick={() => { if (direct) setConfirmMode("tunnel"); }}
            >
              隧道连接<span>推荐</span>
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
        <div className="relay-method-consequence">
          <div data-active={!direct ? "" : undefined}>
            <b>隧道连接</b>地址固定 127.0.0.1，经 SSH 转发，本机 IP 变了也不受影响。
          </div>
          <div data-active={direct ? "" : undefined}>
            <b>内网直连</b>少一跳更快，但用本机内网 IP。
            <span className="relay-guidance">IP 变了需重新部署；要稳定请用隧道。</span>
          </div>
        </div>
        {direct && (
          <Button size="sm" variant="outline" isLoading={tunnelBusy} loadingText="切隧道…"
            disabled={!tunnelConnId || switching} onClick={() => void goTunnel()}>
            切隧道（一键切换并重新部署）
          </Button>
        )}
      </div>

      <p className="relay-method-note">
        {direct
          ? "远端直接用内网地址访问本机，少一个会断的环节，但同网段可探测。"
          : "选择远端服务器和账号，CC Bridge 会自动建立 SSH 转发并分配空闲端口。"}
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
        <RelaySshAccess access={access} listening={listening} />
      )}
      {!direct && access.port > 0 && (
        <div className="relay-stable-note" role="status">
          <b>已隧道接入 · 固定地址</b>
          <span><code>http://127.0.0.1:{access.port}</code> 经 SSH 转发，本机 IP 变化不再影响远端，无需重新部署。</span>
        </div>
      )}

      <p className="relay-method-note">{direct
        ? <>把下面的配置粘贴到远端 Shell，运行 <code>claude-own</code> 后发送一条请求。</>
        : snippet
        ? <>把下面的配置粘贴到所选服务器的 Shell，运行 <code>claude-own</code> 后发送一条请求。</>
        : "SSH 转发就绪后即可生成远端配置。"}</p>
      {snippet && <pre className="relay-code" tabIndex={0} aria-label="远端配置命令">
        {snippet.split("\n").map((line, i) => (
          // 行用 <span display:block> 而不是 <div>：<pre> 的内容模型是短语级内容，
          // 里面塞块级元素在严格校验下是不合法的，虽然浏览器都容忍。
          <span key={i} className={line.startsWith("#") ? "ln c" : "ln"}>
            {line || " "}
          </span>
        ))}
      </pre>}

      <div className="relay-actions">
        <button
          type="button"
          className="ui-button primary"
          disabled={!listening || !snapshot?.token || switching || !snippet}
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

      <RelayDeploy
        listening={listening}
        baseUrl={baseUrl}
        token={snapshot?.token || ""}
        model={alias}
        defaultConnectionId={access.connection?.id}
      />

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
