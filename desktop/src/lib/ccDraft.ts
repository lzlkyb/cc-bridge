/**
 * 输入框草稿：打了一半、还没发出去的字。
 *
 * ## 为什么要落盘
 *
 * 对话页最贵的东西是「用户脑子里刚组织好的那句话」。此前它只活在一个
 * `useState` 里 —— 关窗口（省内存模式下 webview 直接销毁）、进程崩掉，
 * 全没了。而这句话可能是一整段需求描述或者贴进来的报错栈。
 *
 * ## 按什么维度存：前端 `paneKey`，不是会话 id
 *
 * 三条候选里只有它在重启前后**语义一致**：
 * - 后端内部 id（`cc_new_session` 铸发）：每次挂载重新铸，重启后必然不同；
 * - 库行号（`rowId`）：要等首轮结束落库才有，而草稿从第一秒起就要能写；
 * - `paneKey`（`p1` / `p2`…）：窗口内稳定，重启后第一条 pane 仍是 `p1`，
 *   而它恢复的正是「最近那条会话」—— 与用户最后在输入框里写字的地方吻合。
 *
 * ## 为什么需要 `pruneDrafts`
 *
 * 上一段那个吻合只在**单条会话**时严格成立。旧窗口里开过 p1/p2/p3，重启后
 * 只剩 p1：p2/p3 的草稿成了孤儿，而**新窗口后来新建的 p2 会读到旧窗口 p2 的字**
 * —— 那是别人的草稿，比丢掉更糟（用户会以为程序把两段话搞混了）。
 *
 * 所以窗口装配好 pane 列表时按「当前真实存在的 key」清一遍（`CcGuiTab` 侧在
 * `useCcPaneList` 挂载时调）。关掉一条 pane 时也立刻删（`close` 里）。
 *
 * ⚠️ 触发点只有**窗口启动**这一个：`CcGuiTab` 在 `App` 里是 `keepMounted` 的
 * （切去终端页再回来不卸载，见 `App.tsx` 的注释），所以挂载 effect 一个窗口
 * 生命周期只跑一次 —— 够用，因为 `seq` 也只在窗口启动时从 2 重来。
 *
 * ## 剩下的代价（刻意接受）
 *
 * 旧窗口里 p1 若**不是**「最近那条会话」（用户在 p2 聊完、又切回 p1 打了半句就
 * 关窗口），重启后 p1 恢复的是最近那条（p2 的会话），却会显示 p1 的草稿 —— 串一下。
 *
 * 要彻底消除得让草稿绑会话身份，而重启后唯一稳定的身份是库行号，它在首轮结束
 * 前根本不存在（新会话写不进去）。权衡下来选「串一下」而不是「丢字」：串的表现
 * 是输入框里多出一段**用户自己写的**话，删掉即可；丢字则无从找回。
 *
 * ## 存什么、不存什么
 *
 * 只存**文字**。图片（`CcImage` 是裸 base64，一张几 MB）不进 localStorage：
 * 那是同步 API，5MB 配额一次就爆，而且写的时候会卡住主线程。
 */

/** 键前缀。`prune` 靠它认出「这是草稿」而不是别人的偏好项。 */
const PREFIX = "ccbridge_composer_draft:";

/**
 * 单条草稿的长度上限（字符）。
 *
 * 超过就**不存**，而不是截断后存：截断会让用户重开时看到「我写的一段话少了
 * 后半截」，那比草稿没保住更难解释（看着像丢数据，实际是被我们动过）。
 * 20k 字符约等于把一整个源文件贴进输入框 —— 到那个量级本来也不该靠 localStorage。
 */
export const DRAFT_MAX = 20000;

function keyOf(pane: string): string {
  return PREFIX + pane;
}

/** 读这条 pane 的草稿。没存过 / 读失败一律返回空串。 */
export function readDraft(pane: string): string {
  try {
    return localStorage.getItem(keyOf(pane)) ?? "";
  } catch {
    // 隐私模式 / 配额满时 `getItem` 也可能抛。
    return "";
  }
}

/**
 * 写草稿。空串 = 删掉这条键（发送成功后走这里，不留一个空字符串占着配额）。
 */
export function writeDraft(pane: string, text: string): void {
  try {
    if (!text) {
      localStorage.removeItem(keyOf(pane));
      return;
    }
    if (text.length > DRAFT_MAX) return;
    localStorage.setItem(keyOf(pane), text);
  } catch {
    // 配额满只丢「跨重启记忆」，本窗口内的草稿还在组件 state 里，不打断输入。
  }
}

/** 删掉某条 pane 的草稿（关掉这条会话时）。 */
export function clearDraft(pane: string): void {
  try {
    localStorage.removeItem(keyOf(pane));
  } catch {
    // 同上：删不掉最坏是留一条孤儿键，下次 prune 会收。
  }
}

/**
 * 只保留 `keep` 里的 pane 的草稿，其余全删。
 *
 * 🔴 必须按**当前窗口真实存在的 key** 保留，而不是「最近写入的那条」：
 * 切回对话页时 `CcGuiTab` 会重新挂载（pane 列表重建为 `p1`），若按「最近写入」
 * 保留，就可能留下一条当前没有 pane 对应的草稿，而 `p1` 自己的草稿反被删掉。
 *
 * 幂等：同一个 keep 列表调多少次结果一样，`StrictMode` 双跑无副作用。
 */
export function pruneDrafts(keep: string[]): void {
  try {
    const alive = new Set(keep.map(keyOf));
    // 先收集再删：边遍历边 `removeItem` 会让索引错位（`length` 在缩短）。
    const dead: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX) && !alive.has(k)) dead.push(k);
    }
    for (const k of dead) localStorage.removeItem(k);
  } catch {
    // 清不掉只是留孤儿键，不影响本次输入。
  }
}
