import { CLIENT_SELFSIGNED } from "../../../lib/mcpClients";
import { CertPemStep, CopySegs } from "./widgets";

/**
 * 接入向导里的两条说明条，抽出来单独成文件：它们是纯展示块、没有状态，
 * 留在 ToolGuide 里只会让那个组件同时承担「工具选择 + 片段渲染 + 文案」三件事，
 * 很快就撞上 300 行体量门禁。
 */

/**
 * 隧道接入的端口由服务器按账号分配，配置完成前拿不到真值。
 * 这里不给占位地址，也不回退成本机服务端口——两者都会被当成真的抄走。
 */
export function PendingAddress() {
  return (
    <div className="space-y-1.5 rounded-lg border border-border bg-secondary/40 p-3">
      <p className="ui-h-sub">接入地址尚未确定</p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        隧道连接下，接入地址由服务器按账号分配端口后决定（同一台服务器上每人一个端口）。请先在
        「隧道连接」里完成一键接入，完成后这里会生成可直接粘贴的配置片段。
      </p>
    </div>
  );
}

/**
 * claude-code 的 HTTPS 附加说明（ConnectCommand 不感知 TLS，补在这里）。
 * 文案与信任步骤统一取自 CLIENT_SELFSIGNED["claude-code"]——不再走 buildClientSnippet 的 notes，
 * 免得同一件事在片段 note 与信任步骤里各说一遍。
 */
export function ClaudeTlsNote() {
  const sel = CLIENT_SELFSIGNED["claude-code"];
  return (
    <div className="space-y-2 rounded-lg border border-warning/30 bg-warning/8 p-3">
      <p className="text-xs leading-relaxed text-muted-foreground">
        <b className="text-warning-ink">HTTPS 自签</b>
        ：
        <CopySegs segs={sel.note} />
      </p>
      <CertPemStep compact steps={sel.steps} />
    </div>
  );
}
