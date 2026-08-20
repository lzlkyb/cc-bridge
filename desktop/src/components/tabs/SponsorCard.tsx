/**
 * SponsorCard —— 「关于」页的赞助开发者入口。
 *
 * 移植自 pastepanda 项目的同款组件（commit 6ead67a），适配 cc-bridge：
 *  - 移除 lucide-react 依赖（cc-bridge 保持 3.4MB 安装包，用 ../ui/icon 内联 SVG）
 *  - 移除 createPortal（与 AboutGroup 现有 showModal 一致，fixed 原位渲染）
 *  - 颜色/背景使用 cc-bridge 主题 token（hsl(var(--xxx))）
 *  - 弹窗 z-index 1100 压过 settings 弹窗(z-1000)，仍低于 toast(z-2000)
 *  - 描述文案改为 CC Bridge
 *
 * ⚠️ 赞赏码图片：src/assets/sponsor/{wechat,alipay}.png
 *   覆盖同名文件即可生效。
 */
import { useEffect, useState } from "react";
import { Icon } from "../ui/icon";
import wechatQr from "../../assets/sponsor/wechat.png";
import alipayQr from "../../assets/sponsor/alipay.png";
import styles from "./SponsorCard.module.css";

type Channel = "wechat" | "alipay";

const CHANNELS: { key: Channel; label: string; icon: string; img: string; tip: string }[] = [
  { key: "wechat", label: "微信赞赏", icon: "💚", img: wechatQr, tip: "微信扫一扫" },
  { key: "alipay", label: "支付宝赞赏", icon: "💙", img: alipayQr, tip: "支付宝扫一扫" },
];

export function SponsorCard() {
  const [active, setActive] = useState<Channel | null>(null);
  const [imgErr, setImgErr] = useState(false);
  const chan = CHANNELS.find((c) => c.key === active) ?? null;

  // 弹窗内 Esc 关闭
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActive(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  return (
    <>
      <div className={styles.card}>
        <div className={styles.cardHead}>
          <span className={styles.cardIcon}>🧡</span>
          <span className={styles.cardTitle}>赞助开发者</span>
        </div>
        <p className={styles.cardDesc}>
          CC Bridge 完全免费开源，基于 Tauri 2 + Rust + MCP 协议构建。如果它对你有帮助，请我喝杯咖啡 —— 你的支持是我持续维护、修 Bug、加新功能的动力。
        </p>
        <div className={styles.cardBtns}>
          {CHANNELS.map((c) => (
            <button
              key={c.key}
              className={`${styles.cardBtn} ${styles[c.key]}`}
              onClick={() => {
                setImgErr(false);
                setActive(c.key);
              }}
            >
              <span className={styles.btnIcon}>{c.icon}</span>
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {active && chan && (
        <div className={styles.backdrop} onClick={() => setActive(null)}>
          <div
            className={styles.dialog}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label={chan.label}
          >
            <div className={styles.dialogHead}>
              <span>
                {chan.icon} {chan.label}
              </span>
              <button
                className={styles.closeBtn}
                onClick={() => setActive(null)}
                aria-label="关闭"
                type="button"
              >
                <Icon name="close" size={15} />
              </button>
            </div>
            <div className={styles.dialogBody}>
              <div className={styles.qrWrap}>
                {imgErr ? (
                  <div className={styles.qrErr}>
                    收款码图片缺失，请把截图放到 src/assets/sponsor/{chan.key}.png 后重试
                  </div>
                ) : (
                  <img
                    src={chan.img}
                    alt={chan.label}
                    className={styles.qr}
                    onError={() => setImgErr(true)}
                  />
                )}
              </div>
              <div className={styles.dialogTip}>{chan.tip}，支持一下开发者 🧡</div>
              <div className={styles.dialogFoot}>
                <button
                  className={styles.doneBtn}
                  onClick={() => setActive(null)}
                  type="button"
                >
                  谢谢支持
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
