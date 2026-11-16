import type { StaticStatus } from "../lib/types";
import { useConnectionCopy } from "./useConnectionCopy";

/**
 * 「复制 IP 替换命令」的全局入口（2026-10-17）。
 *
 * 背景：此前只有两处能拿到这条 sed——连接页的 IpChangedBanner（可被 × 关掉，
 * 关了无处可复制）和托盘菜单（发现性为零）。用户在终端页 SSH 到远端 AI 时，
 * 要复制命令还得切回连接页。生成逻辑已单一真源化到 Rust `network::ip_sed_for`
 * （`get_ip_sed_command` 命令），本 hook 是两个新入口（S3 全局横幅 / 命令面板）
 * 的共用消费侧：invoke 拿命令 → 写剪贴板 → toast 反馈。
 *
 * 成功走 toast（而非 useCopyFeedback 的按钮内联反馈）：这两个入口都是
 * 「点一下即走」的瞬时动作（横幅按钮无状态、面板执行后关闭），没有可驻留反馈的按钮面。
 *
 * 返回值：true = 命令已写入剪贴板；false = 无命令 / 复制失败 / 生成失败。
 * 失败路径已各自 toast，调用方只需对 true 做自己的反馈（如 AddressPicker 的
 * 按钮内联「已复制」），false 时不必也不能在按钮上谎报成功。
 */
export function useIpSedCopy(onCopied?: () => void, status?: StaticStatus) {
  const connectionCopy = useConnectionCopy(status);
  return async () => {
    const copied = await connectionCopy.copy("ip-update", "地址更新命令已复制，请在服务器执行后验证。");
    if (copied) onCopied?.();
    return copied;
  };
}
