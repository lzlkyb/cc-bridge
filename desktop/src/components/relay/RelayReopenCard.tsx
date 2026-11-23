import { Icon } from "../ui/icon";

/**
 * 关闭态第 8 块：怎么开回来（全宽）。
 *
 * 关闭态**不退回一张居中占位卡**（§4.9.2）：配置卡仍然可编辑并标「待生效」，
 * 状态卡换灰渐变，指标一律 `—`。这一块只负责回答「我刚才关掉的东西怎么回来」，
 * 顺带写清关闭的代价，免得用户是为了试探而关掉它。
 */
export function RelayReopenCard() {
  return (
    <section className="bento-card relay-reopen">
      <div className="bento-eyebrow">
        <Icon name="info" size={12} />
        怎么开回来
      </div>
      <div className="relay-steps">
        <div>
          <b>最快</b>
          <span>点左边状态卡上那颗「重新打开中转」，配置、令牌、日志都沿用，不丢任何一条。</span>
        </div>
        <div>
          <b>也可以</b>
          <span>设置 › 网络与接入 › 启用模型中转，左侧会重新出现「中转」页。</span>
        </div>
        <div>
          <b>代价</b>
          <span>关闭期间远端那条 <code>claude-own</code> 会直接连不上，进行中的请求一起断。</span>
        </div>
      </div>
    </section>
  );
}
