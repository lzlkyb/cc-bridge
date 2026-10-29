/**
 * SSH 钩子注入回显治理（方案 A）：`stty -echo` 舞步时序 + 残渣常驻吞除。
 *
 * ## 背景
 *
 * 钩子注入（`useTerminalOsc`）是「往活 shell 里打字」，PTY 行规程 ECHO=on 会把
 * 注入内容回显到屏幕上——探针一行、400+ 字符钩子源码一行。根治要动后端建连方式
 * （exec 包装 / rcfile，见 docs/SSH钩子注入回显治理方案.md 方案 B/C），代价大且
 * 违背「不写远端文件」的产品承诺。本文件给出纯前端两段式治理：
 *
 * 1. **舞步时序**：t0 发**合并探针**（`stty -echo` + 报 shell 名，一条命令一个回执），
 *    拿到回执才发钩子，最后 `stty echo` 恢复。回显发生在行规程层（比 shell 读输入
 *    还早），与提示符时机无关——所以「掐时机注入」治不了本，只有开关 ECHO 治得了。
 * 2. **残渣常驻吞除**：关掉回显后，唯一会回显的只剩合并探针那一行。内容完全已知，
 *    用 `createEchoStripper` 在前端 write 路径上识别它，其余字节原样透传（fail-open）。
 *    擦除方式**分两种**（2026-10-28 方案 A）：token 后直接换行 ⇒ 那就是一整行命令
 *    回显，整行擦 `\r\x1b[2K`（连行首提示符一起）；token 后面还有可见字符 ⇒ 只是行中
 *    一段，退回等宽空格覆盖保列同步。
 *
 * ## 2026-10-28 第三次修复：时序不能靠猜
 *
 * 用户报「终端偶尔自己输入 echo，新建会话时尤其明显」。根因是**旧时序在猜**：
 * `ssh_connect` 是 spawn 即返回，而 t0 固定 900ms 就盲发 `stty -echo`、250ms 后盲发
 * 探针、回执后发 649 字符钩子——远端 ready 往往要 1~3s，于是这些字节全在 ECHO 仍是
 * on 时到达 tty 被整行回显。短命令能被剥除（有 token），钩子折成 7~9 行后**无 token
 * 可匹配**，明文整屏露出。同时 `claimInjection` 失败分支提前 return + cleanup 撤包装，
 * 让剥除器在 effect 重跑后永久丢失，残渣便在 resize 时「又自己输入一遍」。
 *
 * 两条修法都落在本文件：① 合并探针（`PROBE_ECHO_OFF_CMD`）用**回执**证明「shell 已
 * ready 且 ECHO 已关」，长命令永远排在它之后；② 剥除器改为**随终端实例常驻且幂等**
 * （`attachEchoStripWhenReady` 不再提供 end），与注入 effect 的生死彻底解耦。
 *
 * ## 2026-10-28 第四次修复：空格覆盖留下了「假提示符」
 *
 * 用户报「新建窗口出现两个 `lizuliang@code7:~$`」。第二个不是真 prompt，是探针回显行：
 * 空格覆盖只抹 token 所占的列，**token 之前已经渲染出去的提示符前缀原封不动**，于是
 * 那一行看起来就是个干净提示符（单测曾把这个形态当成期望值写死）。
 *
 * 修法见 `settleHit`：命中后先判行尾——紧跟换行就是整行回显，连前缀一起擦；否则维持
 * 空格覆盖。**不做无条件整行擦**，因为 10-13 实测过：行中 token 被整行擦会让本地光标
 * 回到行首而远端认为光标还在 token 末尾，列号错开，翻历史/退格重绘全部画歪。
 *
 * ## 2026-10-29 第五次修复：扣留吞掉了用户敲的 `s` / `p`
 *
 * 用户报「进入终端后输入 s、p 看不到，接着敲别的字母才一起出现」。
 * 根因是 `feed` 为了支持 token 跨 chunk 到达，会把「可能的前缀」扣在 `pending` 里等续接
 * 字节——而 `STRIP_TOKENS` 三条命令的首字母恰好是 `s`（`stty -echo …` / `stty echo`）
 * 和 `p`（`printf …`）。用户敲这两个字母时回显被当成探针开头**无限期扣住**，只有当下一
 * 个字节到来、失配后才连带吐出，所以看起来「先不显示、接着打才出现」。
 *
 * 修法：扣留必须有**时间上界**。剥除器新增 `idle()`（原样吐回扣留部分，不失效），
 * `attachEchoStrip` 在每次 write 后重置一个 40ms 的空闲定时器——拆包间隔是毫秒级，
 * 用户按键间隔远大于它，于是 token 仍能拼齐，而单字符输入最多等一帧就出现在屏幕上。
 * 教训：任何「为了跨包匹配而扣留字节」的过滤器，都必须有超时，否则它扣的就是用户
 * 看得见的输入。
 *
 * ## 2026-10-29 第六次修复：手打 `stty echo` 被擦 + pending 没有上界
 *
 * 穷举实测（95 个可打印字符 + 常见命令 + 不同连打间隔）确认字母层面已干净，但暴露两处：
 *
 * ① **手打/输出里的字面 token 被当残渣擦掉**。`stty echo` 是终端乱掉时的常用自救命令，
 *    而它恰好是 `ECHO_ON_CMD` 全文 ⇒ 回车后整行消失（命令照常执行，用户以为丢字）。
 *    剥离是纯内容匹配，注入残渣与用户手打的那一行字节完全相同，只能靠**时间关联**区分：
 *    残渣要么紧跟在我们自己发出的字节之后，要么由 ConPTY 重绘触发；用户手打的那行，
 *    其回显必然紧跟按键（≤ 一个 RTT）。见 `EchoStripOptions.userTypedRecently` /
 *    `USER_INPUT_WINDOW_MS`（阈值必须大于链路 RTT，否则高延迟链路上闸失效）。
 *    ⚠️ 反直觉：`stty -echo` **安全**（只是长 token 的前缀，遇 `\r` 失配即还原）。
 *
 * ② **`pending` 无长度上界**。远端若发出不终止的 OSC（`\x1b]…` 没有 BEL / ST），扣留会
 *    连同**后续所有输出**一起冻在 pending 里（整屏卡住 + 内存无界），且 `idle()` 不救
 *    （它只在 `k > 0` 分支交还）。修法是 `PENDING_MAX`：超界即 fail-open 原样交给 xterm，
 *    由它自己的解析器去等终止符，我们不再替它囤积。
 *
 * ## 为什么剥离器必须「常驻」整个会话（2026-10-13 二次修复）
 *
 * Windows 上 ssh 跑在 ConPTY（portable_pty）里：远端输出先被 ConPTY 渲染进
 * **它自己的屏幕缓冲区**再流给前端。前端剥离器擦掉的只是 xterm 的显示，
 * ConPTY 缓冲区里的残渣还在——之后任何整屏重绘（resize / 字号 / CC fullscreen
 * 进出）都会把缓冲区原样重发，残渣「时不时自己再输入一遍」（用户实测）。
 * 曾试过「restore 时趁 ECHO 还关着让远端 printf 清屏」把两边缓冲区一起清掉，
 * 用户不要清屏动作（连接后屏幕跳变），改为剥离器**常驻**：重发多少次就吞
 * 多少次，屏幕其余内容分毫不动。
 *
 * 误剥代价（可接受）：输出流里恰好出现字面 `stty -echo` / 探针 printf 原文时，
 * 整行回显（其后紧跟换行）会被整行擦掉，行中一段（其后还有可见字符）只覆盖那一段；
 * 两者都只碰输出路径，命令执行不受影响。正常工作内容几乎不含这两条字面量；
 * 确有顾虑时在设置里关掉注入开关。
 *
 * ## 红线：restore 绝不能发两次
 *
 * `stty echo` 是在 **echo 已关** 的情况下发的（所以它自身不被回显）；
 * 若 ECHO 已恢复又发第二句，那句就会被回显成一行可见残渣。恢复必须
 * 单次消费（`echoOffRef` 闸门，见 useTerminalOsc），四条异常路径共用同一个 restore。
 */

