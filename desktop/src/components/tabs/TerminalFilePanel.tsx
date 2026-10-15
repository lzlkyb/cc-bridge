import { SshFileBrowser } from "./SshFileBrowser";
import type { SshConnection } from "../../lib/types";

/**
 * 终端页的文件管理覆盖层：absolute inset-0 盖在整个终端大卡之上。
 * 从 TerminalTab 拆出（体量棘轮）：只吃渲染参数，连接/路径状态仍由
 * TerminalTab 持有——openSession / connect / newTerminal 都要在切会话时关掉它。
 */
export function TerminalFilePanel({
  conn,
  initialPath,
  onBack,
}: {
  conn: SshConnection;
  initialPath?: string;
  onBack: () => void;
}) {
  return (
    <div className="absolute inset-0 z-10 bg-card">
      {/* key 不能省：侧栏在文件面板打开时仍可点，直接换到另一条连接时
          组件不会重挂，path / entries 还是上一条的——而当前目录会被回写成
          「上次上传目录」，等于把 A 的目录存成了 B 的。 */}
      <SshFileBrowser
        key={`${conn.id}:${initialPath ?? ""}`}
        conn={conn}
        initialPath={initialPath}
        onBack={onBack}
      />
    </div>
  );
}