import type { Terminal } from "@xterm/xterm";

/** 舞步动作：先关回显再干活，干完恢复。 */
export const ECHO_OFF_CMD = "stty -echo";
export const ECHO_ON_CMD = "stty echo";

/**
 * **合并探针**：关回显 + 报 shell 名，一条命令一个回执（2026-10-28）。
 *
 * WHY 合并：旧时序在 t0 盲发 `stty -echo`、250ms 后盲发探针，全靠固定延时假设
 * 「远端 shell 已经在读了」。可 `ssh_connect` 是 spawn 即返回（`ssh_cmds.rs`），
 * 远端 TCP+认证+profile+MOTD 往往 1~3s ⇒ 两条命令都在 ECHO 仍是 on 时到达 tty 被
 * 整行回显；649 字符的钩子更惨——折成 7~9 行后没有任何 token 能匹配，明文整屏露出。
 * （回显发生在**字节进 tty 的那一刻**，由当时的 ECHO 状态决定，与 shell 何时执行无关。）
 *
 * 合并后语义变成：**回执到达 = shell 已 ready 且 ECHO 已关**，两个前提一次拿到；
 * 钩子必须等这个回执（`useTerminalOsc` 的 probeGoRef）——命令在 tty 队列里排多久都安全。
 *
 * ⚠️ 这一行自身必然被回显（ECHO 在它执行前仍是 on），必须进 STRIP_TOKENS；
 * 且因为它以 `stty -echo` 开头，剥除表里必须排在短命令之前。
 */
export const PROBE_ECHO_OFF_CMD = `stty -echo 2>/dev/null; printf '\\033]1337;Shell=%s\\007' "$0"`;

/**
 * **正常收尾**用的恢复命令：先把光标所在行擦掉，再恢复回显（2026-10-20 修「连接后两个 $」）。
 *
 * WHY 要擦这一行：`stty echo` 是最后一条注入命令，它执行完 bash 必然重画一次提示符。
 * 回显关闭期间 readline 不写换行，整场注入只攒下「登录提示符」那一行；一旦 ECHO 恢复，
 * 这个新提示符就落到下一行 ⇒ 用户看到「每次连接有两个提示符」。
 * 清行必须赶在 ECHO 仍关闭时发出（这行命令自己不被回显），并且**只擦当前行、不回退**：
 * 新提示符随后原地重画在同一行，屏幕只剩一个。
 *
 * 🔴 只用于正常收尾（kick 已发出、shell 正停在提示符上）。异常路径（探针超时 / 发送失败）
 * 屏幕状态未知，退回 ECHO_ON_CMD 不擦行。
 * 🔴 序列走**远端输出流**（不是本地 xterm 注入），ConPTY 处理的是同一份字节、两边不错位——
 * 与文件头注里「别用 `\r\x1b[2K` 去擦本地已渲染内容」的教训不冲突。
 */
export const ECHO_ON_CLEAN_CMD = "printf '\\r\\033[2K'; stty echo";

/**
 * 剥除器的 token 表（常驻整个会话）。
 *
 * 顺序即串行链顺序：**长 token 必须排前**——`PROBE_ECHO_OFF_CMD` 以 `stty -echo`
 * 开头、`ECHO_ON_CLEAN_CMD` 以 `stty echo` 结尾，短串先跑会把长命令的中段吞掉、
 * 把前后半截留在屏上。
 *
 * 不再收 `ECHO_OFF_CMD`：关回显已并入合并探针，单独留这一条反而会在折行时
 * 只吞掉开头 11 字符、把 `2>/dev/null; printf …` 的尾巴留在屏上。
 *
 * 钩子命令**刻意不收**：它 649 字符，必然被 PTY 按列宽折行，跨行无法匹配；
 * 正确做法是让它永远在 ECHO 关闭后才发（见 `PROBE_ECHO_OFF_CMD`），而不是事后擦。
 */
export const STRIP_TOKENS: readonly string[] = [
  PROBE_ECHO_OFF_CMD,
  ECHO_ON_CLEAN_CMD,
  ECHO_ON_CMD,
];

/** 舞步时序（毫秒）。t0 = 会话接线完成（等 banner / MOTD 走完再起舞）。 */
export const DANCE = {
  /** t0：发合并探针。不能再早——还要躲开首连的密码提示自动填充。 */
  PROBE_DELAY: 900,
  /** 探针回执 → 钩子。 */
  HOOK_DELAY: 60,
  /** 钩子 → kick 空回车（逼 shell 重绘一次提示符，触发 133;A）。 */
  KICK_DELAY: 150,
  /** kick → `stty echo`：舞步收尾，ECHO 恢复。 */
  RESTORE_DELAY: 250,
  /**
   * 探针发出后多久没回执就判「不是 bash/zsh，或 shell 迟迟不就绪」。
   * 命令可能在 tty 队列里等 ready，故给足 8s（旧值 1200ms 是按「固定延时后必已执行」
   * 的错误前提定的）；等待期间用户一敲键就走 onData 立刻 abort + 恢复 ECHO。
   */
  PROBE_TIMEOUT: 8000,
  /** 钩子发出后多久没等到 133;A 就降级（ECHO 此时已被 restore 恢复，这里只判死）。 */
  HOOK_TIMEOUT: 2000,
} as const;

/* ============================== 时序状态机 ============================== */

/**
 * 舞步阶段。中间四态表示「ECHO 可能处于关闭期」——任何路径从这四态退出
 * 都必须先恢复 ECHO（`danceNext` 用 restore 标志表达，调用方负责真正发送）。
 */
export type DancePhase =
  | "idle" // 尚未开始（还没发 stty -echo）
  | "echoOffSent" // stty -echo 已发出
  | "probeSent" // 探针已发出，等回执
  | "hookSent" // 钩子已发出
  | "kickSent" // kick 已发出，等 restore 收尾
  | "done" // stty echo 已发出，舞步正常结束
  | "aborted"; // 异常退出（ECHO 已恢复 + 判 unsupported）

export type DanceEvent =
  | "echoOffSent"
  | "probeSent"
  | "hookSent"
  | "kickSent"
  | "restoreSent"
  | "abort"; // 用户敲键 / 探针超时 / 钩子超时

/** 合法迁移表：只在「当前阶段精确匹配」时前进，乱序/重复事件一律原地不动（幂等）。 */
const TRANSITIONS: Array<[from: DancePhase, ev: DanceEvent, to: DancePhase]> = [
  ["idle", "echoOffSent", "echoOffSent"],
  ["echoOffSent", "probeSent", "probeSent"],
  ["probeSent", "hookSent", "hookSent"],
  ["hookSent", "kickSent", "kickSent"],
  ["kickSent", "restoreSent", "done"],
];

/**
 * 纯 reducer。返回新阶段 + 是否需要立即恢复 ECHO（restore 只是信号，
 * 真正的「只发一次」由调用方的 echoOffRef 闸门保证）。
 */
export function danceNext(
  phase: DancePhase,
  ev: DanceEvent,
): { phase: DancePhase; restore: boolean } {
  if (ev === "abort") {
    const active = phase !== "idle" && phase !== "done" && phase !== "aborted";
    return active ? { phase: "aborted", restore: true } : { phase, restore: false };
  }
  const hit = TRANSITIONS.find(([from, e]) => from === phase && e === ev);
  return hit ? { phase: hit[2], restore: false } : { phase, restore: false };
}

/* ============================== 残渣吞除 ============================== */

/**
 * 剥除目标由调用方给定（stty 舞步 = `stty -echo`；慢 shell 下探针行也会被
 * 回显，所以探针命令原文同样是一个 token），本模块不硬编码。
 *
 * **不要求换行结尾**——Windows 上本地 ssh 跑在 ConPTY 里（portable_pty），
 * ConPTY 会把输出流重新渲染：换行可能被改写成光标定位序列（`\x1b[3;1H`），
 * 转义序列也可能穿插在文本中间。字节级精确匹配在这个管道上必然漏网
 * （2026-10-13 实测）。
 */

/**
 * 从 s[i] 起解析一条 VT 转义序列。返回 null = 不是序列起点；
 * complete=false = 序列被 chunk 边界切断（len 是已见的长度）。
 * 只认三类：CSI（ESC [ 参数 final）、OSC（ESC ] … BEL 或 ESC \）、双字符转义。
 */
function vtSeqLen(s: string, i: number): { len: number; complete: boolean } | null {
  if (s[i] !== "\x1b") return null;
  const c = s[i + 1];
  if (c === undefined) return { len: 1, complete: false };
  if (c === "[") {
    let j = i + 2;
    while (j < s.length) {
      const code = s.charCodeAt(j);
      if (code >= 0x40 && code <= 0x7e) return { len: j + 1 - i, complete: true }; // final 字节
      j++;
    }
    return { len: s.length - i, complete: false };
  }
  if (c === "]") {
    // OSC：到 BEL 或 ST（ESC \）结束
    const bel = s.indexOf("\x07", i);
    const st = s.indexOf("\x1b\\", i);
    const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
    if (end === -1) return { len: s.length - i, complete: false };
    return { len: (end === bel ? bel + 1 : st + 2) - i, complete: true };
  }
  return { len: 2, complete: true };
}

export interface EchoStripper {
  /** 喂入一段输出，返回应当真正交给 xterm 渲染的部分。 */
  feed(chunk: string): string;
  /**
   * 空闲冲刷：把扣留的疑似前缀**原样吐出**（不失效）。
   *
   * 🔴 没有它就会吞掉用户看得见的字符（2026-10-29 报障：敲 `s` / `p` 屏幕没反应，
   * 接着敲下一个字母才一起出现）。因为 `feed` 为了支持 token 跨 chunk 到达，会把
   * 「可能的前缀」扣住——而 STRIP_TOKENS 里三条命令的首字母正是 `s`（`stty …`）和
   * `p`（`printf …`），用户每次敲这两个字母都被当成了探针开头扣在那里等。
   * 扣住**必须有时间上界**：调用方在输出流安静下来后调本方法，判定"这不是 token"。
   */
  idle(): string;
  /** 失效并交还扣留的尾部（调用方负责把它 write 出去，不丢数据）。 */
  flush(): string;
  /** flush 之前恒为 true：常驻语义，命中不再自动失效。 */
  readonly active: boolean;
}

/** 剥除器可选行为（2026-10-29 第六次修复）。 */
export interface EchoStripOptions {
  /**
   * 「这段输出更可能是用户自己敲的」——命中 token 时若返回 true，**原样透传不擦**。
   *
   * WHY：剥离是纯内容匹配，注入残渣与用户手打/程序打印出的同一串字面量在字节上
   * 完全无法区分。于是用户手打 `stty echo`（终端乱了时的常用自救命令）回车后整行被
   * 擦掉，`cat 脚本` 打出这行字面量也会被擦一行。
   * 区分依据只有**时间关联**：注入残渣要么紧跟在我们自己发出的字节之后出现，要么
   * 由 ConPTY 重绘触发；而用户手打的那一行，其回显必然紧跟用户按键（≤ 一个 RTT）。
   *
   * 阈值必须**大于链路 RTT**（远端 tty 回显，公网可达数百毫秒），否则高延迟链路上
   * 这道闸失效、回到误擦。代价是「重绘残渣恰好落在按键后 1s 内」会漏出来一次，
   * 下一次重绘（resize / 字号 / TUI 进出）会把它擦掉。
   *
   * 不传则由 `attachEchoStrip` 用**本终端实例的 onData** 自动提供；
   * 直接调 `createEchoStripper` 时不传 = 永远剥（测试与旧语义）。
   */
  userTypedRecently?: () => boolean;
}

/**
 * `pending` 扣留的长度上界。最长 token 约 70 字符，加上候选内部穿插的 VT 序列也远不到
 * 这个数；超过它必然是「不终止的 VT 序列」（见 feed 末尾的 fail-open 说明）。
 */
const PENDING_MAX = 1024;

/**
 * 残渣剥除器（常驻）：在 `term.write` 外面滚一个滑动窗口，识别 token 的
 * 回显行并抹掉（整行擦 / 空格覆盖，见 `settleHit`）；命中后复位继续扫——ConPTY 整屏重发多少次就吞多少次。
 *
 * ConPTY 容忍策略（fail-open 三原则不变）：
 * 1. 只识别内容完全已知的 token，其余字节原样透传；
 * 2. token 内部允许穿插 VT 序列（跳过、不进输出；失配时**如数归还**）；
 * 3. 候选区间之外的 VT 序列（颜色、光标定位……）原样透传——常驻模式下若
 *    吞掉它们，整场会话的渲染都会坏掉（一次性窗口时代无所谓，常驻后是红线）；
 * 4. 命中**先判行尾再决定擦法**（2026-10-28 方案 A）：
 *    · token 后直接换行 ⇒ 一整行命令回显，整行擦 `\r\x1b[2K`（连行首提示符一起，
 *      否则屏幕上多一个「提示符 + 一串空格」的假 prompt）。列差被随后的换行归零；
 *    · token 后还有可见字符 ⇒ 只是行中一段，用**等宽空格覆盖** token 所占的列，
 *      保住与 ConPTY 的列同步（10-13 实测：整行擦会让本地光标回行首、远端不动，
 *      翻历史与退格重绘全部画歪）；
 *    · token 内穿插过 VT 序列时列数不可信，一律整行擦。
 *    判定期的扣留只发生在「命中与后续字节之间」，且下个 chunk 立即见分晓；
 *    失配的内容全部原样吐回，绝不扣留数据。
 *
 * 误剥风险：输出流里恰好出现字面 token——正常工作内容几乎不含，见文件头注。
 */
export function createEchoStripper(token: string, opts: EchoStripOptions = {}): EchoStripper {
  let active = true;
  let pending = ""; // 疑似部分匹配的扣留（候选起点起的整段）
  let k = 0; // 已匹配 token 的前缀长度
  let matchStart = 0; // 当前候选匹配在 buf 中的起点（k>0 时有效）
  let vtInside = false; // 当前候选内是否跳过过 VT 序列（决定命中时的擦除策略）
  // ── 命中后的「行尾判定」状态（2026-10-28 方案 A）──
  // 命中时不立刻出结论：先看紧随的字节是换行还是可见字符。
  //   换行   ⇒ 这是**一整行命令回显**，连行首那截提示符一起擦——否则屏幕上会多出
  //            一个「提示符 + 一串空格」的假 prompt（2026-10-28 报障：新建窗口两个 $）。
  //   可见字符 ⇒ 只是行中的一段 token，必须退回空格覆盖保列同步（10-13 的错位教训）。
  let hitWait = false;
  let hitBuf = ""; // 判定期间暂存的字节（`\r` / VT 序列）
  let hitVt = false; // 命中的 token 内部是否穿插过 VT 序列（列数不可信 ⇒ 只能整行擦）
  /** 暂存上限：超了就按「行中 token」收尾，绝不让数据无限滞留。 */
  const HIT_TAIL_MAX = 16;

  /** 给命中收尾：whole=true 走整行擦，否则等宽空格覆盖。返回应当输出的字节。 */
  const settleHit = (whole: boolean): string => {
    const erase = whole || hitVt ? "\r\x1b[2K" : " ".repeat(token.length);
    const s = erase + hitBuf;
    hitWait = false;
    hitBuf = "";
    hitVt = false;
    return s;
  };

  return {
    get active() {
      return active;
    },
    feed(chunk: string): string {
      if (!active) return chunk;
      const buf = pending + chunk;
      pending = "";
      if (k > 0) matchStart = 0; // 上个 chunk 扣留的前缀拼到 buf 头部，候选从 0 重新起算
      let out = "";
      let i = 0;
      while (i < buf.length) {
        const ch = buf[i]!;
        // ── 命中后的行尾判定（优先于一切其它规则）──
        if (hitWait) {
          if (ch === "\n") {
            // 整行回显：擦掉整行（含行首提示符前缀），随后的换行照常放行。
            // 光标此时在行首、远端也认为该行已结束 ⇒ 列号天然对齐，不会重演 10-13 的错位。
            out += settleHit(true) + "\n";
            i++;
            continue;
          }
          if (ch === "\r") {
            hitBuf += ch; // 等下一个字节：`\n` ⇒ 换行；可见字符 ⇒ 行中 token
            i++;
            if (hitBuf.length > HIT_TAIL_MAX) out += settleHit(false);
            continue;
          }
          if (ch === "\x1b") {
            const vt = vtSeqLen(buf, i);
            if (vt) {
              if (!vt.complete) {
                // 序列被 chunk 边界切断：剩下的连判定状态一起留到下一段
                pending = buf.slice(i);
                break;
              }
              hitBuf += buf.slice(i, i + vt.len); // 序列不占列，不影响判定
              i += vt.len;
              if (hitBuf.length > HIT_TAIL_MAX) out += settleHit(false);
              continue;
            }
          }
          // 可见字符 ⇒ 不是整行回显，退回空格覆盖（保列同步）
          out += settleHit(false) + ch;
          i++;
          continue;
        }
        if (k > 0 && ch === token[k]) {
          i++;
          k++;
          if (k === token.length) {
            // 用户自己的输入（手打 `stty echo` / 程序打印出这行字面量）：不擦，原样交还
            // 整个候选区间。判据只能是时间关联，见 `EchoStripOptions.userTypedRecently`。
            if (opts.userTypedRecently?.()) {
              out += buf.slice(matchStart, i);
              k = 0;
              vtInside = false;
              continue;
            }
            // 命中 + 复位继续扫（常驻：ConPTY 重发多少次吞多少次）。
            // 🔴 这里**不立刻输出**：擦除方式取决于紧随的字节（见 settleHit）——
            // token 后面直接换行 = 一整行命令回显，要连行首提示符一起擦；否则只是
            // 行中的一段 token，退回空格覆盖保列同步。判定逻辑在循环顶的 hitWait 分支。
            hitWait = true;
            hitVt = vtInside;
            vtInside = false;
            k = 0;
          }
          continue;
        }
        if (ch === "\x1b") {
          const vt = vtSeqLen(buf, i);
          if (vt) {
            if (!vt.complete) {
              // 序列被 chunk 边界切断：从候选起点（或序列起点）扣住等下一段
              pending = buf.slice(k > 0 ? matchStart : i);
              if (k > 0) matchStart = 0;
              break;
            }
            if (k > 0) {
              vtInside = true; // token 内部的 VT 噪声：跳过（失配时由 slice 归还）
              i += vt.len;
              continue;
            }
            // 候选之外的转义序列：原样透传（常驻红线，见函数 doc 第 3 条）
            out += buf.slice(i, i + vt.len);
            i += vt.len;
            continue;
          }
        }
        // 失配：候选区间（前缀 + 中间跳过的 VT 序列）原样吐回
        if (k > 0) {
          out += buf.slice(matchStart, i);
          k = 0;
        }
        if (ch === token[0]) {
          matchStart = i;
          k = 1;
          vtInside = false;
          i++;
          continue;
        }
        out += ch;
        i++;
      }
      if (k > 0) pending = buf.slice(matchStart);
      // 🔴 扣留必须有**长度**上界（2026-10-29 第六次修复）：真正可能命中的候选最多
      // 「token 长度 + 若干穿插的 VT 序列」，远不到 PENDING_MAX。一旦超了，说明它是
      // 一条**不终止的 VT 序列**（远端发了 `\x1b]…` 却没有 BEL / ST），此时继续扣会让
      // 后续所有输出一起冻在 pending 里（整屏卡住 + 内存无界）。fail-open：原样交给
      // xterm 自己对付——它的解析器同样会等终止符，但我们不再替它囤积。
      if (pending.length > PENDING_MAX) {
        out += pending;
        pending = "";
        k = 0;
        vtInside = false;
      }
      return out;
    },
    idle(): string {
      if (!active) return "";
      let out = "";
      // 行尾判定悬着：本来就要「看见下一个字节才能定」，空闲即视为行中 token ⇒ 空格覆盖。
      if (hitWait) out += settleHit(false);
      if (k > 0) {
        // 扣着的前缀迟迟等不到续接字节 ⇒ 它不是 token，原样交还。
        out += pending;
        pending = "";
        k = 0;
        vtInside = false;
      }
      return out;
    },
    flush(): string {
      active = false;
      // 行尾判定还没定（会话结束 / 剥除器撤销）：退回空格覆盖，绝不丢字节。
      let out = hitWait ? settleHit(false) : "";
      out += pending;
      pending = "";
      k = 0;
      return out;
    },
  };
}

/**
 * 输出流安静多久算「这一批结束了」——到期把剥除器扣留的疑似前缀吐出去。
 *
 * 取值权衡（2026-10-29）：
 * - **不能太长**：用户敲 `s` / `p` 后屏幕上要等这么久才出现字符，超过 ~50ms 就能感觉到卡。
 * - **不能太短**：ConPTY 会把一次回显拆成多个 chunk 流过来（同一次 read 循环内的间隔
 *   通常只有几毫秒）。太短会在 token 拼齐之前就吐出前半截，探针回显漏到屏幕上。
 * 40ms 落在「人眼几乎无感」与「拆包必然更密」之间。
 */
const IDLE_FLUSH_MS = 40;

/**
 * 「按键之后多久之内的 token 命中，算用户自己的输入」。
 *
 * 🔴 必须**大于链路 RTT**：回显由远端 tty 产生，公网 / 跨机房可达数百毫秒；阈值定小了，
 * 高延迟链路上这道闸就失效，又退回「手打 `stty echo` 整行被擦」。
 * 越界代价：ConPTY 重绘残渣恰好落在按键后这个窗口内会漏出来一次，下一次重绘会擦掉。
 */
export const USER_INPUT_WINDOW_MS = 1000;

export interface EchoStripHandle {
  /** 撤掉 write 包装并交还扣留的尾部（幂等；end 后一切数据原样透传）。 */
  end(): void;
}

/**
 * 把 `term.write` 包一层**常驻**剥除链：tokens 里每个 token 一个剥除器串行
 * 过滤，命中处按行尾判定抹掉（整行擦 / 空格覆盖），其余字节原样透传。会话期间不撤包装（ConPTY 重发
 * 残渣的时刻不可预知——resize / 字号 / CC fullscreen 进出都可能触发），
 * 由调用方在会话销毁/重连时 `end()`。
 *
 * - 非字符串数据（Uint8Array，本项目当前不会出现，防御性保留）原样透传；
 * - 串行链保持输出顺序：前级扣留的尾部会在后续 chunk 到达时流经后级；
 * - end() 按链序 flush，扣留尾部不丢。
 */
export function attachEchoStrip(
  term: Terminal,
  tokens: readonly string[],
  opts: EchoStripOptions = {},
): EchoStripHandle {
  // 输入关联闸的默认来源：**本终端实例**自己的 onData（`InputEvent` 是 xterm 的公开事件）。
  // 放在这里而不是调用方，有两个理由：① 判据属于剥除器自己；② 每个终端一份时间戳，
  // 多标签之间不会互相「借」按键时间（否则 A 敲键会让 B 的残渣漏出来）。
  let lastInputAt = 0;
  const onData = typeof term.onData === "function" ? term.onData(() => (lastInputAt = Date.now())) : null;
  const userTypedRecently =
    opts.userTypedRecently ?? (() => Date.now() - lastInputAt < USER_INPUT_WINDOW_MS);
  const strippers = tokens.map((t) => createEchoStripper(t, { userTypedRecently }));
  const real = term.write.bind(term);
  let ended = false;
  // 空闲冲刷定时器：见 IDLE_FLUSH_MS 的说明。没有它，以 `s` / `p` 开头的用户输入会被
  // 当成 token 前缀扣住不显示（2026-10-29 报障）。
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const clearIdle = () => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const flushIdle = () => {
    idleTimer = null;
    if (ended) return;
    // 串行链：前级吐出的内容仍要过后级（顺序不能反，否则后级会看到未过滤的原始字节）。
    let tail = "";
    for (const s of strippers) tail = s.feed(tail) + s.idle();
    if (tail) real(tail);
  };
  const end = () => {
    if (ended) return;
    ended = true;
    clearIdle();
    onData?.dispose();
    term.write = real; // 撤包装（先撤再补写，扣留尾部走原始路径）
    let tail = "";
    for (const s of strippers) {
      tail = s.feed(tail) + s.flush(); // feed 出已定部分，flush 交还扣留的尾部
    }
    if (tail) real(tail);
  };
  term.write = (data, cb) => {
    if (typeof data !== "string") {
      real(data, cb);
      return;
    }
    let out = data;
    for (const s of strippers) out = s.feed(out);
    real(out, cb);
    // 每次写入都重置空闲窗口：连续到达的 chunk 之间不会触发（token 能拼齐），
    // 真正安静下来才把扣留的字符吐出去。
    clearIdle();
    idleTimer = setTimeout(flushIdle, IDLE_FLUSH_MS);
  };
  return { end };
}

/* ============================== 注入前置条件 ============================== */

/**
 * 注入的前提是「往一个停在提示符上的干净 shell 里打字」。屏幕已经是备用屏（全屏 TUI，
 * 如 Claude Code）时**绝不能注入**：那串字节会被 TUI 的输入行吃进去、原样显示出来
 * （2026-10-16 用户报障：「终端会在输入栏自己输入 `printf '\033]1337;…' "$0" stty -echo`」）。
 * 触发它的都不是新会话，而是注入 effect 重跑——那时 shell 里可能正跑着 TUI。
 */
export function tuiOnScreen(term: Terminal | null): boolean {
  return term?.buffer?.active?.type === "alternate";
}

/**
 * 注入台账。挂在 `globalThis` 上（**故意**不用模块级变量）：HMR 会重新求值本模块，
 * 模块级 Set 会被清掉，于是热更新一次就往活会话里重打一遍命令。
 *
 * 键是 sessionId——它按**连接**生成，重连自然拿到新键（那时确实该重新注入）。
 */
function ledger(): Set<string> {
  const g = globalThis as Record<string, unknown>;
  return (g.__ccbOscInjected ??= new Set<string>()) as Set<string>;
}

/** 认领本次会话的注入权：false = 本会话注入过（effect 重跑），调用方必须直接跳过。 */
export function claimInjection(sessionId: string): boolean {
  const set = ledger();
  if (set.has(sessionId)) return false;
  set.add(sessionId);
  return true;
}

export interface EchoStripCancel {
  /** 只取消「还没拿到 term」时的 rAF 重试；**不撤包装**（剥除器随终端实例常驻）。 */
  cancel(): void;
}

/**
 * 终端实例 → 是否已挂过剥除器。挂 `globalThis`（与 `claimInjection` 同理）：
 * HMR 会重新求值本模块，模块级 WeakSet 会被清掉，于是热更新一次就再包一层。
 */
function attachedLedger(): WeakSet<Terminal> {
  const g = globalThis as Record<string, unknown>;
  return (g.__ccbStripAttached ??= new WeakSet<Terminal>()) as WeakSet<Terminal>;
}

/**
 * 尽早挂上残渣剥除器，**幂等**，生命周期跟着**终端实例**而不是 effect。
 *
 * 终端的创建 effect 与注入的会话 effect 谁先跑不由本模块决定，而**漏挂的代价是整场
 * 会话残渣可见**——老写法 `term ? attachEchoStrip(term) : null` 在拿不到 term 时静默
 * 降级成一个空 handle，屏幕上的命令原文再没人擦。这里用 rAF 重试：termRef 一就绪就挂。
 *
 * 🔴 2026-10-28 起**不再提供 end()**：ConPTY 整屏重绘随时可能重发残渣，而 `useTerminalOsc`
 * 的会话 effect 会在 HMR / 重挂 / 换开关时重跑——旧实现在它的 cleanup 里撤包装，重跑后
 * 又因 `claimInjection` 返回 false 提前 return，于是**整场会话再没有剥除器**，残渣就在
 * resize / 字号 / TUI 进出时「又自己输入一遍」。挂在实例上并去重，这条路径彻底关死。
 */
export function attachEchoStripWhenReady(
  termRef: { current: Terminal | null },
  tokens: readonly string[] = STRIP_TOKENS,
  opts: EchoStripOptions = {},
): EchoStripCancel {
  let raf = 0;
  let cancelled = false;
  const tryAttach = () => {
    if (cancelled) return;
    const term = termRef.current;
    if (!term) {
      raf = requestAnimationFrame(tryAttach);
      return;
    }
    const seen = attachedLedger();
    if (seen.has(term)) return;
    seen.add(term);
    attachEchoStrip(term, tokens, opts);
  };
  tryAttach();
  return {
    cancel() {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
